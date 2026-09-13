// The drive recorder, and the replay that reads it back.
//
// The whole value of a log is that replaying it reproduces the drive. If the
// writer and the reader disagree by so much as a column, a recorded drive is
// evidence for nothing - so the round trip is the test: run a simulated drive
// live, record it, replay the file, and require the same DriveState out.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as motion from '../js/motion.js';
import { DS } from '../js/motion.js';
import { REC, recFix, recMark, recMotion, recSummary, recText, startRec, stopRec } from '../js/recorder.js';
import { parseLog, replay } from './replay.mjs';
import { MOUNTS, TOWN_DRIVE, runDrive } from './drive.mjs';

beforeEach(() => { motion.resetMotion(); startRec(); stopRec(); });

/** A recording wrapper around motion, so runDrive writes a log as it drives. */
const recording = {
  onMotion: (e, t) => { recMotion(e, t); motion.onMotion(e, t); },
  onFix: ({ speed, t }) => { recFix({ speed, heading: null, accuracy: 5 }, t); motion.onFix({ speed, t }); },
};

function recordTownDrive(opts = {}) {
  motion.resetMotion();
  startRec({ ua: 'test' });
  const live = runDrive(recording, TOWN_DRIVE, { sample: () => ({ ...DS }), ...opts });
  stopRec();
  return { text: recText(), live };
}

test('a recorded drive replays to the same drive', () => {
  const { text, live } = recordTownDrive();
  const { trace } = replay(parseLog(text), { every: 0.5 });

  // Same endpoint, to the rounding the log applies (three decimals on every
  // acceleration, which is far finer than the deadband).
  const last = live.samples[live.samples.length - 1];
  const end = trace[trace.length - 1];
  for (const k of ['accel', 'brake', 'cornering', 'intensity', 'aggression']) {
    assert.ok(Math.abs(end[k] - last[k]) < 0.02,
      `${k}: replayed ${end[k].toFixed(3)} vs live ${last[k].toFixed(3)}`);
  }
  assert.ok(Math.abs(end.speed - last.speed) < 0.2, 'and the same speed');
  assert.equal(end.calib, last.calib, 'and the same idea of where forward is');
});

test('the log carries gravity, or the car frame cannot be rebuilt', () => {
  // acceleration alone cannot say which way up the phone is, and without that
  // there is no road plane and no forward - the log would be unusable for the
  // one thing it is for.
  const { text } = recordTownDrive();
  const { events } = parseLog(text);
  const m = events.filter(e => e.kind === 'm');
  assert.ok(m.length > 100);
  assert.ok(m.every(e => e.ag && typeof e.ag.y === 'number'), 'every sample has both vectors');
});

test('a device that reports no gravity still produces a readable log', () => {
  const { text } = recordTownDrive({ gravity: false });
  const { events } = parseLog(text);
  const m = events.filter(e => e.kind === 'm');
  assert.ok(m.length > 100);
  assert.ok(m.every(e => e.ag === null), 'the gravity columns are simply blank');
  // And it replays - on the device axes, which is all such a device can offer.
  const { trace } = replay(parseLog(text), { every: 1 });
  assert.equal(trace[trace.length - 1].calib, 'device');
});

test('GPS fixes survive the round trip', () => {
  const { text } = recordTownDrive();
  const { events } = parseLog(text);
  const g = events.filter(e => e.kind === 'g');
  assert.ok(g.length >= 30, `expected a fix a second over a 39s drive, got ${g.length}`);
  assert.ok(g.some(e => e.speed > 10), 'including the fast part');
});

test('marks land where they were pressed', () => {
  motion.resetMotion();
  startRec();
  runDrive(recording, [{ name: 'a', s: 4, long: 2, lat: 0 }]);
  recMark('the roundabout', 4000);
  runDrive(recording, [{ name: 'b', s: 4, long: 0, lat: 0 }]);
  stopRec();

  const { marks } = replay(parseLog(recText()), {});
  assert.equal(marks.length, 1);
  assert.equal(marks[0].label, 'the roundabout');
  assert.ok(Math.abs(marks[0].t - 4) < 0.5, `mark at ${marks[0].t}s`);
});

test('a comma in a mark cannot break the column count', () => {
  startRec();
  recMotion({ acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 } }, 0);
  recMark('roundabout, third exit\nand a newline', 100);
  stopRec();
  const { marks } = replay(parseLog(recText()), {});
  assert.equal(marks.length, 1);
  assert.ok(!/[\r\n]/.test(marks[0].label));
  assert.ok(recText().split('\n').filter(l => l.startsWith('k,')).length === 1, 'still one row');
});

// ---------------------------------------------------------------
// what the log does and does not contain
// ---------------------------------------------------------------

test('location is left out unless it was asked for', () => {
  startRec();
  REC.withPosition = false;
  recFix({ speed: 12, heading: 90, accuracy: 5, latitude: 51.5074, longitude: -0.1278 }, 0);
  stopRec();
  const text = recText();
  assert.ok(!text.includes('51.5074'), 'no latitude');
  assert.ok(!text.includes('-0.1278'), 'no longitude');
  assert.ok(text.includes('12'), 'but the speed is there, which is what calibration needs');
});

test('location is included when it is', () => {
  startRec();
  REC.withPosition = true;
  recFix({ speed: 12, heading: 90, accuracy: 5, latitude: 51.5074, longitude: -0.1278 }, 0);
  stopRec();
  assert.match(recText(), /51\.5074/);
  REC.withPosition = false;
});

test('recording stops at the size limit rather than eating the phone', () => {
  startRec();
  const e = { acceleration: { x: 1, y: 2, z: 3 }, accelerationIncludingGravity: { x: 1, y: 2, z: 13 } };
  // Cheaper than the real 150000: push past the cap by reusing the counter.
  for (let i = 0; i < 200; i++) recMotion(e, i * 20);
  const before = recSummary().rows;
  REC.rows.length = 150000;                 // stand at the cap
  recMotion(e, 4000);
  assert.equal(REC.on, false, 'it stops');
  assert.equal(REC.full, true, 'and says why');
  assert.match(recText(), /TRUNCATED/);
  assert.ok(before > 0);
});

test('nothing is written when the recorder is off', () => {
  stopRec();
  const e = { acceleration: { x: 1, y: 2, z: 3 }, accelerationIncludingGravity: null };
  const before = recSummary().rows;
  recMotion(e, 0); recFix({ speed: 1 }, 0); recMark('x', 0);
  assert.equal(recSummary().rows, before);
});

test('a log is timed from its first sample, not from the epoch', () => {
  // performance.now() is whatever it is when Start was pressed; a log that
  // began at 4318572ms is harder to read and no more informative.
  startRec();
  const e = { acceleration: { x: 0, y: 1, z: 0 }, accelerationIncludingGravity: { x: 0, y: 1, z: 9.8 } };
  recMotion(e, 4318572);
  recMotion(e, 4318592);
  stopRec();
  const { events } = parseLog(recText());
  assert.equal(events[0].t, 0);
  assert.equal(events[1].t, 20);
});

test('the summary counts what the driver is watching', () => {
  motion.resetMotion();
  startRec();
  runDrive(recording, [{ name: 'a', s: 10, long: 1.5, lat: 0 }]);
  recMark('here', 5000);
  stopRec();
  const s = recSummary();
  assert.ok(s.motion > 400, `${s.motion} samples over 10s at 50Hz`);
  assert.ok(s.fixes >= 9, `${s.fixes} fixes`);
  assert.equal(s.marks, 1);
  assert.ok(Math.abs(s.seconds - 10) < 0.5);
  assert.ok(s.bytes > 0);
});
