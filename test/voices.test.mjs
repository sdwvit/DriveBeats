// The built-in synth voices: does a note that is written short actually sound?
//
// Descent 2's credits is the file that exposed this. 55% of its bass notes and
// 74% of its drum notes are shorter than the 40ms attack the voices used to
// ramp over, so those notes were still climbing out of silence when they
// ended - "half the notes are not playing". Every case below is about a note
// being audible, not about which note it is.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAudioContext } from './fake-audio.mjs';
import { A, MIN_TAIL, bass, env, initAudio, pluck, scheduler } from '../js/engine.js';
import { M, loadParsed, parseMidi, rebuildNotes } from '../js/midi.js';
import { MAX_PER_ROLE, thin } from '../js/playback.js';

const FIX = path.join(import.meta.dirname, 'fixtures');
const read = n => {
  const b = fs.readFileSync(path.join(FIX, n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

let ctx;
beforeEach(() => {
  ctx = new FakeAudioContext();
  initAudio(ctx);
  A.running = true; A.bpm = 112; A.rest = 0; A.tier = 4;
  // initAudio's own bus nodes and its silent iOS unlock buffer are in the log
  // too, and they would answer every query below instead of the voice.
  ctx.clear();
});

// A node's log entries carry its *current* .type, so a filter's automation is
// filed under 'lowpass' and an oscillator's under 'sawtooth'. Find the node by
// the id its create event carried instead.
const idOf = (c, type) => (c.log.find(e => e.op === 'create' && e.node === type) || {}).id;
const freqRamps = (c, id) => c.log
  .filter(e => e.id === id && e.param === 'frequency' && e.op !== 'cancel')
  .sort((a, b) => a.time - b.time);

/** Gain automation for one node, in scheduled order. */
const ramps = (c, id) => c.log
  .filter(e => e.id === id && e.param === 'gain' && e.op !== 'cancel')
  .sort((a, b) => a.time - b.time);

test('a note far shorter than the attack still reaches full level', () => {
  const g = ctx.createGain();
  env(g, 0, 0.04, 0.004, 0.3);           // 4ms note, 40ms attack
  const r = ramps(ctx, g.id);
  const peak = Math.max(...r.map(e => e.value));
  assert.equal(peak, 0.3, 'the note reaches the level it asked for');
  const atPeak = r.find(e => e.value === 0.3).time;
  assert.ok(atPeak <= 0.004, `peak at ${atPeak}s, after a 4ms note ends`);
});

test('every voice gets an audible tail, however short the note', () => {
  for (const dur of [0.001, 0.004, 0.036, 0.5]) {
    const g = ctx.createGain();
    const life = env(g, 0, 0.04, dur, 0.3);
    assert.ok(life >= MIN_TAIL, `a ${dur}s note lives ${life}s`);
    assert.ok(life >= dur, 'and never less than its written length');
  }
});

test('envelope times always run forwards', () => {
  for (const a of [0.001, 0.04, 0.3]) {
    for (const d of [0.001, 0.01, 0.036, 2]) {
      const g = ctx.createGain();
      env(g, 1.5, a, d, 0.2);
      const r = ramps(ctx, g.id);
      for (let i = 1; i < r.length; i++)
        assert.ok(r[i].time > r[i - 1].time,
          `a=${a} d=${d}: automation at ${r[i].time} follows ${r[i - 1].time}`);
    }
  }
});

// An AudioParam ramp whose target time precedes an already-scheduled one is not
// the filter envelope anyone intended - and the bass is where it showed, since
// its sweep peaked at a fixed 60ms on notes lasting 36.
test('the bass filter sweep fits inside the note', () => {
  bass(0, 40, 0.036, 0.3, 0.04);
  const f = freqRamps(ctx, idOf(ctx, 'filter'));
  assert.ok(f.length >= 3, 'the bass has a filter sweep');
  for (let i = 1; i < f.length; i++)
    assert.ok(f[i].time > f[i - 1].time, 'sweep times run forwards');
  const stop = ctx.log.find(e => e.op === 'stop');
  assert.ok(stop.time >= f[f.length - 1].time,
    'the oscillator outlives its own filter sweep');
});

test('a plucked note closes its filter with the note, not after it', () => {
  pluck(0, 60, 0.03, 0.1);
  const f = freqRamps(ctx, idOf(ctx, 'filter'));
  assert.ok(f.length >= 2, 'the pluck has a filter envelope');
  assert.ok(f[0].value > f[f.length - 1].value, 'and it closes');
});

// ---- pile-up ----------------------------------------------------

test('a tick thins to at most MAX_PER_ROLE per layer, loudest kept', () => {
  M.tracks = [{ role: 'drums', notes: [] }, { role: 'bass', notes: [] }];
  const due = [];
  for (let i = 0; i < 9; i++) due.push({ trackIdx: 0, vel: i * 10, midi: 40, start: 0, dur: 10 });
  for (let i = 0; i < 3; i++) due.push({ trackIdx: 1, vel: 50, midi: 30, start: 0, dur: 10 });
  const kept = thin(due);
  const drums = kept.filter(n => n.trackIdx === 0);
  assert.equal(drums.length, MAX_PER_ROLE);
  assert.deepEqual(drums.map(n => n.vel).sort((a, b) => b - a), [80, 70, 60, 50]);
  assert.equal(kept.filter(n => n.trackIdx === 1).length, 3, 'a quiet layer is untouched');
});

test('thinning never drops a layer entirely', () => {
  M.tracks = [{ role: 'pad', notes: [] }, { role: 'lead', notes: [] }];
  const due = [];
  for (let i = 0; i < 20; i++) due.push({ trackIdx: i % 2, vel: 60, midi: 60, start: 0, dur: 10 });
  const kept = thin(due);
  assert.ok(kept.some(n => n.trackIdx === 0) && kept.some(n => n.trackIdx === 1));
});

// ---- the file that started it ------------------------------------

test('credits.mid: no layer takes more than half the song', () => {
  loadParsed(parseMidi(read('credits.mid')), 'credits.mid');
  const per = {};
  for (const t of M.tracks) per[t.role] = (per[t.role] || 0) + t.notes.length;
  const total = M.tracks.reduce((s, t) => s + t.notes.length, 0);
  for (const r in per)
    assert.ok(per[r] <= total * 0.5,
      `${r} holds ${per[r]} of ${total} notes - one voice playing the whole song`);
});

test('credits.mid: at most two tracks are routed to the bass', () => {
  loadParsed(parseMidi(read('credits.mid')), 'credits.mid');
  assert.ok(M.tracks.filter(t => t.role === 'bass').length <= 2);
});

test('changing a layer does not restart the song', () => {
  loadParsed(parseMidi(read('credits.mid')), 'credits.mid');
  M.curTick = 5000;
  M.tracks[0].role = 'off';
  rebuildNotes();
  assert.equal(M.curTick, 5000, 'the playhead stays put');
  assert.ok(M.idx > 0, 'and the note index is re-seeked to it');
  assert.ok(M.notes[M.idx - 1].start <= 5000, 'no note before the playhead is pending');
});

// ---- resume after an interruption ---------------------------------

test('a suspended context does not dump a burst of past-dated notes on resume', () => {
  M.active = false; M.notes = [];
  A.nextTime = ctx.currentTime + 0.1;
  ctx.advance(10);                       // a phone call
  scheduler();
  const early = ctx.starts().filter(e => e.time < ctx.currentTime);
  assert.deepEqual(early, [], 'nothing is scheduled in the past');
  assert.ok(ctx.starts().length < 40, 'and it is one bar of catch-up, not ten seconds');
});
