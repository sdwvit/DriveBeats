import { A, applyMapping, initAudio, startAudio } from './engine.js';
import { M, ROLES, loadParsed, parseMidi, rebuildNotes } from './midi.js';
import { clearMidi, loadSavedMidi, saveMidi } from './midi-store.js';
import { CFG, DS, S, loadConfig, onMotion } from './motion.js';
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
      // Audio must be created inside the gesture on iOS — do it first, so a
      // motion-permission denial cannot cost us the unlock.
      const AC = window.AudioContext || window.webkitAudioContext;
      initAudio(new AC());
      if (A.ac.state === 'suspended') await A.ac.resume();

      if (typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function') {
        const st = await DeviceMotionEvent.requestPermission();
        if (st !== 'granted') {
          err.textContent = 'Motion access denied. Reload and tap Start to retry.';
          err.hidden = false; return;
        }
      }
      window.addEventListener('devicemotion', onMotion);
      startGeo();
      requestWakeLock();

      S.started = true; S.t0 = performance.now();
      $('start').hidden = true; $('main').hidden = false;
      updateSignLabel();

      const saved = await loadSavedMidi();
      if (saved) { lastBuf = saved; renderMidiUI(); }
      renderSfUI();

      startAudio();
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
  function startGeo() {
    if (!navigator.geolocation) { S.gps.status = 'unsupported'; return; }
    S.gps.status = 'acquiring';
    navigator.geolocation.watchPosition(
      // coords.speed is documented as null when unknown, but real devices also
      // hand back NaN. NaN survives every later arithmetic step and ends up in
      // A.bpm, which poisons every note duration, so reject it at the door.
      p => { S.gps.status='ok';
             const sp = p.coords.speed;
             S.gps.speed = (typeof sp === 'number' && isFinite(sp) && sp >= 0) ? sp : null; },
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
  function updateSignLabel() {
    $('signState').textContent =
      'forward = ' + (CFG.signFwd>0?'+':'-') + 'y, lateral = ' + (CFG.signLat>0?'+':'-') + 'x';
  }
  $('flipFwd').addEventListener('click', () => {
    CFG.signFwd *= -1; localStorage.setItem('db.signFwd', CFG.signFwd); updateSignLabel();
  });
  $('flipLat').addEventListener('click', () => {
    CFG.signLat *= -1; localStorage.setItem('db.signLat', CFG.signLat); updateSignLabel();
  });

  // ---------- MIDI UI ----------
  let lastBuf = null;
  $('midiPick').addEventListener('click', () => $('midiFile').click());
  $('midiFile').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const err = $('midiErr'); err.hidden = true;
    try {
      const buf = await file.arrayBuffer();
      loadParsed(parseMidi(buf), file.name);
      lastBuf = buf;
      await saveMidi(file.name, buf, M.tracks.map(t => t.role));
      renderMidiUI();
      sfSync();                       // the needed sample set just changed
    } catch (ex) {
      err.textContent = ex.message || String(ex);
      err.hidden = false;
    }
    e.target.value = '';
  });
  $('midiClear').addEventListener('click', async () => {
    await clearMidi(); lastBuf = null; renderMidiUI(); sfSync();
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
    if (!M.active) { box.innerHTML = ''; return; }
    box.innerHTML = M.tracks.map((t, i) =>
      '<div style="display:grid;grid-template-columns:1fr 96px;gap:8px;align-items:center;margin-bottom:6px">' +
      '<span style="font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      t.name.replace(/[<>&]/g, '') + ' <span style="color:var(--dim)">(' + t.notes.length + ')</span></span>' +
      '<select data-t="' + i + '" style="font:inherit;font-size:.78rem;background:var(--panel-2);' +
      'color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px">' +
      ROLES.map(r => '<option value="' + r + '"' + (t.role === r ? ' selected' : '') + '>' + r + '</option>').join('') +
      '</select></div>').join('');
    box.querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', async () => {
        M.tracks[+sel.dataset.t].role = sel.value;
        rebuildNotes();
        if (lastBuf) await saveMidi(M.name, lastBuf, M.tracks.map(t => t.role));
      });
    });
  }

  // ---------- render ----------
  function render() {
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
                              : fmt(DS.speed*3.6,0) + ' km/h';
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
