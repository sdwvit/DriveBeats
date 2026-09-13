// The built-in generator's groove.
//
// The redesign these cover came out of the synthwave/outrun writing the user
// pointed at, whose central claim is that groove is not more notes: it is
// which notes are missing, which ones are late, and how the bass argues with
// the kick. Every case below is about one of those three, because they are
// the things a "make it groovier" edit silently undoes.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAudioContext } from './fake-audio.mjs';
import { A, BASS, CHORDS, initAudio, scheduleStep } from '../js/engine.js';
import { DS } from '../js/motion.js';

let ctx;
const stepDur = () => 60 / A.bpm / 4;

/** Play one bar and report what was created, step by step. */
function bar({ feel = 'straight', tier = 4, intensity = 0.4, nbar = 0 } = {}) {
  ctx = new FakeAudioContext();
  initAudio(ctx);
  A.running = true; A.bpm = 112; A.rest = 0; A.tier = tier;
  A.feel = feel; A.scale = 'minor';
  DS.intensity = intensity; DS.jerk = 0; DS.aggression = intensity;
  ctx.clear();
  const rows = [];
  for (let s = 0; s < 16; s++) {
    const at = ctx.log.length;
    const t = s * stepDur();
    scheduleStep(nbar * 16 + s, t);
    rows.push({ s, t, log: ctx.log.slice(at) });
  }
  return rows;
}

// A kick is the only sine oscillator that ramps its frequency down; the bass
// sub is a sine too, so match on the fall rather than on the waveform.
const kicked = r => r.log.some(e =>
  e.op === 'exponentialRamp' && e.param === 'frequency' && e.value > 40 && e.value < 60);
// The bass is the one voice whose filter has Q pushed well past 1.
const bassed = r => r.log.some(e => e.param === 'Q' && e.value >= 4);

test('the bass does not simply follow the kick', () => {
  const rows = bar();
  const kicks = rows.filter(kicked).map(r => r.s);
  const basses = rows.filter(bassed).map(r => r.s);
  assert.deepEqual(kicks, [0, 4, 8, 12], 'four on the floor');
  const off = basses.filter(s => !kicks.includes(s));
  assert.ok(off.length >= 3,
    `only ${off.length} bass notes fall between kicks - that is a doubled kick, not a groove`);
});

test('a bar of bass leaves holes in it', () => {
  const rows = bar();
  const basses = rows.filter(bassed).map(r => r.s);
  assert.ok(basses.length < 16, 'a note on every 16th is a drone');
  // The deliberate one: nothing on the downbeat of beat 4.
  assert.ok(!basses.includes(12), 'the gap on 12 is the one the head nods into');
});

test('off-beat notes are played late, on-beat notes are not', () => {
  const rows = bar();
  for (const r of rows) {
    const starts = r.log.filter(e => e.op === 'start');
    if (!starts.length) continue;
    const late = Math.min(...starts.map(e => e.time)) - r.t;
    if (r.s % 2 === 0) assert.ok(late < 1e-9, `step ${r.s} is on the grid`);
  }
  // At least one odd step is pushed behind its own grid position.
  const pushed = rows.filter(r => r.s % 2 === 1 &&
    r.log.some(e => e.op === 'start' && e.time > r.t + 1e-9));
  assert.ok(pushed.length >= 3, `only ${pushed.length} steps are pushed`);
});

test('every kick ducks everything that is not a drum', () => {
  const rows = bar();
  const dips = ctx.log.filter(e => e.param === 'gain' && e.op === 'setValueAtTime'
                                   && e.value > 0.3 && e.value < 1);
  assert.equal(dips.length, rows.filter(kicked).length,
    'one dip per kick - the pump is the pulse');
  const back = ctx.log.filter(e => e.param === 'gain' && e.op === 'setTargetAtTime' && e.value === 1);
  assert.equal(back.length, dips.length, 'and each one comes back up');
});

test('harder driving shortens the notes rather than adding more', () => {
  const notesIn = rows => rows.filter(bassed).length;
  const calm = bar({ intensity: 0.1 });
  const hard = bar({ intensity: 0.55 });
  const gateOf = rows => {
    const r = rows.find(bassed);
    const starts = r.log.filter(e => e.op === 'stop');
    return Math.min(...starts.map(e => e.time)) - r.t;
  };
  assert.equal(notesIn(calm), notesIn(hard), 'same line, same number of notes');
  assert.ok(gateOf(hard) < gateOf(calm),
    `notes must get shorter with effort (${gateOf(hard)} vs ${gateOf(calm)})`);
});

test('speed changes the bass line itself, not just its level', () => {
  const n = o => bar(o).filter(bassed).length;
  const idle = n({ feel: 'half' });
  const drive = n({ feel: 'straight' });
  const flat = n({ feel: 'double' });
  assert.ok(idle < drive && drive < flat,
    `idle ${idle}, drive ${drive}, flat ${flat} - each gear must add motion`);
  assert.equal(idle, BASS.idle.length);
});

test('the arp runs continuous 16ths once it is in', () => {
  const rows = bar({ tier: 2 });
  // The pluck is the only voice on the keys bus; it creates an oscillator on
  // every step it plays.
  const played = rows.filter(r => r.log.some(e => e.op === 'create' && e.node === 'oscillator')).length;
  assert.equal(played, 16, 'motion is the point - a gap in the arp is a gap in the speed');
  assert.equal(bar({ tier: 1 }).filter(r =>
    r.log.some(e => e.op === 'create' && e.node === 'oscillator')).length > 0, true,
    'the bass still plays below the arp breakpoint');
});

test('the lead plays the same motif each time round the progression', () => {
  const pitches = nbar => bar({ nbar, tier: 4 }).flatMap(r => r.log
    .filter(e => e.op === 'value' && e.param === 'frequency')
    .map(e => e.value));
  // Bars 1 and 9 are the same chord in the progression, two laps apart.
  assert.deepEqual(pitches(1), pitches(1 + CHORDS.length * 2),
    'a lead that is different every lap is not a tune');
});

test('the progression does not resolve to a major chord', () => {
  for (const c of CHORDS) {
    const third = c.tones[1];
    if (third === 4) assert.notEqual(c.root, 0, 'the tonic stays minor');
  }
  assert.ok(CHORDS.some(c => c.tones[1] === 3 && c.root !== 0),
    'and it comes home through another minor chord, not the relative major');
});
