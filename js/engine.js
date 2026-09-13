import { M } from './midi.js';
import { DS } from './motion.js';
import { schedulerMidi, slewBpm, updateRoleGains } from './playback.js';
import { SF } from './sf2.js';

  // ============================================================
  //  AUDIO ENGINE (M4) — generative driving techno
  // ============================================================
  const A = {
    ac: null, master: null, lp: null, comp: null, limiter: null,
    panBus: null, drumBus: null, roleBus: null, pump: null,
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
    restTarget: 1,
    tier: 0,                 // speed-ladder index; see TIERS in playback.js
    lastMap: 0               // when applyMapping last ran, for real-time smoothing
  };

  const LOOKAHEAD = 0.1;     // s of future to schedule
  const TICK = 25;           // ms between scheduler wakeups
  const ROOT = 57;           // A3

  const SCALES = {
    minor:      [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 3, 5, 7, 10],
    phrygian:   [0, 1, 3, 5, 7, 8, 10]
  };
  // i - VI - VII - v, two bars each. The old i - VI - III - VII resolved: the
  // III is the relative major and the ear hears it as the sun coming out,
  // which is the one thing this music must not do. Ending on a *minor* v
  // instead of a major VII leaves the loop unresolved, so eight bars later it
  // starts again because it has to rather than because it ran out.
  const CHORDS = [
    { root: 0,  tones: [0, 3, 7] },
    { root: 8,  tones: [0, 4, 7] },
    { root: 10, tones: [0, 4, 7] },
    { root: 7,  tones: [0, 3, 7] }
  ];

  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  // Saturation. Clean oscillators are the reason a synth line can be loud and
  // still sound like nothing; the weight in this music is distortion, not
  // level. A soft-clip curve adds the harmonics that survive a car speaker and
  // road noise, and it compresses as a side effect, so a saturated bass sits
  // still in the mix at a volume a clean one could not hold.
  //
  // The curves are cached by amount: building a 1024-point table per note, at
  // sixteen notes a bar, is real work for a phone to do in the audio thread's
  // shadow, and there are only a handful of distinct amounts in practice.
  const shapers = new Map();
  function satCurve(amount) {
    const k = Math.round(amount * 20) / 20;
    let c = shapers.get(k);
    if (c) return c;
    const n = 1024;
    c = new Float32Array(n);
    const drive = 1 + 40 * k;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * drive) / Math.tanh(drive);
    }
    shapers.set(k, c);
    return c;
  }

  /** A soft-clipper, or null when there is nothing to gain from one. */
  function saturator(amount) {
    if (!A.ac.createWaveShaper || amount <= 0.01) return null;
    const ws = A.ac.createWaveShaper();
    ws.curve = satCurve(amount);
    ws.oversample = '4x';
    return ws;
  }
  const clamp01 = v => Math.max(0, Math.min(1, isFinite(v) ? v : 1));

  // Everything audible hangs off A.master: the pump bus (everything but the
  // drums), the drum bus, and the generated bass, which goes through the pump.
  // That makes master the one node retiring cuts, so the buses are built as a
  // set.
  function buildBuses() {
    A.master = A.ac.createGain();
    A.master.gain.value = 0.8;
    A.master.connect(A.lp);

    // Sidechain. In this music the kick and the bass occupy the same register
    // and the bass never stops, so without ducking the two fight and the low
    // end turns to mud - the kick stops reading as a hit and starts reading as
    // a thickening. Every kick dips everything that is not a drum and lets it
    // swell back over the rest of the beat; that swell is the pulse the whole
    // genre is built on, and it is what makes a line of flat 8ths breathe.
    A.pump = A.ac.createGain();
    A.pump.gain.value = 1;
    A.pump.connect(A.master);

    A.panBus = A.ac.createStereoPanner ? A.ac.createStereoPanner() : A.ac.createGain();
    A.panBus.connect(A.pump);

    A.drumBus = A.ac.createGain();
    A.drumBus.connect(A.master);

    // A fixed place in the stereo field per layer. Every melodic part used to
    // arrive at the same point in the middle, so a file with five of them
    // playing at once was a single wide smear; spread out, the same notes
    // separate into parts you can follow. The offsets are small - this is a
    // phone on a mount, often heard over one speaker or through road noise, so
    // anything wider reads as a fault rather than as width.
    A.roleBus = {};
    for (const r in ROLE_PAN) {
      const g = A.ac.createGain();
      if (A.ac.createStereoPanner) {
        const p = A.ac.createStereoPanner();
        p.pan.value = ROLE_PAN[r];
        g.connect(p); p.connect(A.panBus);
      } else {
        g.connect(A.panBus);
      }
      A.roleBus[r] = g;
    }
  }

  // Bass and drums stay dead centre: low end belongs in the middle, and a kick
  // that wanders is the one thing a driver will notice as wrong.
  const ROLE_PAN = { pad: -0.22, keys: 0.28, lead: -0.14 };

  /** Where a layer's voices should land. Unknown layers go to the pan bus. */
  function busFor(role) {
    return (A.roleBus && A.roleBus[role]) || A.panBus;
  }

  // ---- cutting off whatever is currently sounding -----------------
  //
  // Switching MIDI file - or dropping back to the generator - left the previous
  // song ringing over the new one. A note already handed to start()/stop()
  // cannot be un-scheduled, and the tails here are long: the scheduler runs
  // LOOKAHEAD ahead, padNote holds for the note plus a second, padChord runs
  // eight bars and stops its oscillators three seconds after that, and a
  // soundfont voice with a loop plus release is longer still. This applies to
  // the built-in generator exactly as much as to a file, because both feed the
  // same buses.
  //
  // So rather than chase individual voices, retire the bus they are all
  // connected to: fade the old master out over CUT and disconnect it, then
  // build a fresh master/pan/drum set for everything scheduled from here on.
  // The old voices keep running into a node that goes nowhere and stop
  // themselves at the times they were already given.
  const CUT = 0.03;

  function silenceAll() {
    if (!A.ac || !A.master) return;
    const t = A.ac.currentTime, old = A.master;
    try {
      old.gain.cancelScheduledValues(t);
      old.gain.setValueAtTime(Math.max(1e-4, old.gain.value), t);
      old.gain.exponentialRampToValueAtTime(1e-4, t + CUT);
    } catch (e) { /* the param is already torn down; the disconnect still counts */ }
    // Disconnected only after the fade has actually run - pulling the node out
    // of the graph at once is the click the fade exists to avoid.
    setTimeout(() => { try { old.disconnect(); } catch (e) {} }, CUT * 1000 + 50);

    buildBuses();

    // padChord fades the previous chord instead of starting a new one, and
    // SF.excl chokes the voice it remembers. Both point into the graph that
    // was just retired, so anything they touch now is inaudible anyway - and
    // holding the references keeps the old nodes alive for no reason.
    padNodes = null;
    SF.excl.clear();

    // Re-base both schedulers: the playhead is about to be somewhere else, and
    // a stale nextTime would dump every missed step at once on the next wake.
    A.nextTime = A.ac.currentTime + 0.06;
    M.curTime = 0;
  }

  // The context is passed in rather than constructed here, so a test can drive
  // the whole engine with a recording stub. The real one is created inside the
  // Start gesture (iOS will not unlock audio outside one).
  function initAudio(ctx) {
    A.ac = ctx;

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

    buildBuses();

    // Silent buffer: the belt-and-braces iOS unlock.
    const b = A.ac.createBuffer(1, 1, 22050);
    const src = A.ac.createBufferSource();
    src.buffer = b; src.connect(A.ac.destination); src.start(0);
  }

  // `reset` is false when resuming from a pause: the pattern carries on from
  // the step it was on rather than snapping back to the top of the phrase.
  function startAudio(reset = true) {
    if (A.running) return;
    A.running = true;
    A.nextTime = A.ac.currentTime + 0.1;
    if (reset) A.step = 0;
    if (A.ac.resume && A.ac.state !== 'running') A.ac.resume().catch(() => {});
    A.timer = setInterval(scheduler, TICK);
  }

  // Pause has to cut as well as stop scheduling: the last tick has already
  // handed the context up to LOOKAHEAD of notes, and a pad chord holds for
  // bars after that, so stopping the timer alone leaves the song playing on
  // for seconds. Suspending the context would freeze those notes rather than
  // end them, and they would all resume mid-tail on the next play.
  function stopAudio() {
    if (!A.running) return;
    A.running = false;
    clearInterval(A.timer);
    A.timer = null;
    silenceAll();
    // Suspended after the fade has run, or the fade is frozen too.
    if (A.ac.suspend) setTimeout(() => {
      if (!A.running && A.ac.suspend) A.ac.suspend().catch(() => {});
    }, CUT * 1000 + 50);
  }

  function toggleAudio() {
    if (A.running) stopAudio(); else startAudio(false);
    return A.running;
  }

  function scheduler() {
    // A tick already queued when pause was pressed would otherwise schedule one
    // more bar - past the fade, so it plays into a silent bus and is simply
    // lost, but on resume the pattern has jumped.
    if (!A.running || !A.ac || A.ac.state !== 'running') return;
    if (M.active && M.notes.length) return schedulerMidi();
    // A backgrounded tab or a phone call freezes nextTime while currentTime
    // runs on, and every past-dated start() fires at once on resume: ten
    // seconds away is ~19 kicks and basses on one instant, straight into the
    // limiter. The MIDI scheduler already re-bases; this one has to as well.
    if (A.nextTime < A.ac.currentTime) A.nextTime = A.ac.currentTime + 0.06;
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

  // A MIDI file is full of notes shorter than a synth attack: in Descent's
  // credits 55% of the bass and 74% of the drums are under 40ms. Ramping to
  // peak over a fixed 40ms means those notes are still climbing out of 0.0001
  // when they end, so they are inaudible - which is why half the song appeared
  // not to play. The attack is therefore capped at a third of the note, and
  // every voice gets MIN_TAIL of release whatever its written length, so a
  // staccato note is short rather than silent.
  const MIN_TAIL = 0.08;

  function env(node, t, a, d, peak) {
    const g = node.gain;
    const atk = Math.max(0.002, Math.min(a, d * 0.3));
    const dec = Math.max(MIN_TAIL, d);
    const pk = Math.max(0.0002, peak);
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(pk, t + atk);
    g.exponentialRampToValueAtTime(0.0001, t + atk + dec);
    // How long the caller must keep the node alive for the tail to be heard.
    return atk + dec;
  }

  // How far a kick pulls everything else down, and how long the recovery
  // takes. Deep enough to hear as movement, short enough that the bass is
  // already back up by the following 8th.
  const PUMP_DEPTH = 0.42;
  const PUMP_BACK = 0.085;

  function duck(t, amount) {
    if (!A.pump || !A.pump.gain.setTargetAtTime) return;
    const depth = Math.max(0, Math.min(1, amount));
    A.pump.gain.setValueAtTime(1 - PUMP_DEPTH * depth, t);
    A.pump.gain.setTargetAtTime(1, t + 0.01, PUMP_BACK);
  }

  function kick(t, gain, pump = 1) {
    const o = A.ac.createOscillator(), g = A.ac.createGain();
    o.type = 'sine';
    // A longer pitch fall than a techno kick: the drop is the body of the
    // sound here, and 45Hz is where it wants to land and stay a moment.
    o.frequency.setValueAtTime(135, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.11);
    env(g, t, 0.002, 0.32, gain);
    o.connect(g); g.connect(A.drumBus);
    o.start(t); o.stop(t + 0.4);
    duck(t, pump * Math.min(1, gain / 0.6));
  }

  // Backbeat. Three short noise bursts a few milliseconds apart, then a
  // longer, darker tail - the gated-reverb clap the genre is named after,
  // built the cheap way because a convolver per hit is not affordable here.
  //
  // The whole thing is rendered into one buffer with its envelope baked in,
  // rather than as four scheduled bursts. Four bursts is twelve nodes, twice a
  // bar, on a phone that is also running the map: the clap on its own was a
  // third of everything the generator created.
  function clap(t, gain, tail = 1) {
    const len = Math.ceil(A.ac.sampleRate * (0.03 + 0.18 * tail));
    const buf = A.ac.createBuffer(1, len, A.ac.sampleRate);
    const d = buf.getChannelData(0);
    const sr = A.ac.sampleRate;
    // Three transients, then the tail. The transients are what reads as a
    // clap; the tail is what reads as a big empty room in 1984.
    const hits = [[0, 0.7, 0.02], [0.011, 0.85, 0.02], [0.023, 1, 0.03]];
    for (let i = 0; i < len; i++) {
      const tt = i / sr;
      let a = 0;
      for (const [at, amp, dur] of hits) {
        if (tt >= at && tt < at + dur) a += amp * (1 - (tt - at) / dur);
      }
      // The tail decays exponentially and is cut off short - a gate, not a
      // reverb, which is the difference the name is pointing at.
      if (tt >= 0.03) a += 0.5 * tail * Math.exp(-(tt - 0.03) / (0.055 * tail));
      d[i] = (Math.random() * 2 - 1) * a;
    }
    const n = A.ac.createBufferSource(); n.buffer = buf;
    const bp = A.ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.9;
    const g = A.ac.createGain();
    g.gain.setValueAtTime(Math.max(0.0002, gain), t);
    n.connect(bp); bp.connect(g); g.connect(A.drumBus);
    n.start(t); n.stop(t + buf.duration + 0.02);
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

  // `bright` is 0..1, normally the note's velocity. A filter that opens with
  // how hard the note was struck is most of what makes a synth sound played
  // rather than triggered; at a flat cutoff every note has the same bite and
  // the line sits still no matter what the music is doing.
  function bass(t, midi, dur, gain, attack, bright = 1) {
    const o = A.ac.createOscillator(), g = A.ac.createGain(), f = A.ac.createBiquadFilter();
    o.type = 'sawtooth';
    o.frequency.value = mtof(midi);
    // Resonance is the character control, not the cutoff: a lazy filter with
    // a lot of Q is the sound of a plucked analogue bass, and pushing it with
    // velocity means a hard note squelches where a soft one only thuds.
    f.type = 'lowpass'; f.Q.value = 4 + 8 * clamp01(bright);
    // The sweep has to fit inside the note. A fixed 0.06s peak on a 0.036s
    // note put the ramps out of order, and an automation curve whose target
    // times run backwards is not the filter envelope anyone intended.
    const life = env(g, t, attack, dur, gain);
    const peak = t + Math.min(0.06, life * 0.3);
    const top = 420 + 1100 * clamp01(bright);
    f.frequency.setValueAtTime(220, t);
    f.frequency.exponentialRampToValueAtTime(top, peak);
    f.frequency.exponentialRampToValueAtTime(200, t + life);
    // Straight to the pump, not the pan bus: cornering must not swing the low
    // end, but the kick must still duck it. The saw goes through the clipper
    // on the way, so the harder the note the dirtier it is - the filter
    // envelope decides the shape and the drive decides the menace.
    o.connect(f);
    const sat = saturator(0.25 + 0.5 * clamp01(bright));
    if (sat) { f.connect(sat); sat.connect(g); } else { f.connect(g); }
    g.connect(A.pump || A.master);
    o.start(t); o.stop(t + life + 0.05);

    // A sine an octave down, under the filter rather than through it. The
    // resonant saw carries the note; this carries the weight, which is the
    // half of the sound a phone speaker throws away and a car does not.
    const sub = A.ac.createOscillator(), sg = A.ac.createGain();
    sub.type = 'sine';
    sub.frequency.value = mtof(midi - 12);
    env(sg, t, Math.max(attack, 0.008), dur, gain * 0.55);
    sub.connect(sg); sg.connect(A.pump || A.master);
    sub.start(t); sub.stop(t + life + 0.05);
  }

  function pluck(t, midi, dur, gain, type, bright = 1) {
    const o = A.ac.createOscillator(), g = A.ac.createGain(), f = A.ac.createBiquadFilter();
    o.type = type || 'square';
    o.frequency.value = mtof(midi);
    // A bare square at pitch is the harshest thing in the mix over road noise.
    // A lowpass that tracks the note and closes with it reads as a plucked
    // string instead, and keeps stacked keys parts from turning into buzz.
    f.type = 'lowpass'; f.Q.value = 1;
    const life = env(g, t, 0.004, dur, gain);
    // A soft note opens to three harmonics, a hard one to eight.
    const open = mtof(midi) * (3 + 5 * clamp01(bright));
    f.frequency.setValueAtTime(Math.min(9000, open), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(400, mtof(midi) * 2), t + life);
    o.connect(f); f.connect(g); g.connect(busFor('keys'));
    o.start(t); o.stop(t + life + 0.05);
  }

  function lead(t, midi, dur, gain, bright = 1) {
    const g = A.ac.createGain(), f = A.ac.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1500 + 2400 * clamp01(bright);
    // Resonant, not just open: the peak at the cutoff is the whistle that
    // carries a lead line over a mix this dense.
    f.Q.value = 3.5;
    const lfo = A.ac.createOscillator(), lg = A.ac.createGain();
    // Slow and shallow. A fast, wide vibrato sounds human and warm, which is
    // the opposite of what this lead is for; this is barely-there drift, the
    // sound of an oscillator that will not quite stay in tune.
    lfo.frequency.value = 4.4; lg.gain.value = 2.5;
    lfo.connect(lg);
    // Three saws, detuned hard in cents and one of them an octave down. The
    // wide detune is the whole character - two oscillators sound like a synth
    // patch, three beating against each other sound like a machine.
    [-0.16, 0.14, -12].forEach(det => {
      const o = A.ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(midi + det);
      lg.connect(o.frequency);
      o.connect(f); o.start(t); o.stop(t + dur + 0.2);
    });
    // A long attack would make it sing; this one is meant to arrive.
    env(g, t, 0.03, dur, gain);
    const sat = saturator(0.3 + 0.4 * clamp01(bright));
    if (sat) { f.connect(sat); sat.connect(g); } else { f.connect(g); }
    g.connect(busFor('lead'));
    lfo.start(t); lfo.stop(t + dur + 0.2);
    // The oscillators above are stopped at t+dur+0.2, which is the tail env()
    // guarantees for a note this long; a lead note is never short enough for
    // MIN_TAIL to outrun it.
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
    // The chord is voiced across two octaves rather than stacked in one: the
    // root doubled an octave below is what makes it an analogue poly rather
    // than three notes, and it is the register a car actually reproduces.
    // Each voice is a detuned pair, so the whole thing drifts against itself.
    chord.tones.forEach((tn, i) => {
      const base = ROOT + 12 + chord.root + tn - (i === 0 ? 12 : 0);
      [-0.09, 0.09].forEach(det => {
        const o = A.ac.createOscillator();
        // Saw for the top voices, square for the root: the square's hollow
        // odd harmonics are the cold half of the sound.
        o.type = i === 0 ? 'square' : 'sawtooth';
        o.frequency.value = mtof(base + det);
        o.connect(f); o.start(t); o.stop(t + dur + 3);
        osc.push(o);
      });
    });
    g.gain.setValueAtTime(0.0001, t);
    // Slow enough that the chord swells in rather than landing - the pad is
    // weather, and weather does not have downbeats.
    g.gain.exponentialRampToValueAtTime(0.10, t + 1.4);
    f.connect(g); g.connect(busFor('pad'));
    padNodes = { g, osc };
  }

  // ---- the pattern ------------------------------------------------
  //
  // The parts do different jobs, and the arrangement is built by adding jobs
  // rather than by adding notes:
  //
  //   drums  the road      steady, unvarying, the thing you stop hearing
  //   bass   the engine    constant motion, syncopated against the kick
  //   arp    speed         16ths; subdivision is what reads as velocity
  //   chords atmosphere    slow, wide, and always there
  //   lead   the memory    sparse, and the only part allowed a tune
  //
  // The bass is written out as a table rather than derived from a modulo,
  // because the groove is in exactly which 16ths are missing. A line of even
  // 8ths on the root is not this music; the same line with two notes pushed
  // off the beat, one shortened, and a hole where the ear expects a note is.

  // [step, length in 16ths, velocity, semitones above the written root]
  const BASS = {
    // Cruising in traffic: roots under the kick, one push turning the bar
    // around so it does not sit still.
    idle: [[0, 3, 1.00, 0], [8, 2.4, 0.80, 0], [14, 1.6, 0.70, 12]],
    // The engine. Alternating 8ths, low/high octave, with a 16th push into
    // beats 2 and 4 and a deliberate gap on the downbeat of 4 - the hole is
    // what the head nods into.
    drive: [[0, 1.6, 1.00, 0], [2, 1.0, 0.70, 12], [4, 1.6, 0.88, 0],
            [7, 1.0, 0.78, 12], [8, 1.6, 1.00, 0], [10, 1.0, 0.70, 12],
            [13, 0.8, 0.85, 0], [14, 1.6, 0.95, 12]],
    // Flat out: 16ths, still with gaps on 7 and 13 so it drives rather than
    // buzzes. Shorter notes, which is most of why it sounds faster.
    flat: [[0, 0.9, 1.00, 0], [1, 0.9, 0.62, 0], [2, 0.9, 0.78, 12],
           [3, 0.9, 0.62, 0], [4, 0.9, 0.92, 0], [5, 0.9, 0.62, 0],
           [6, 0.9, 0.78, 12], [8, 0.9, 1.00, 0], [9, 0.9, 0.62, 0],
           [10, 0.9, 0.78, 12], [11, 0.9, 0.62, 0], [12, 0.9, 0.92, 0],
           [14, 0.9, 0.80, 12], [15, 0.9, 0.70, 0]]
  };

  // The lead is four fixed motifs, one per chord - scale degrees, so it
  // transposes with the progression and stays recognisable across it. Picking
  // a degree by arithmetic on the step counter, as this used to, gives a
  // different note every time and so is not a tune at all.
  const MOTIF = [
    [[0, 4, 0], [4, 2, 2], [8, 6, 1]],
    [[0, 4, 2], [6, 4, 1], [12, 3, 0]],
    [[2, 3, 4], [6, 2, 2], [8, 7, 1]],
    [[0, 6, 1], [8, 4, 4], [12, 2, 2]]
  ];

  // Off-beat 16ths land a hair late. Not swing - a fixed sixteenth of a step,
  // which is the difference between a sequencer and a player, and the reason
  // the bass and the kick feel interlocked rather than merely simultaneous.
  const PUSH = 0.06;

  function scheduleStep(step, t) {
    const bar = Math.floor(step / 16);
    const s16 = step % 16;
    const ci = Math.floor(bar / 2) % 4;
    const chord = CHORDS[ci];
    const scale = SCALES[A.scale];
    const stepDur = 60 / A.bpm / 4;
    // Where we are in the 8-bar phrase; the last bar of every four is where
    // the arrangement is allowed to do something different.
    const turn = (bar % 4) === 3;

    // Pad: new chord every 2 bars, always present.
    if (s16 === 0 && bar % 2 === 0) {
      padChord(t, chord, (60 / A.bpm) * 4 * 2, 1 - A.rest);
    }

    // `band` is how much of the full arrangement is audible. At rest it
    // goes to 0 and only the pad survives.
    const band = 1 - A.rest;
    if (band < 0.02) return;

    // Same speed ladder the MIDI layers use (see updateRoleGains): the tier
    // decides which parts exist at all, so the two modes gate alike.
    if (A.tier < 1) return;           // below 10 mph: pad only

    const D = DS;                     // current DriveState
    const intensity = D.intensity;
    const attack = 0.04 - 0.038 * Math.min(1, D.jerk / 12);
    const swung = t + (s16 % 2 === 1 ? stepDur * PUSH : 0);

    // ---- drums: the road -------------------------------------------
    // Four on the floor, and nothing clever. This part is supposed to stop
    // being noticed within a bar; every bit of interest belongs to the bass.
    const onFloor = A.feel === 'half' ? (s16 % 8 === 0) : (s16 % 4 === 0);
    if (onFloor) {
      kick(t, 0.85 * band, 1);
    } else if (A.feel === 'double' && s16 === 14 && turn) {
      // One pushed kick into the top of the phrase, flat out only.
      kick(t, 0.6 * band, 0.7);
    }

    // Backbeat on 2 and 4 from the moment there is a beat at all. It is the
    // clap, not the kick, that tells the driver what tempo they are hearing.
    if (s16 === 4 || s16 === 12) {
      if (A.feel !== 'half' || s16 === 12) {
        clap(t, (0.16 + 0.10 * intensity) * band, A.feel === 'double' ? 0.7 : 1);
      }
    }

    // Hats hold the subdivision: 8ths normally, 16ths once the arrangement is
    // running, which is the cheapest way to make the same tempo feel quicker.
    if (A.feel !== 'half' || A.tier >= 4) {
      const hatEvery = (A.feel === 'double' || A.tier >= 4) ? 1 : 2;
      if (s16 % hatEvery === 0 && s16 % 4 !== 0) {
        hat(swung, (0.09 + 0.13 * intensity) * band * (s16 % 4 === 2 ? 1 : 0.65),
            s16 === 14 && !turn);
      }
    }

    // ---- bass: the engine ------------------------------------------
    // Which line is playing is the arrangement's main gear change: sparse in
    // traffic, alternating 8ths at road speed, 16ths flat out.
    const line = A.feel === 'half' ? BASS.idle
               : (A.feel === 'double' || intensity > 0.62) ? BASS.flat
               : BASS.drive;
    for (const [st, len, vel, oct] of line) {
      if (st !== s16) continue;
      // The turnaround bar drops the note that would land on the last 8th,
      // so the phrase has somewhere to arrive. A rest is a note.
      if (turn && st === 14 && line !== BASS.idle) continue;
      // Notes shorten as the drive gets harder: same pattern, more urgency.
      const gate = len * (1 - 0.25 * intensity);
      bass(swung, ROOT - 12 + chord.root + oct,
           stepDur * gate * 0.9, 0.30 * band * (0.55 + 0.45 * vel), attack,
           0.3 + 0.7 * (vel * (0.45 + 0.55 * intensity)));
    }

    // ---- arp: speed -------------------------------------------------
    // Straight 16ths from the 20 mph breakpoint, climbing through the chord
    // and folding back an octave - the wheel-rotation part. It plays every
    // 16th rather than every other one, because continuous motion is the
    // point; what changes with speed is how bright and how short it is.
    if (A.tier >= 2) {
      const seq = [0, 1, 2, 1, 2, 3, 2, 1];   // up, back, further up, back
      const idx = seq[step % seq.length];
      const oc = 12 * ((step >> 3) % 2);
      const deg = scale[(ci * 2 + idx) % scale.length];
      pluck(swung, ROOT + 12 + chord.root + deg + oc,
            stepDur * (0.9 - 0.45 * intensity),
            0.070 * band * (0.45 + 0.55 * intensity) * (s16 % 4 === 0 ? 1 : 0.75),
            null, 0.3 + 0.7 * intensity);
    }

    // ---- lead: the thing the driver remembers ------------------------
    if (A.tier >= 3 && bar % 2 === 1) {
      for (const [st, len, deg] of MOTIF[ci]) {
        if (st !== s16) continue;
        lead(t, ROOT + 24 + chord.root + scale[deg % scale.length],
             stepDur * len, 0.07 * band, 0.4 + 0.6 * intensity);
      }
    }
  }

  // ---- continuous parameter mapping (M5) ---------------------------

  // How fast the mix answers the road, in seconds. These used to be per-tick
  // constants, which quietly meant "whatever rate the UI happens to call us
  // at" - changing the interval changed the feel of the car with no sign that
  // it had. They are time constants now, applied against the real elapsed
  // time, so the numbers below mean what they say.
  //
  // Each is asymmetric for the same reason: coming in has to be immediate,
  // because the driver caused it and is waiting for it; going out has to be
  // gentle, because nobody asked for it and a layer snapping off is a fault.
  const RESP = {
    restBack: 0.35,   // pulling away: pad-only back to the full band
    restTo:   3.0,    // stopping: band back down to the pad
    layerIn:  0.25,   // a rung of the speed ladder arriving
    layerOut: 0.8,    // and leaving
    cutoff:   0.05    // the master filter chasing intensity
  };
  const toward = (cur, tgt, tc, dt) => cur + (tgt - cur) * (1 - Math.exp(-dt / Math.max(1e-3, tc)));

  function applyMapping() {
    if (!A.ac || !A.running) return;
    const t = A.ac.currentTime, D = DS;
    // Real elapsed time, not an assumed tick: a backgrounded tab, a slow phone
    // or a changed interval would otherwise silently retune every response
    // above. Clamped, because a tab that was asleep for a minute must not
    // teleport the mix on its first wake.
    const dt = Math.min(0.5, Math.max(0.001, t - (A.lastMap || t - 0.04)));
    A.lastMap = t;

    // Tempo from speed; falls back to aggression when GPS is unavailable.
    const spd = (typeof D.speed === 'number' && isFinite(D.speed))
      ? Math.min(1, Math.max(0, D.speed / 33))   // 0..1 over 0..120 km/h
      : D.aggression;
    // 100-124. The genre lives just under half-time-able territory: slow
    // enough that 16ths are playable and fast enough to drive. The old range
    // topped out where the 16th arp starts to smear.
    A.pendingBpm = 100 + 24 * (isFinite(spd) ? spd : 0);

    // Feel carries the big energy jumps, not BPM (spec 4.4).
    const energy = 0.6 * spd + 0.4 * D.aggression;
    A.spd = spd; A.energy = energy;
    const cur = A.pendingFeel;
    if (energy < (cur === 'half' ? 0.22 : 0.16)) A.pendingFeel = 'half';
    else if (energy > (cur === 'double' ? 0.58 : 0.68)) A.pendingFeel = 'double';
    else A.pendingFeel = 'straight';

    // Scale from aggression, with hysteresis.
    // Minor for ordinary driving, phrygian once it stops being ordinary. The
    // pentatonic rung in the middle is the one that used to make hard driving
    // sound *lighter* than gentle driving, because dropping the 2nd and 6th
    // takes out exactly the two notes carrying the menace. The route is now
    // minor to phrygian and back, and the phrygian b2 is the whole point.
    const ag = D.aggression;
    if (A.scale === 'pentatonic') A.scale = 'minor';     // retired rung
    if (A.scale === 'minor' && ag > 0.45) A.scale = 'phrygian';
    else if (A.scale === 'phrygian' && ag < 0.38) A.scale = 'minor';

    // Master cutoff: exponential, dipped by braking, muffled further at rest.
    // Darker floor, same ceiling: at a crawl the mix is muffled and close, and
    // opening it up is most of what acceleration feels like.
    const base = 260 * Math.pow(48, D.intensity);
    const dip = 1 - 0.55 * D.brake;
    const calm = 1 - 0.45 * A.rest;
    A.lp.frequency.setTargetAtTime(Math.max(200, base * dip * calm), t, RESP.cutoff);

    // Cornering pans; it does not transpose.
    if (A.panBus.pan) A.panBus.pan.setTargetAtTime(
      Math.max(-0.7, Math.min(0.7, D.aLat / 6)), t, 0.25);

    // Rest: the band comes back fast and leaves slowly.
    A.restTarget = D.stationary ? 1 : 0;
    A.rest = toward(A.rest, A.restTarget,
                    A.restTarget > A.rest ? RESP.restTo : RESP.restBack, dt);

    updateRoleGains(dt);
  }

export { A, BASS, CHORDS, CUT, MOTIF, PUSH, clap, duck, RESP, ROLE_PAN, busFor, LOOKAHEAD, MIN_TAIL, ROOT, SCALES, TICK, applyMapping, bass, buildBuses, env, hat, initAudio, kick, lead, mtof, padChord, padNodes, pluck, scheduleStep, scheduler, silenceAll, startAudio, stopAudio, toggleAudio };
