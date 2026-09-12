import { A, applyMapping, initAudio, startAudio, toggleAudio } from './engine.js';
import { M, ROLES, ROLE_LABELS, loadParsed, parseMidi, rebuildNotes } from './midi.js';
import { clearMidi, deleteMidi, listMidi, loadMidiNamed, loadSavedMidi, resetStorage, saveMidi } from './midi-store.js';
import { CFG, DS, S, loadConfig, onFix, onMotion } from './motion.js';
import { sfReset, sfSync } from './playback.js';
import { SF, parseSf2 } from './sf2.js';
import { $, clamp, fmt } from './util.js';

  loadConfig();
  SF.onChange = () => renderSfUI();

  // ---------- start ----------
  $('startBtn').addEventListener('click', async () => {
    if (S.started) return;
    const err = $('startErr'); err.hidden = true;
    try {
      // Everything that needs the tap must be ASKED FOR BEFORE THE FIRST AWAIT.
      //
      // iOS counts a call as "in a user gesture" only while the handler is
      // still running synchronously. The moment it awaits, the gesture is
      // spent, and DeviceMotionEvent.requestPermission() then rejects with
      // "requires a user gesture" without ever showing the dialog - so the page
      // reports a permission problem that the driver is given no way to answer.
      //
      // This used to work by luck: the await above it only ran when the fresh
      // AudioContext came up suspended, which depends on the iOS version and on
      // whether audio had been unlocked already. When it came up running, the
      // await was skipped and the prompt appeared.
      //
      // So: construct the context, start both requests, and only then await.
      const AC = window.AudioContext || window.webkitAudioContext;
      initAudio(new AC());
      const unlock = A.ac.state === 'suspended' ? A.ac.resume() : Promise.resolve();
      const perm = (typeof DeviceMotionEvent !== 'undefined' &&
                    typeof DeviceMotionEvent.requestPermission === 'function')
        ? DeviceMotionEvent.requestPermission()
        : Promise.resolve('granted');

      await unlock;
      let st;
      try {
        st = await perm;
      } catch (pe) {
        // The gesture was lost, or the page is not in a context iOS will ask
        // from. Neither is something the driver can fix by tapping again.
        err.textContent = 'iOS would not show the motion permission prompt. ' +
          'Reload the page and tap Start as the first thing you do. If it keeps ' +
          'happening, switch on Settings \u203a Apps \u203a Safari \u203a Motion & Orientation Access.';
        err.hidden = false; return;
      }
      if (st !== 'granted') {
        err.textContent = 'Motion access denied. Reload and tap Start to retry, ' +
          'and check Settings \u203a Apps \u203a Safari \u203a Motion & Orientation Access is on.';
        err.hidden = false; return;
      }
      window.addEventListener('devicemotion', onMotion);
      startGeo();
      requestWakeLock();

      S.started = true; S.t0 = performance.now();
      $('start').hidden = true; $('main').hidden = false;
      updateSignLabel();

      const saved = await loadSavedMidi();
      if (saved) { lastBuf = saved; renderMidiUI(); }
      await renderMidiLib();
      renderSfUI();

      startAudio();
      renderTransport();
      setInterval(applyMapping, 100);
      setInterval(render, 80);

      setTimeout(() => { if (S.count === 0) $('noMotion').hidden = false; }, 1500);
      setTimeout(() => {
        if (A.ac.state !== 'running') {
          $('audioWarn').textContent =
            'Audio is not running (state: ' + A.ac.state + '). Check the silent switch, then tap the screen.';
          $('audioWarn').hidden = false;
        }
      }, 1200);
    } catch (e) {
      err.textContent = 'Could not start: ' + (e && e.message ? e.message : e) +
        (location.protocol !== 'https:' && location.hostname !== 'localhost'
          ? ' — this page is not on HTTPS, which iOS requires for motion access.' : '');
      err.hidden = false;
    }
  });

  // A tap anywhere recovers audio after a call or interruption.
  document.addEventListener('touchend', () => {
    if (A.ac && A.ac.state === 'suspended') A.ac.resume().then(() => { $('audioWarn').hidden = true; });
  });

  // ---------- GPS ----------
  // Metres between two fixes. Equirectangular rather than haversine: over the
  // tens of metres between consecutive fixes the difference is millimetres, and
  // this cannot go wrong at a pole we will never be driving past.
  const R = 6371000;
  function metres(a, b) {
    const la = a.latitude * Math.PI / 180, lb = b.latitude * Math.PI / 180;
    const x = (b.longitude - a.longitude) * Math.PI / 180 * Math.cos((la + lb) / 2);
    const y = lb - la;
    return Math.hypot(x, y) * R;
  }

  let lastFix = null;
  function startGeo() {
    if (!navigator.geolocation) { S.gps.status = 'unsupported'; return; }
    S.gps.status = 'acquiring';
    navigator.geolocation.watchPosition(
      p => {
        const c = p.coords, t = p.timestamp || Date.now();
        // coords.speed is documented as null when unknown, but real devices
        // also hand back NaN, and plenty of Android hardware never fills it in
        // at all - which used to leave the speed ladder with nothing to work
        // from for the whole drive. Where it is missing, the distance between
        // this fix and the last one says the same thing.
        let sp = c.speed;
        if (!(typeof sp === 'number' && isFinite(sp) && sp >= 0)) sp = null;
        if (sp === null && lastFix) {
          const dt = (t - lastFix.t) / 1000;
          // Under a third of a second is fix jitter, not travel; over ten and
          // we have been in a tunnel and cannot say what happened in between.
          if (dt > 0.3 && dt < 10) {
            const d = metres(lastFix.c, c);
            // A fix good to 20m cannot report a 3m crawl. Below its own
            // accuracy the distance is noise, and integrating noise reads as
            // motion while parked.
            if (d > Math.max(3, (c.accuracy || 0) * 0.5)) sp = d / dt;
            else sp = 0;
          }
        }
        let hd = c.heading;
        if (!(typeof hd === 'number' && isFinite(hd))) hd = null;
        onFix({ speed: sp, heading: hd, t });
        lastFix = { c: { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy }, t };
      },
      e => { S.gps.status='error'; },
      { enableHighAccuracy:true, maximumAge:1000, timeout:15000 });
  }

  // ---------- wake lock ----------
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.started) {
      requestWakeLock();
      if (A.ac && A.ac.state === 'suspended') A.ac.resume();
    }
  });

  // ---------- controls ----------
  $('vol').addEventListener('input', e => {
    if (A.master) A.master.gain.setTargetAtTime(e.target.value/125, A.ac.currentTime, 0.05);
  });
  // The axes are worked out from gravity and confirmed against GPS now, so
  // these are an override rather than the setting they used to be. The label
  // says whether one is in force, not which device axis is which.
  function updateSignLabel() {
    const f = CFG.signFwd < 0, l = CFG.signLat < 0;
    $('signState').textContent = (!f && !l)
      ? 'Axes found automatically — flip only if it feels backwards'
      : 'Overridden: ' + [f ? 'forward' : null, l ? 'lateral' : null].filter(Boolean).join(' and ') + ' reversed';
  }
  $('flipFwd').addEventListener('click', () => {
    CFG.signFwd *= -1; localStorage.setItem('db.signFwd', CFG.signFwd); updateSignLabel();
  });
  $('flipLat').addEventListener('click', () => {
    CFG.signLat *= -1; localStorage.setItem('db.signLat', CFG.signLat); updateSignLabel();
  });

  // ---------- transport ----------
  // One button, because it is pressed at a red light and read at a glance: it
  // says what the next tap does.
  function renderTransport() {
    const b = $('playPause');
    b.textContent = A.running ? 'Pause' : 'Play';
    b.setAttribute('aria-pressed', A.running ? 'true' : 'false');
  }
  $('playPause').addEventListener('click', () => { toggleAudio(); renderTransport(); });

  // ---------- MIDI UI ----------
  let lastBuf = null;

  // Muting duplicate parts is off unless the driver asked for it, and the
  // answer is remembered: it is a judgement about their own files, not
  // something to re-decide on every load.
  try { M.dedupe = localStorage.getItem('db.dedupe') === '1'; } catch (e) {}
  $('dedupe').checked = M.dedupe;
  $('dedupe').addEventListener('change', () => {
    M.dedupe = $('dedupe').checked;
    try { localStorage.setItem('db.dedupe', M.dedupe ? '1' : '0'); } catch (e) {}
    // rebuildNotes keeps the playhead, so this does not restart the song.
    rebuildNotes();
    renderMidiUI();
  });
  // null clears the line; a string shows it. Storage failures are not fatal -
  // the song plays either way - but they have to be visible, because the file
  // is gone on the next reload.
  function showMidiErr(msg) {
    const err = $('midiErr');
    err.textContent = msg || '';
    err.hidden = !msg;
  }
  $('midiPick').addEventListener('click', () => $('midiFile').click());
  $('midiFile').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const err = $('midiErr'); err.hidden = true;
    try {
      const buf = await file.arrayBuffer();
      loadParsed(parseMidi(buf), file.name);
      lastBuf = buf;
      const failed = await saveMidi(file.name, buf, M.tracks.map(t => t.role));
      renderMidiUI();
      await renderMidiLib();
      sfSync();                       // the needed sample set just changed
      showMidiErr(failed);
    } catch (ex) {
      err.textContent = ex.message || String(ex);
      err.hidden = false;
    }
    e.target.value = '';
  });
  $('midiClear').addEventListener('click', async () => {
    await clearMidi(); lastBuf = null; renderMidiUI(); await renderMidiLib(); sfSync();
  });

  // Files already uploaded, so a second one does not mean re-picking the first
  // from the phone's file browser every time.
  async function renderMidiLib() {
    const box = $('midiLib');
    const files = await listMidi();
    if (!files.length) { box.innerHTML = ''; return; }
    const esc = s => s.replace(/[<>&"]/g, c =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    box.innerHTML =
      '<p class="hint" style="margin:0 0 6px">Saved files</p>' +
      files.map(f => {
        const cur = M.active && M.name === f.name;
        return '<div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;' +
          'align-items:center;margin-bottom:6px">' +
          '<span style="font-size:.8rem;overflow:hidden;text-overflow:ellipsis;' +
          'white-space:nowrap' + (cur ? '' : ';color:var(--dim)') + '">' +
          (cur ? '▶ ' : '') + esc(f.name) +
          ' <span style="color:var(--dim)">(' + (f.bytes / 1024).toFixed(0) + ' kB)</span></span>' +
          '<button data-load="' + esc(f.name) + '"' + (cur ? ' disabled' : '') +
          ' style="font-size:.78rem;padding:6px 10px">' + (cur ? 'Playing' : 'Play') + '</button>' +
          '<button data-del="' + esc(f.name) + '" title="Remove"' +
          ' style="font-size:.78rem;padding:6px 10px">×</button></div>';
      }).join('');

    box.querySelectorAll('[data-load]').forEach(b => {
      b.addEventListener('click', async () => {
        const buf = await loadMidiNamed(b.dataset.load);
        if (buf) { lastBuf = buf; renderMidiUI(); await renderMidiLib(); sfSync(); }
      });
    });
    box.querySelectorAll('[data-del]').forEach(b => {
      b.addEventListener('click', async () => {
        const name = b.dataset.del;
        await deleteMidi(name);
        // Removing the file that is playing falls back to the generator.
        if (M.active && M.name === name) { await clearMidi(); lastBuf = null; renderMidiUI(); sfSync(); }
        await renderMidiLib();
      });
    });
  }

  // Two taps, because this throws away every uploaded file. The button relabels
  // itself instead of using confirm(), which is easy to mis-tap while driving
  // and blocks the audio thread on iOS.
  let resetArmed = 0;
  $('resetStore').addEventListener('click', async () => {
    const btn = $('resetStore');
    if (Date.now() - resetArmed > 4000) {
      resetArmed = Date.now();
      btn.textContent = 'Tap again to erase';
      setTimeout(() => { if (Date.now() - resetArmed >= 4000) btn.textContent = 'Reset storage'; }, 4000);
      return;
    }
    resetArmed = 0;
    btn.textContent = 'Reset storage';
    await resetStorage();
    try {
      localStorage.removeItem('db.signFwd');
      localStorage.removeItem('db.signLat');
    } catch (e) {}
    CFG.signFwd = 1; CFG.signLat = 1; updateSignLabel();
    sfReset(); $('sfErr').hidden = true; renderSfUI();
    await clearMidi(); lastBuf = null; renderMidiUI(); await renderMidiLib(); sfSync();
    $('resetDone').hidden = false;
    setTimeout(() => { $('resetDone').hidden = true; }, 3000);
  });

  // ---------- SoundFont UI ----------
  $('sfPick').addEventListener('click', () => $('sfFile').click());
  $('sfFile').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const err = $('sfErr'); err.hidden = true;
    try {
      sfReset();
      SF.loading = true; SF.name = file.name;
      SF.status = 'Reading preset directory\u2026'; renderSfUI();
      await parseSf2(file);
      SF.loading = false;
      await sfSync();
    } catch (ex) {
      sfReset();
      err.textContent = ex.message || String(ex);
      err.hidden = false;
      renderSfUI();
    }
    e.target.value = '';
  });
  $('sfClear').addEventListener('click', () => {
    sfReset(); $('sfErr').hidden = true; renderSfUI();
  });

  function renderSfUI() {
    $('sfName').textContent = SF.name || 'Built-in synth voices';
    $('sfStatus').textContent = SF.status || '';
    $('sfProgWrap').hidden = !SF.loading;
    $('sfProg').style.width = (SF.progress * 100).toFixed(0) + '%';
    $('sfPick').disabled = SF.loading;
    $('sfClear').disabled = SF.loading;
  }

  function renderMidiUI() {
    $('midiName').textContent = M.active ? M.name : 'Built-in generator';
    const box = $('midiTracks');
    const dups = M.active ? M.tracks.filter(t => t.dupOf != null).length : 0;
    // The checkbox only appears where it would do something; on a file with no
    // copies in it, it is a control that does nothing and reads as broken.
    $('dedupeRow').style.display = dups ? 'flex' : 'none';
    $('dedupeCount').textContent = dups
      ? '(' + dups + ' found — same notes as an earlier part)' : '';
    if (!M.active) { box.innerHTML = ''; return; }
    box.innerHTML = M.tracks.map((t, i) => {
      // A muted duplicate still shows its layer: the driver can see what it
      // would play, and unticking the box brings it straight back.
      const off = M.dedupe && t.dupOf != null;
      return '<div style="display:grid;grid-template-columns:1fr 168px;gap:8px;align-items:center;margin-bottom:6px' +
      (off ? ';opacity:.45' : '') + '">' +
      '<span style="font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      t.name.replace(/[<>&]/g, '') + ' <span style="color:var(--dim)">(' + t.notes.length +
      (off ? ', copy of ' + (t.dupOf + 1) : '') + ')</span></span>' +
      '<select data-t="' + i + '" style="font:inherit;font-size:.78rem;background:var(--panel-2);' +
      'color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px">' +
      ROLES.map(r => '<option value="' + r + '"' + (t.role === r ? ' selected' : '') + '>' +
        ROLE_LABELS[r] + '</option>').join('') +
      '</select></div>';
    }).join('');
    // Which song these controls describe. Loading a file is asynchronous, so a
    // dropdown left open across a load would otherwise apply its role to the
    // track that now sits at that index in a different song.
    const gen = M.gen;
    box.querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', async () => {
        if (M.gen !== gen) return;
        const tr = M.tracks[+sel.dataset.t];
        if (!tr) return;
        tr.role = sel.value;
        rebuildNotes();
        if (lastBuf) showMidiErr(await saveMidi(M.name, lastBuf, M.tracks.map(t => t.role)));
      });
    });
  }

  // ---------- render ----------
  function render() {
    renderTransport();
    $('n-feel').textContent = DS.stationary ? 'at rest' : A.feel;
    $('n-meta').textContent =
      Math.round(A.bpm) + ' bpm · ' + (M.active ? 'midi' : A.scale) +
      (DS.brake > 0.15 ? ' · braking' : DS.accel > 0.15 ? ' · pulling' : '');
    $('n-meter').style.width = (DS.intensity*100).toFixed(0) + '%';

    const pairs = [['l', DS.aLong], ['t', DS.aLat]];
    for (const [k,v] of pairs) {
      $('val-'+k).textContent = fmt(v);
      $('val-'+k).className = 'val ' + (v>0.4?'pos':v<-0.4?'neg':'');
      const fill = $('bar-'+k).querySelector('.fill');
      const frac = clamp(v/8,-1,1), pct = Math.abs(frac)*50;
      fill.style.width = pct + '%';
      fill.style.left = frac>=0 ? '50%' : (50-pct) + '%';
      fill.style.background = frac>=0 ? 'var(--pos)' : 'var(--neg)';
    }

    $('d-int').textContent  = fmt(DS.intensity);
    $('d-agg').textContent  = fmt(DS.aggression);
    $('d-spd').textContent  = DS.speed==null ? '— (' + S.gps.status + ')'
                              : fmt(DS.speed*3.6,0) + ' km/h' +
                                (DS.speedSrc === 'dead' ? ' (estimated)' : '');
    // Which way the car thinks forward is, and whether GPS has confirmed it.
    $('d-calib').textContent = {
      device:   'device axes (no gravity reading)',
      assumed:  'from the mount, forward assumed',
      learned:  'forward confirmed by GPS'
    }[DS.calib] || DS.calib;
    $('d-stat').textContent = DS.stationary ? 'yes' : 'no';
    $('d-rate').textContent = S.rate ? fmt(S.rate,0)+' Hz' : '—';

    if (S.gravInit) {
      const g = S.grav, deg = r => r*180/Math.PI;
      const pitch = deg(Math.atan2(g.y, Math.abs(g.z)));
      const roll  = deg(Math.atan2(g.x, Math.abs(g.z)));
      $('d-tilt').textContent = fmt(Math.abs(pitch),0)+'° / '+fmt(roll,0)+'°';
      const abs = {x:Math.abs(g.x),y:Math.abs(g.y),z:Math.abs(g.z)};
      const dom = abs.z>=abs.x && abs.z>=abs.y ? 'z' : abs.y>=abs.x ? 'y' : 'x';
      const bad = [];
      if (dom !== 'z') bad.push('phone is not lying flat');
      if (Math.abs(roll) > 15) bad.push('rolled ' + fmt(roll,0) + '° to one side');
      const mw = $('mountWarn');
      if (bad.length) { mw.textContent = 'Mount: ' + bad.join('; ') + '. Forward axis may be wrong.'; mw.hidden = false; }
      else mw.hidden = true;
    }
  }
export { lastBuf, render, renderMidiUI, renderSfUI, requestWakeLock, startGeo, updateSignLabel, wakeLock };
