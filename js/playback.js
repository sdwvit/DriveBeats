import { A, CHORDS, LOOKAHEAD, bass, env, hat, kick, lead, mtof, padChord, pluck } from './engine.js';
import { M } from './midi.js';
import { DS } from './motion.js';
import { MAX_SF_VOICES, SF, cachedZones, loadSamples, sfVoice } from './sf2.js';

  // ============================================================
  //  MIDI PLAYBACK — notes as written, layers gated by driving
  // ============================================================

  function snare(t, gain) {
    const len = Math.ceil(A.ac.sampleRate * 0.18);
    const buf = A.ac.createBuffer(1, len, A.ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random()*2-1) * (1 - i/len);
    const n = A.ac.createBufferSource(); n.buffer = buf;
    const bp = A.ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.7;
    const g = A.ac.createGain();
    env(g, t, 0.001, 0.18, gain);
    n.connect(bp); bp.connect(g); g.connect(A.drumBus);
    n.start(t); n.stop(t + 0.22);

    const o = A.ac.createOscillator(), og = A.ac.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(190, t);
    env(og, t, 0.001, 0.09, gain * 0.5);
    o.connect(og); og.connect(A.drumBus);
    o.start(t); o.stop(t + 0.12);
  }

  // Sustained voice for MIDI pad tracks — this is what survives at rest.
  function padNote(t, midi, dur, gain) {
    const g = A.ac.createGain(), f = A.ac.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 1.2;
    f.frequency.value = 400 + 1400 * (1 - A.rest);
    const osc = [];
    [-0.09, 0.09].forEach(det => {
      const o = A.ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(midi + det);
      o.connect(f); o.start(t); o.stop(t + dur + 1.2);
      osc.push(o);
    });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.35);
    g.gain.setValueAtTime(Math.max(0.0002, gain), t + Math.max(0.36, dur));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 1.0);
    f.connect(g); g.connect(A.panBus);
  }

  // General MIDI percussion map, reduced to the three voices we synthesize.
  function drumHit(midi, t, gain) {
    if (midi === 35 || midi === 36) kick(t, gain);
    else if (midi === 38 || midi === 40 || midi === 37) snare(t, gain * 0.8);
    else if (midi === 42 || midi === 44) hat(t, gain * 0.5, false);
    else if (midi === 46 || midi === 49 || midi === 51 || midi === 57) hat(t, gain * 0.45, true);
    else hat(t, gain * 0.35, false);
  }

  function playMidiNote(n, t) {
    const tr = M.tracks[n.trackIdx];
    if (!tr || tr.role === 'off') return;
    const rg = M.roleGain[tr.role] || 0;
    if (rg < 0.02) return;
    const vel = 0.35 + 0.65 * (n.vel / 127);
    const dur = n.dur * (60 / A.bpm / M.tpq);
    const attack = 0.04 - 0.038 * Math.min(1, DS.jerk / 12);

    // With a soundfont loaded the sample decides the timbre and the role only
    // decides how loud that layer is. Falling back to the synth voice for a
    // single note would be worse than dropping it, so an unplayable note is
    // only handed back when the font has no zone for it at all.
    if (SF.ready && sfNote(n, t, dur, rg)) return;

    switch (tr.role) {
      case 'drums': drumHit(n.midi, t, 0.85 * rg * vel); break;
      case 'bass':  bass(t, n.midi, Math.min(dur, 1.2), 0.30 * rg * vel, attack); break;
      case 'pad':   padNote(t, n.midi, Math.min(dur, 8), 0.055 * rg * vel); break;
      case 'keys':  pluck(t, n.midi, Math.min(dur, 0.9), 0.085 * rg * vel); break;
      case 'lead':  lead(t, n.midi, Math.min(dur, 4), 0.07 * rg * vel); break;
    }
  }

  // Bridge from a MIDI note to soundfont voices. A note is usually two zones
  // (stereo samples are a left and a right zone), so the voice cap is checked
  // per note, not per zone.
  const SF_GAIN = 0.22;

  function sfNote(n, t, dur, rg) {
    const zs = cachedZones(n.bank, n.prog, n.midi, n.vel);
    if (!zs.length) return false;
    if (SF.voices >= MAX_SF_VOICES) return true;   // drop, do not swap timbre
    const dest = (n.bank === 128 || n.ch === 9) ? A.drumBus : A.panBus;
    const amp = SF_GAIN * rg * Math.pow(n.vel / 127, 2);
    let any = false;
    for (const z of zs) {
      if (sfVoice(A.ac, z, n.midi, n.vel, t, dur, amp, dest)) any = true;
    }
    return any;
  }

  // The UI subscribes to soundfont progress rather than being called by name,
  // so loading can be driven from a test with no DOM present.
  function sfChanged() { if (SF.onChange) SF.onChange(); }

  // Load (or reload) exactly the samples the current MIDI file needs. Called
  // when either the font or the MIDI changes; roles do not affect it, because
  // pruning covers every track including the muted ones.
  async function sfSync() {
    if (!SF.file || !A.ac || SF.loading) return;
    if (!M.active || !M.tracks.length) {
      SF.ready = false;
      SF.status = 'Upload a MIDI file to use this soundfont.';
      sfChanged(); return;
    }
    SF.loading = true; SF.ready = false; SF.progress = 0;
    SF.status = 'Loading samples\u2026'; sfChanged();
    try {
      const r = await loadSamples(M.tracks, A.ac, sfChanged);
      SF.status = r.samples + ' samples \u00b7 ' +
                  (r.bytes / 1048576).toFixed(1) + ' MB in memory';
    } catch (e) {
      SF.ready = false;
      SF.status = 'Could not load samples: ' + (e && e.message ? e.message : e);
    }
    SF.loading = false; SF.progress = 1; sfChanged();
  }

  function sfReset() {
    // voices only ever comes down in an onended callback, and a context that
    // is discarded or closed never fires them. Two font swaps while playing
    // used to leave the count above MAX_SF_VOICES for good, after which every
    // note was dropped - and dropped as "handled", so not even the synth
    // fallback ran. The app went silent with nothing to show for it.
    SF.voices = 0;
    SF.file = null; SF.name = null; SF.ready = false; SF.loading = false;
    SF.presets = []; SF.instruments = []; SF.samples = [];
    SF.buffers.clear(); SF.zoneCache.clear(); SF.excl.clear();
    SF.bytes = 0; SF.progress = 0; SF.status = '';
  }

  // Slew towards the target tempo, +/-4 BPM per bar. Self-healing: a single
  // non-finite value would otherwise stick in A.bpm forever, because NaN
  // survives both the subtraction and the clamp.
  function slewBpm() {
    if (!isFinite(A.pendingBpm)) A.pendingBpm = 112;
    if (!isFinite(A.bpm)) { A.bpm = A.pendingBpm; return; }
    const d = A.pendingBpm - A.bpm;
    A.bpm += Math.max(-4, Math.min(4, d));
  }

  // At most this many notes per layer on any one tick. Per layer rather than
  // overall so a dense drum fill cannot push the bass line out.
  const MAX_PER_ROLE = 4;

  function thin(due) {
    if (due.length <= MAX_PER_ROLE) return due;
    const byRole = new Map();
    for (const n of due) {
      const tr = M.tracks[n.trackIdx];
      const r = tr ? tr.role : 'off';
      const a = byRole.get(r) || (byRole.set(r, []), byRole.get(r));
      a.push(n);
    }
    const keep = [];
    for (const [, a] of byRole) {
      if (a.length > MAX_PER_ROLE) a.sort((x, y) => y.vel - x.vel);
      for (let i = 0; i < Math.min(a.length, MAX_PER_ROLE); i++) keep.push(a[i]);
    }
    return keep;
  }

  function schedulerMidi() {
    const horizon = A.ac.currentTime + LOOKAHEAD;
    if (!M.curTime || M.curTime < A.ac.currentTime) M.curTime = A.ac.currentTime + 0.06;
    const bar = M.tpq * 4;
    const hasPad = M.tracks.some(t => t.role === 'pad');
    let guard = 0;

    while (M.curTime < horizon && guard++ < 20000) {
      // Everything landing on this tick is collected before any of it is
      // played, so the pile-up can be thinned. Descent's credits puts 19 notes
      // inside 50ms; with two or three oscillators each that is a wall the
      // limiter answers by ducking the whole mix, and the loudest note of the
      // chord is what the driver actually hears anyway.
      let due = null;
      while (M.idx < M.notes.length && M.notes[M.idx].start <= M.curTick) {
        (due || (due = [])).push(M.notes[M.idx]);
        M.idx++;
      }
      if (due) for (const n of thin(due)) playMidiNote(n, M.curTime);
      if (M.curTick % bar === 0) {
        slewBpm();
        A.feel = A.pendingFeel;
        // Without a pad track there would be nothing left at rest, so the
        // generated bed stands in.
        if (!hasPad && (M.curTick / bar) % 2 === 0) {
          const ci = Math.floor(M.curTick / bar / 2) % CHORDS.length;
          padChord(M.curTime, CHORDS[ci], (60 / A.bpm) * 8, 1 - A.rest);
        }
      }
      M.curTick++;
      M.curTime += 60 / A.bpm / M.tpq;
      if (M.curTick >= M.lengthTicks) { M.curTick = 0; M.idx = 0; }
    }
  }

  // Layer gating: this is where driving decides what you hear.
  //
  // Gating on acceleration alone would empty the mix on a motorway - at a
  // steady 120km/h the accelerometer reads nothing, so intensity decays and
  // the upper layers would drop out exactly when the drive feels fastest.
  // Sustained speed has to count as energy in its own right.
  // Speed ladder. Each breakpoint adds a layer, in mph because that is what the
  // driver reads off the dashboard. The 10 mph tier is deliberately a whole
  // song - pad, bass and drums - so that crawling through town is still worth
  // listening to; the tiers above it add colour rather than substance.
  const MPH = 0.44704;                 // mph -> m/s
  const TIERS = [
    { mph: 0,  roles: ['pad'] },
    { mph: 10, roles: ['pad', 'bass', 'drums'] },
    { mph: 20, roles: ['pad', 'bass', 'drums', 'keys'] },
    { mph: 30, roles: ['pad', 'bass', 'drums', 'keys', 'lead'] },
    { mph: 70, roles: ['pad', 'bass', 'drums', 'keys', 'lead'], full: true }
  ];
  // A layer is won at the breakpoint but not lost until 2 mph below it, so
  // hovering on a limit does not flicker the mix in and out.
  const TIER_HYST = 2;

  // GPS is the truth when we have it. Without it, sustained aggression stands
  // in - the accelerometer cannot see speed directly (SPEC 3.2.2b), so this is
  // the closest proxy available.
  function speedMph() {
    return (typeof DS.speed === 'number' && isFinite(DS.speed))
      ? DS.speed / MPH
      : DS.aggression * 70;
  }

  function tierFor(mph, from) {
    let t = from;
    while (t < TIERS.length - 1 && mph >= TIERS[t + 1].mph) t++;
    while (t > 0 && mph < TIERS[t].mph - TIER_HYST) t--;
    return t;
  }

  function updateRoleGains() {
    const mph = speedMph();
    A.tier = tierFor(mph, A.tier);
    const tier = TIERS[A.tier];
    const band = 1 - A.rest;
    const on = r => tier.roles.indexOf(r) >= 0 ? 1 : 0;
    const tgt = {
      // The pad never leaves: it is what carries a red light.
      pad:   1,
      bass:  on('bass') * band,
      // Half-feel thins the drums, except flat out, where everything is full.
      drums: on('drums') * band * (A.feel === 'half' && !tier.full ? 0.55 : 1),
      keys:  on('keys') * band,
      lead:  on('lead') * band
    };
    for (const k in tgt) M.roleGain[k] += (tgt[k] - M.roleGain[k]) * 0.08;
  }

export { MAX_PER_ROLE, SF_GAIN, TIERS, drumHit, padNote, playMidiNote, schedulerMidi, sfChanged, sfNote, sfReset, sfSync, slewBpm, snare, thin, updateRoleGains };
