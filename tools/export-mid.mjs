// Render the built-in generator to a Standard MIDI File.
//
//   npm run export -- [out.mid]
//
// The point of this is to be able to hear the generator somewhere other than
// in a moving car: load the result into a DAW, or back into the app itself,
// and the pattern is sitting still where it can be looked at.
//
// The pattern logic is deliberately not duplicated here. scheduleStep is run
// against the recording fake context the tests use and the notes are read back
// out of the graph it built, so the file is by construction whatever the app
// actually plays - if the generator changes, so does this, with nothing to
// keep in step by hand.
//
// The tempo is fixed at 135 rather than mapped from a drive, because a file
// has no accelerometer; PLAN below stands in for one, walking up the speed
// ladder and back down again.
import fs from 'node:fs';
import { FakeAudioContext } from '../test/fake-audio.mjs';
import { A, initAudio, scheduleStep } from '../js/engine.js';
import { DS } from '../js/motion.js';

const BPM = 135, TPQ = 480, STEP = TPQ / 4;
const OUT = process.argv[2] || 'drivebeats.mid';
const mtom = hz => Math.round(69 + 12 * Math.log2(hz / 440));

// One "drive" through an arrangement: each entry is a stretch of bars at a
// given tier/feel/intensity, which is how the app's own layer ladder behaves
// when a car pulls away, settles, and opens up.
const PLAN = [
  { bars: 4,  tier: 1, feel: 'half',     intensity: 0.10 },
  { bars: 8,  tier: 2, feel: 'straight', intensity: 0.30 },
  { bars: 8,  tier: 3, feel: 'straight', intensity: 0.45 },
  { bars: 16, tier: 4, feel: 'double',   intensity: 0.75 },
  { bars: 8,  tier: 3, feel: 'straight', intensity: 0.40 }
];

const tracks = { drums: [], bass: [], keys: [], lead: [], pad: [] };
let step = 0, tick = 0;

for (const phase of PLAN) {
  for (let b = 0; b < phase.bars; b++) {
    for (let s = 0; s < 16; s++) {
      const ctx = new FakeAudioContext();
      initAudio(ctx);
      A.running = true; A.bpm = BPM; A.rest = 0;
      A.tier = phase.tier; A.feel = phase.feel; A.scale = 'minor';
      DS.intensity = phase.intensity; DS.jerk = 0; DS.aggression = phase.intensity;
      ctx.clear();
      const t0 = 0;
      scheduleStep(step, t0);
      emit(ctx, tick, 60 / BPM / 4);
      step = (step + 1) % 128;
      tick += STEP;
    }
  }
}

