// Switching songs, and the play/pause button.
//
// A note handed to the Web Audio context cannot be un-scheduled: the scheduler
// runs ahead, a pad chord holds for bars, a soundfont voice loops until its
// release. So "stop" cannot mean "stop scheduling" - it has to mean the bus
// every voice is connected to stops being audible. These check that it does,
// for a MIDI file and for the built-in generator alike.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAudioContext } from './fake-audio.mjs';
import {
  A, CUT, initAudio, padChord, scheduleStep, scheduler, silenceAll, startAudio, stopAudio, toggleAudio
} from '../js/engine.js';
import { M, loadParsed, parseMidi } from '../js/midi.js';
import { DS } from '../js/motion.js';

const FIX = path.join(import.meta.dirname, 'fixtures');
const read = n => {
  const b = fs.readFileSync(path.join(FIX, n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

let ctx;
beforeEach(() => {
  ctx = new FakeAudioContext();
  initAudio(ctx);
  A.running = false; A.bpm = 112; A.rest = 0; A.tier = 4; A.timer = null;
  M.active = false; M.tracks = []; M.notes = []; M.curTick = 0; M.curTime = 0;
});

// startAudio installs a real interval; one left running keeps node alive long
// after the suite has finished.
afterEach(() => { clearInterval(A.timer); A.timer = null; A.running = false; });

// Comfortably past the disconnect and the suspend, both of which wait out
// the fade before they run.
const settle = () => new Promise(r => setTimeout(r, CUT * 1000 + 200));
const gainEvents = (c, id) => c.log.filter(e => e.id === id && e.param === 'gain');

/** Everything a node feeds, transitively - i.e. can it still be heard? */
function reaches(node, dest, seen = new Set()) {
  if (node === dest) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return (node.outputs || []).some(o => reaches(o, dest, seen));
}

// ---------------------------------------------------------------
// the cut itself
// ---------------------------------------------------------------

test('silenceAll fades the old master out and then unplugs it', async () => {
  const old = A.master;
  ctx.currentTime = 5;
  silenceAll();

  const fade = gainEvents(ctx, old.id).filter(e => e.time >= 5);
  assert.ok(fade.some(e => e.op === 'exponentialRamp' && e.value <= 1e-4),
    'ramped to silence');
  const end = Math.max(...fade.filter(e => e.op === 'exponentialRamp').map(e => e.time));
  assert.ok(end > 5 && end <= 5 + CUT, 'over the cut, not instantly - that is a click');

  assert.ok(reaches(old, ctx.destination), 'still connected while it fades');
  await settle();
  assert.equal(reaches(old, ctx.destination), false, 'and unplugged afterwards');
});

test('silenceAll leaves a working graph for the next note', () => {
  const old = { master: A.master, pan: A.panBus, drum: A.drumBus };
  silenceAll();
  assert.notEqual(A.master, old.master);
  assert.notEqual(A.panBus, old.pan);
  assert.notEqual(A.drumBus, old.drum);
  assert.ok(reaches(A.panBus, ctx.destination), 'the new pan bus is audible');
  assert.ok(reaches(A.drumBus, ctx.destination), 'and so is the new drum bus');
});

test('a note played after the cut does not go through the retired bus', () => {
  const old = A.master;
  silenceAll();
  ctx.clear();
  scheduleStep(0, 0);                     // a bar of the built-in generator
  const started = ctx.log.filter(e => e.op === 'create').map(e => ctx._nodes.get(e.id));
  assert.ok(started.length, 'the generator did schedule something');
  assert.equal(started.some(n => reaches(n, old, new Set())), false,
    'nothing new feeds the bus that was just retired');
});

// ---------------------------------------------------------------
// switching songs
// ---------------------------------------------------------------

test('loading a MIDI file cuts whatever was playing', () => {
  // The built-in generator was running: its pad chord alone holds for eight
  // bars and stops its oscillators three seconds after that, so without a cut
  // it plays straight through the file that replaces it.
  scheduleStep(0, 0);
  const old = A.master;

  loadParsed(parseMidi(read('map29.mid')), 'map29.mid');

  assert.notEqual(A.master, old, 'the bus the generator is on was retired');
  assert.ok(gainEvents(ctx, old.id).some(e => e.value <= 1e-4), 'and faded out');
});

test('switching from one file to another cuts the first', () => {
  loadParsed(parseMidi(read('map29.mid')), 'map29.mid');
  A.running = true;
  scheduler();                            // schedule some of it for real
  const old = A.master;

  loadParsed(parseMidi(read('D_RUNNIN.mid')), 'D_RUNNIN.mid');

  assert.notEqual(A.master, old);
  assert.ok(gainEvents(ctx, old.id).some(e => e.value <= 1e-4));
  assert.equal(M.name, 'D_RUNNIN.mid');
});

test('going back to the built-in generator cuts the file', async () => {
  const { clearMidi } = await import('../js/midi-store.js');
  globalThis.indexedDB = (await import('./fake-idb.mjs')).fakeIndexedDB();
  loadParsed(parseMidi(read('map29.mid')), 'map29.mid');
  A.running = true;
  scheduler();
  const old = A.master;

  await clearMidi();

  assert.equal(M.active, false);
  assert.notEqual(A.master, old);
  assert.ok(gainEvents(ctx, old.id).some(e => e.value <= 1e-4));
});

test('a song change bumps M.gen so a stale control can be recognised', () => {
  const before = M.gen;
  loadParsed(parseMidi(read('map29.mid')), 'map29.mid');
  assert.equal(M.gen, before + 1);
  loadParsed(parseMidi(read('D_RUNNIN.mid')), 'D_RUNNIN.mid');
  assert.equal(M.gen, before + 2);
});

test('the cut re-bases both schedulers rather than leaving a stale playhead', () => {
  ctx.currentTime = 30;
  A.nextTime = 2;                         // where it was 28 seconds ago
  M.curTime = 2;
  silenceAll();
  assert.ok(A.nextTime >= 30, 'the generator does not dump 28s of missed steps');
  assert.equal(M.curTime, 0, 'and the MIDI scheduler re-bases on its next wake');
});

// ---------------------------------------------------------------
// play / pause
// ---------------------------------------------------------------

test('pause stops the scheduler and cuts the tails with it', async () => {
  startAudio();
  scheduler();
  const old = A.master;
  assert.ok(A.timer, 'the scheduler is running');

  stopAudio();

  assert.equal(A.running, false);
  assert.equal(A.timer, null, 'no further notes are scheduled');
  assert.ok(gainEvents(ctx, old.id).some(e => e.value <= 1e-4),
    'and the notes already scheduled are faded out, not left ringing');
  await settle();
  assert.equal(ctx.state, 'suspended', 'the context is suspended once the fade has run');
});

test('play resumes the phrase instead of restarting it', () => {
  startAudio();
  A.step = 37;
  stopAudio();
  startAudio(false);
  assert.equal(A.running, true);
  assert.equal(A.step, 37, 'picked up where it was paused');
  assert.equal(ctx.state, 'running');
});

test('the button toggles, and reports what the engine is now doing', () => {
  startAudio();
  assert.equal(toggleAudio(), false, 'first tap pauses');
  assert.equal(A.running, false);
  assert.equal(toggleAudio(), true, 'second tap plays');
  assert.equal(A.running, true);
});

test('pausing twice is harmless', () => {
  startAudio();
  stopAudio();
  const master = A.master;
  stopAudio();
  assert.equal(A.master, master, 'the second pause does not retire another bus');
  assert.equal(A.running, false);
});

test('a paused engine schedules nothing even if its timer fires', () => {
  startAudio();
  stopAudio();
  ctx.state = 'running';                  // as it is before suspend() resolves
  ctx.clear();
  scheduler();
  assert.deepEqual(ctx.log.filter(e => e.op === 'start'), [],
    'the tick that was already queued must not sneak a bar out');
});

// The generator's own state is untouched by a pause, so the mix comes back as
// it was rather than at rest.
test('pausing does not disturb the drive state', () => {
  DS.intensity = 0.7;
  startAudio();
  stopAudio();
  assert.equal(DS.intensity, 0.7);
});

test('the pad is forgotten on a cut, so the next chord starts clean', () => {
  padChord(0, { root: 0, tones: [0, 3, 7] }, 4, 1);
  silenceAll();
  ctx.clear();
  // If padNodes still pointed into the retired graph, this would schedule a
  // fade-out on nodes nobody can hear and keep them alive for it.
  padChord(0, { root: 8, tones: [0, 4, 7] }, 4, 1);
  const stops = ctx.log.filter(e => e.op === 'stop');
  assert.ok(stops.every(e => e.time >= 4), 'nothing is being faded out early');
});
