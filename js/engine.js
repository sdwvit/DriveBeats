import { M } from './midi.js';
import { DS } from './motion.js';
import { schedulerMidi, slewBpm, updateRoleGains } from './playback.js';

  // ============================================================
  //  AUDIO ENGINE (M4) — generative driving techno
  // ============================================================
  const A = {
    ac: null, master: null, lp: null, comp: null, limiter: null,
    panBus: null, drumBus: null,
    running: false,
    bpm: 112, pendingBpm: 112,
    spd: 0, energy: 0,
    step: 0,                 // 0..127  (8 bars of 16ths)
    nextTime: 0,
    timer: null,
    feel: 'straight',        // half | straight | double
    pendingFeel: 'straight',
    scale: 'minor',
    rest: 1,                 // 1 = full rest (pad only), 0 = full band
    restTarget: 1
  };

  const LOOKAHEAD = 0.1;     // s of future to schedule
  const TICK = 25;           // ms between scheduler wakeups
  const ROOT = 57;           // A3

  const SCALES = {
    minor:      [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 3, 5, 7, 10],
    phrygian:   [0, 1, 3, 5, 7, 8, 10]
  };
  // i - VI - III - VII, two bars each
  const CHORDS = [
    { root: 0,  tones: [0, 3, 7] },
    { root: 8,  tones: [0, 4, 7] },
    { root: 3,  tones: [0, 4, 7] },
    { root: 10, tones: [0, 4, 7] }
  ];

  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  function initAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    A.ac = new AC();

    A.limiter = A.ac.createDynamicsCompressor();
    A.limiter.threshold.value = -2; A.limiter.ratio.value = 20;
    A.limiter.attack.value = 0.002; A.limiter.release.value = 0.1;
    A.limiter.connect(A.ac.destination);

    // Load-bearing (spec 4.3): road noise means high volume, so density
    // changes must not startle.
    A.comp = A.ac.createDynamicsCompressor();
    A.comp.threshold.value = -18; A.comp.ratio.value = 3;
    A.comp.attack.value = 0.01; A.comp.release.value = 0.25;
    A.comp.connect(A.limiter);

    A.lp = A.ac.createBiquadFilter();
    A.lp.type = 'lowpass'; A.lp.frequency.value = 1200; A.lp.Q.value = 0.8;
    A.lp.connect(A.comp);

    A.master = A.ac.createGain();
    A.master.gain.value = 0.8;
    A.master.connect(A.lp);

    A.panBus = A.ac.createStereoPanner ? A.ac.createStereoPanner() : A.ac.createGain();
    A.panBus.connect(A.master);

    A.drumBus = A.ac.createGain();
    A.drumBus.connect(A.master);

    // Silent buffer: the belt-and-braces iOS unlock.
    const b = A.ac.createBuffer(1, 1, 22050);
    const src = A.ac.createBufferSource();
    src.buffer = b; src.connect(A.ac.destination); src.start(0);
  }

  function startAudio() {
    if (A.running) return;
    A.running = true;
    A.nextTime = A.ac.currentTime + 0.1;
    A.step = 0;
    A.timer = setInterval(scheduler, TICK);
  }

  function scheduler() {
    if (!A.ac || A.ac.state !== 'running') return;
    if (M.active && M.notes.length) return schedulerMidi();
    while (A.nextTime < A.ac.currentTime + LOOKAHEAD) {
      scheduleStep(A.step, A.nextTime);
      // Tempo and feel changes land on bar lines only (spec 4.4).
      if (A.step % 16 === 0) {
        slewBpm();                             // slew-limit +/-4 BPM per bar
        A.feel = A.pendingFeel;
      }
      A.nextTime += 60 / A.bpm / 4;
      A.step = (A.step + 1) % 128;
    }
  }

  // ---- voices ----------------------------------------------------

  function env(node, t, a, d, peak) {
    const g = node.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  function kick(t, gain) {
    const o = A.ac.createOscillator(), g = A.ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    env(g, t, 0.002, 0.32, gain);
    o.connect(g); g.connect(A.drumBus);
    o.start(t); o.stop(t + 0.4);
  }

  function hat(t, gain, open) {
    const dur = open ? 0.16 : 0.045;
    const n = A.ac.createBufferSource();
    const len = Math.ceil(A.ac.sampleRate * dur);
    const buf = A.ac.createBuffer(1, len, A.ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    n.buffer = buf;
    const bp = A.ac.createBiquadFilter();
    bp.type = 'highpass'; bp.frequency.value = 7000;
    const g = A.ac.createGain();
    env(g, t, 0.001, dur, gain);
    n.connect(bp); bp.connect(g); g.connect(A.drumBus);
    n.start(t); n.stop(t + dur + 0.02);
  }

  function bass(t, midi, dur, gain, attack) {
    const o = A.ac.createOscillator(), g = A.ac.createGain(), f = A.ac.createBiquadFilter();
    o.type = 'sawtooth';
    o.frequency.value = mtof(midi);
    f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(220, t);
    f.frequency.exponentialRampToValueAtTime(900, t + 0.06);
    f.frequency.exponentialRampToValueAtTime(200, t + dur);
    env(g, t, attack, dur, gain);
    o.connect(f); f.connect(g); g.connect(A.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function pluck(t, midi, dur, gain, type) {
    const o = A.ac.createOscillator(), g = A.ac.createGain();
    o.type = type || 'square';
    o.frequency.value = mtof(midi);
    env(g, t, 0.004, dur, gain);
    o.connect(g); g.connect(A.panBus);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function lead(t, midi, dur, gain) {
    const g = A.ac.createGain(), f = A.ac.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 2600; f.Q.value = 2;
    const lfo = A.ac.createOscillator(), lg = A.ac.createGain();
    lfo.frequency.value = 5.2; lg.gain.value = 4;
    lfo.connect(lg);
    [0, 0.12].forEach(det => {
      const o = A.ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(midi + det);
      lg.connect(o.frequency);
      o.connect(f); o.start(t); o.stop(t + dur + 0.2);
    });
    env(g, t, 0.08, dur, gain);
    f.connect(g); g.connect(A.panBus);
    lfo.start(t); lfo.stop(t + dur + 0.2);
  }

  // Pad is the one voice that never stops — it carries the rest state.
  let padNodes = null;
  function padChord(t, chord, dur, bright) {
    if (padNodes) {
      try {
        padNodes.g.gain.cancelScheduledValues(t);
        padNodes.g.gain.setTargetAtTime(0.0001, t, 0.5);
        padNodes.osc.forEach(o => o.stop(t + 2.5));
      } catch (e) { /* already stopped */ }
    }
    const g = A.ac.createGain(), f = A.ac.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 1.5;
    // At full rest the bed sits at 180-380Hz: felt more than heard. The sweep
    // opens up only as the arrangement comes back in.
    const b = Math.max(0, Math.min(1, bright === undefined ? 1 : bright));
    f.frequency.setValueAtTime(180 + 320 * b, t);
    f.frequency.linearRampToValueAtTime(380 + 1420 * b, t + dur * 0.6);
    f.frequency.linearRampToValueAtTime(220 + 480 * b, t + dur);
    const osc = [];
    chord.tones.forEach(tn => {
      [-0.08, 0.08].forEach(det => {
        const o = A.ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(ROOT + 12 + chord.root + tn + det);
        o.connect(f); o.start(t); o.stop(t + dur + 3);
        osc.push(o);
      });
    });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.10, t + 0.8);
    f.connect(g); g.connect(A.panBus);
    padNodes = { g, osc };
  }

  // ---- the pattern ------------------------------------------------

  function scheduleStep(step, t) {
    const bar = Math.floor(step / 16);
    const s16 = step % 16;
    const chord = CHORDS[Math.floor(bar / 2) % 4];
    const scale = SCALES[A.scale];

    // Pad: new chord every 2 bars, always present.
    if (s16 === 0 && bar % 2 === 0) {
      padChord(t, chord, (60 / A.bpm) * 4 * 2, 1 - A.rest);
    }

    // `band` is how much of the full arrangement is audible. At rest it
    // goes to 0 and only the pad survives.
    const band = 1 - A.rest;
    if (band < 0.02) return;

    const D = DS;                     // current DriveState
    const intensity = D.intensity;
    const attack = 0.04 - 0.038 * Math.min(1, D.jerk / 12);

    // Kick
    const kickOn =
      A.feel === 'half'     ? (s16 % 8 === 0)
      : A.feel === 'double' ? (s16 % 2 === 0)
      :                       (s16 % 4 === 0);
    if (kickOn) kick(t, 0.85 * band);

    // Hats: appear at straight feel and above
    if (A.feel !== 'half') {
      const hatEvery = A.feel === 'double' ? 1 : 2;
      if (s16 % hatEvery === 0 && s16 % 4 !== 0) {
        hat(t, (0.10 + 0.14 * intensity) * band, s16 % 8 === 6);
      }
    }

    // Bass: root, denser with intensity
    const bassEvery = A.feel === 'half' ? 8 : intensity > 0.5 ? 2 : 4;
    if (s16 % bassEvery === 0) {
      const oct = (s16 % 8 === 0) ? 0 : 12;
      bass(t, ROOT - 12 + chord.root + (oct === 0 ? 0 : 0),
           (60 / A.bpm / 4) * (bassEvery * 0.85), 0.30 * band, attack);
    }

    // Arp: energy, not aggression alone - see updateRoleGains.
    if (A.energy > 0.4 && s16 % 2 === 1) {
      const idx = (step * 3) % scale.length;
      const oc = ((step >> 2) % 2) * 12;
      pluck(t, ROOT + 12 + chord.root + scale[idx] + oc,
            60 / A.bpm / 4 * 1.4, 0.085 * band * (0.5 + intensity * 0.5));
    }

    // Lead: energy > 0.7, sparse long notes
    if (A.energy > 0.7 && s16 === 0 && bar % 2 === 1) {
      const idx = (bar * 2) % scale.length;
      lead(t, ROOT + 24 + chord.root + scale[idx], (60 / A.bpm) * 3, 0.07 * band);
    }
  }

  // ---- continuous parameter mapping (M5) ---------------------------

  function applyMapping() {
    if (!A.ac || !A.running) return;
    const t = A.ac.currentTime, D = DS;

    // Tempo from speed; falls back to aggression when GPS is unavailable.
    const spd = (typeof D.speed === 'number' && isFinite(D.speed))
      ? Math.min(1, Math.max(0, D.speed / 33))   // 0..1 over 0..120 km/h
      : D.aggression;
    A.pendingBpm = 104 + 28 * (isFinite(spd) ? spd : 0);

    // Feel carries the big energy jumps, not BPM (spec 4.4).
    const energy = 0.6 * spd + 0.4 * D.aggression;
    A.spd = spd; A.energy = energy;
    const cur = A.pendingFeel;
    if (energy < (cur === 'half' ? 0.22 : 0.16)) A.pendingFeel = 'half';
    else if (energy > (cur === 'double' ? 0.58 : 0.68)) A.pendingFeel = 'double';
    else A.pendingFeel = 'straight';

    // Scale from aggression, with hysteresis.
    const ag = D.aggression;
    if (A.scale === 'minor' && ag > 0.38) A.scale = 'pentatonic';
    else if (A.scale === 'pentatonic' && ag < 0.32) A.scale = 'minor';
    else if (A.scale === 'pentatonic' && ag > 0.73) A.scale = 'phrygian';
    else if (A.scale === 'phrygian' && ag < 0.67) A.scale = 'pentatonic';

    // Master cutoff: exponential, dipped by braking, muffled further at rest.
    const base = 340 * Math.pow(38, D.intensity);
    const dip = 1 - 0.55 * D.brake;
    const calm = 1 - 0.45 * A.rest;
    A.lp.frequency.setTargetAtTime(Math.max(200, base * dip * calm), t, 0.12);

    // Cornering pans; it does not transpose.
    if (A.panBus.pan) A.panBus.pan.setTargetAtTime(
      Math.max(-0.7, Math.min(0.7, D.aLat / 6)), t, 0.25);

    // Rest: fade to pad alone over ~4s, rejoin handled on bar lines.
    A.restTarget = D.stationary ? 1 : 0;
    A.rest += (A.restTarget - A.rest) * 0.03;

    updateRoleGains();
  }

export { A, CHORDS, LOOKAHEAD, ROOT, SCALES, TICK, applyMapping, bass, env, hat, initAudio, kick, lead, mtof, padChord, padNodes, pluck, scheduleStep, scheduler, startAudio };