// Pull notes back out of one step's worth of graph building.
function emit(ctx, tick, stepSec) {
  const nodes = [...ctx._nodes.values()];
  // A fake node reports its *waveform* in .type once one is assigned, so an
  // oscillator is 'sawtooth' and a filter is 'lowpass' - not 'oscillator' and
  // 'filter'. Classify on that plus which params the node carries.
  const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];
  const oscs = nodes.filter(n => WAVES.includes(n.type) && n.startTime !== undefined);
  const bufs = nodes.filter(n => n.type === 'bufferSource' && n.startTime !== undefined
                                 && n.buffer && n.buffer.length > 1);
  const filts = nodes.filter(n => ['lowpass', 'highpass', 'bandpass'].includes(n.type));
  const q = v => filts.some(f => f.Q && Math.abs(f.Q.value - v) < 0.01);
  const hz = o => o.frequency.value;
  // where in the step the voice was actually played, in ticks
  const off = n => Math.round((n.startTime / stepSec) * STEP);
  const len = n => Math.max(30, Math.round(((n.stopTime - n.startTime) / stepSec) * STEP));

  // drums: the noise voices, told apart by the filter in front of them
  for (const n of bufs) {
    const f = filts.find(f => (n.outputs[0] === f));
    if (!f) continue;
    const cut = f.frequency.value;
    const midi = f.type === 'highpass' ? 42 : 39;       // hat / clap
    void cut;
    tracks.drums.push({ tick: tick + off(n), midi, dur: 40, vel: 90 });
  }
  // kick: the sine that falls to ~48Hz
  for (const o of oscs) {
    if (o.type !== 'sine') continue;
    const fell = ctx.log.some(e => e.id === o.id && e.op === 'exponentialRamp'
                                   && e.param === 'frequency' && e.value < 60);
    if (fell) tracks.drums.push({ tick: tick + off(o), midi: 36, dur: 60, vel: 110 });
  }
  // A voice is claimed once: the pad and the bass both run on the downbeat of
  // an even bar, and without this the pad track collects the bass note too.
  const claimed = new Set();

  // bass: saw through a high-Q filter, plus a sine sub - keep the saw
  if (q(4 + 8 * 0) || filts.some(f => f.Q && f.Q.value >= 4)) {
    const saw = oscs.filter(o => o.type === 'sawtooth' && hz(o) < 200);
    if (saw.length) {
      const o = saw[0];
      tracks.bass.push({ tick: tick + off(o), midi: mtom(hz(o)), dur: len(o), vel: 100 });
      // the saw and its sub are both spoken for
      for (const n of oscs) if (hz(n) <= hz(o) + 1) claimed.add(n.id);
    }
  }
  // arp: a single square through a gentle filter
  for (const o of oscs) {
    if (o.type === 'square' && hz(o) > 400
        && filts.some(f => f.Q && Math.abs(f.Q.value - 1) < 0.01)) {
      tracks.keys.push({ tick: tick + off(o), midi: mtom(hz(o)), dur: len(o), vel: 80 });
      claimed.add(o.id);
    }
  }
  // lead: three detuned saws above the bass register
  const leadOsc = oscs.filter(o => o.type === 'sawtooth' && hz(o) > 200);
  if (leadOsc.length >= 3 && filts.some(f => f.Q && Math.abs(f.Q.value - 3.5) < 0.01)) {
    const top = leadOsc.map(hz).sort((a, b) => b - a)[0];
    const o = leadOsc[0];
    tracks.lead.push({ tick: tick + off(o), midi: mtom(top), dur: len(o), vel: 95 });
    for (const n of leadOsc) claimed.add(n.id);
  }
  // pad: the chord, taken once per voiced pair
  if (filts.some(f => f.Q && Math.abs(f.Q.value - 1.5) < 0.01)) {
    const seen = new Set();
    for (const o of oscs) {
      if (claimed.has(o.id) || hz(o) > 400 || hz(o) < 40) continue;
      const m = mtom(hz(o));
      if (seen.has(m)) continue;
      seen.add(m);
      tracks.pad.push({ tick: tick + off(o), midi: m, dur: TPQ * 8, vel: 60 });
    }
  }
}

// ---- Standard MIDI File, type 1 ------------------------------------
const vlq = n => { const b = [n & 127]; n >>= 7; while (n) { b.unshift((n & 127) | 128); n >>= 7; } return b; };
const be = (n, w) => Array.from({ length: w }, (_, i) => (n >> (8 * (w - 1 - i))) & 255);
function chunk(id, data) { return [...[...id].map(c => c.charCodeAt(0)), ...be(data.length, 4), ...data]; }

function trackChunk(name, notes, ch) {
  const ev = [];
  for (const n of notes) {
    ev.push({ t: n.tick, d: [0x90 | ch, n.midi, n.vel] });
    ev.push({ t: n.tick + n.dur, d: [0x80 | ch, n.midi, 0] });
  }
  ev.sort((a, b) => a.t - b.t || a.d[0] - b.d[0]);
  const out = [0, 0xFF, 0x03, name.length, ...[...name].map(c => c.charCodeAt(0))];
  let last = 0;
  for (const e of ev) { out.push(...vlq(e.t - last), ...e.d); last = e.t; }
  out.push(...vlq(0), 0xFF, 0x2F, 0x00);
  return chunk('MTrk', out);
}

const usPerBeat = Math.round(60e6 / BPM);
const meta = [0, 0xFF, 0x51, 3, ...be(usPerBeat, 3),
              0, 0xFF, 0x58, 4, 4, 2, 24, 8,
              0, 0xFF, 0x2F, 0];
const names = [['Drums', tracks.drums, 9], ['Bass', tracks.bass, 0],
               ['Arp', tracks.keys, 1], ['Lead', tracks.lead, 2], ['Pad', tracks.pad, 3]];
const out = [...chunk('MThd', [...be(1, 2), ...be(names.length + 1, 2), ...be(TPQ, 2)]),
             ...chunk('MTrk', meta),
             ...names.flatMap(([n, t, c]) => trackChunk(n, t, c))];
fs.writeFileSync(OUT, Buffer.from(out));
for (const [n, t] of names) console.log(n.padEnd(6), t.length, 'notes');
console.log('bars', tick / (TPQ * 4), '->', OUT);
