// Does a real drive actually sound like one?
//
// The car test failed: walking with the phone in a pocket produced better music
// than driving. Two reasons, and both are checked here with values a car
// produces rather than with unit impulses.
//
// 1. Forward was hard-coded to the device's +y. In any mount that is not a
//    phone held upright and pointing down the road, acceleration landed on the
//    wrong axis - read as cornering, or cancelled out entirely. Walking shakes
//    every axis at once, so something always registered: hence the pocket
//    beating the mount.
// 2. The speed ladder, which is what brings layers in, had nothing to work
//    from when the device reported no GPS speed, and fell back to a
//    thirty-second average. The arrangement was still making up its mind about
//    the first junction when the trip ended.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as motion from '../js/motion.js';
import { DS, S, CFG } from '../js/motion.js';
import { TIERS, speedMph, tierFor } from '../js/playback.js';
import { MOUNTS, TOWN_DRIVE, runDrive, runWalk } from './drive.mjs';

const MPH = 0.44704;

// The module knows its own initial state; duplicating it here is what let a
// stale field leak between cases.
const reset = () => motion.resetMotion();

beforeEach(reset);

/** The DriveState fields the music reads, at one instant. */
const snap = ({ t, phase, trueSpeed }) => ({
  t, phase, trueSpeed,
  speed: DS.speed, src: DS.speedSrc, calib: DS.calib,
  accel: DS.accel, brake: DS.brake, cornering: DS.cornering,
  intensity: DS.intensity, aggression: DS.aggression, stationary: DS.stationary,
});

const during = (samples, phase) => samples.filter(s => s.phase === phase);
const at = (samples, phase) => samples.find(s => s.phase === phase + ':end');
const peak = (samples, phase, key) => Math.max(...during(samples, phase).map(s => s[key]));

// The real ladder, imported rather than reimplemented: a copy of the rule in
// the test can agree with itself while the app disagrees with both.
const tierOf = s => tierFor((s.speed || 0) / MPH, 0);

// ---------------------------------------------------------------
// the drive itself
// ---------------------------------------------------------------

test('a town drive reads as accelerating, cornering and braking, in that order', () => {
  const { samples } = runDrive(motion, TOWN_DRIVE, { sample: snap });

  assert.ok(peak(samples, 'pull away', 'accel') > 0.4,
    `pulling away should read as acceleration, got ${peak(samples, 'pull away', 'accel')}`);
  assert.equal(peak(samples, 'pull away', 'brake'), 0, 'and not as braking');

  assert.ok(peak(samples, 'corner', 'cornering') > 0.3,
    `a roundabout should read as cornering, got ${peak(samples, 'corner', 'cornering')}`);

  assert.ok(peak(samples, 'brake', 'brake') > 0.4,
    `braking should read as braking, got ${peak(samples, 'brake', 'brake')}`);
  assert.equal(peak(samples, 'brake', 'accel'), 0);
});

test('the mix is full within a couple of seconds of pulling away, not half a minute', () => {
  // This is the complaint. 30 mph is the top of the ladder in town; the layers
  // have to be there while the driver is still in the same street.
  const { samples } = runDrive(motion, TOWN_DRIVE, { sample: snap, sampleEvery: 0.25 });
  const pull = during(samples, 'pull away');

  const past20 = pull.find(s => s.trueSpeed / MPH >= 20);
  assert.ok(past20, 'the drive does reach 20 mph');
  const climbed = pull.find(s => s.t >= past20.t && tierOf(s) >= 2);
  assert.ok(climbed, 'the ladder reaches the 20 mph tier at all');
  assert.ok(climbed.t - past20.t < 2,
    `took ${(climbed.t - past20.t).toFixed(1)}s to answer 20 mph`);

  // 13 m/s is 29.5 mph - a town cruise sits on the 20 mph rung, not above it.
  assert.ok(tierOf(at(samples, 'cruise')) >= 2, 'and stays up at cruising speed');
});

test('a motorway cruise does not decay to a car park', () => {
  // No acceleration at all, by definition. Aggression used to be fed only by
  // acceleration, so the fastest part of a drive read as the calmest.
  const { samples } = runDrive(motion, [
    { name: 'stopped', s: 3, long: 0, lat: 0 },
    { name: 'join',    s: 14, long: 2.4, lat: 0 },   // to 33.6 m/s, a real 75 mph
    { name: 'motorway', s: 40, long: 0, lat: 0 },
  ], { sample: snap });

  const end = at(samples, 'motorway');
  assert.ok(end.speed / MPH > 60, `should be doing motorway speed, got ${(end.speed / MPH).toFixed(0)} mph`);
  assert.equal(end.stationary, false);
  assert.ok(end.aggression > 0.5,
    `sustained speed should read as effort, got ${end.aggression.toFixed(2)}`);
  assert.equal(tierOf(end), TIERS.length - 1, 'and the ladder is flat out');
});

test('stopping at the lights goes to rest, and pulling away comes back', () => {
  const { samples } = runDrive(motion, TOWN_DRIVE, { sample: snap });
  assert.equal(at(samples, 'stopped2').stationary, true, 'at rest after the stop');
  assert.equal(at(samples, 'cruise').stationary, false, 'and not while moving');
});

// ---------------------------------------------------------------
// the mount
// ---------------------------------------------------------------

test('every mount produces the same drive', () => {
  // The whole point. A phone flat on the dash, upright in a cradle, or turned
  // landscape is the same car doing the same things.
  const traces = {};
  for (const name of ['dash', 'cradle', 'landscape']) {
    reset();
    traces[name] = runDrive(motion, TOWN_DRIVE, { mount: MOUNTS[name], sample: snap }).samples;
  }
  const ref = traces.dash;
  for (const name of ['cradle', 'landscape']) {
    const t = traces[name];
    assert.equal(t.length, ref.length);
    // Only once forward has been confirmed. Each mount starts from a different
    // guess, so they disagree while they are still converging on the first pull
    // away - which is honest: nothing can know which way a car points until the
    // car has moved. The claim is that they agree from then on.
    // Plus a couple of seconds for the smoothed values to shed the transient:
    // while landscape was still converging, the pull away was landing on its
    // lateral axis, and cornering has a quarter-second memory.
    const learned = ref.findIndex((s, i) => s.calib === 'learned' && t[i].calib === 'learned');
    assert.ok(learned > 0, `${name} never confirmed forward`);
    const settled = learned + 4;
    for (let i = settled; i < ref.length; i++) {
      for (const k of ['accel', 'brake', 'cornering', 'intensity']) {
        assert.ok(Math.abs(t[i][k] - ref[i][k]) < 0.08,
          `${name} ${ref[i].phase} ${k}: ${t[i][k].toFixed(2)} vs dash ${ref[i][k].toFixed(2)}`);
      }
    }
  }
});

test('a cradle mount would have read almost nothing on the old fixed axes', () => {
  // Standing evidence for why this changed. In a windscreen cradle the car's
  // forward axis is the device's -z, so the +y the old code read is the
  // vertical - it saw bumps, and nothing else.
  const { samples } = runDrive(motion, TOWN_DRIVE, { mount: MOUNTS.cradle, sample: snap });
  assert.ok(peak(samples, 'pull away', 'accel') > 0.4, 'the car frame finds it');

  // What +y actually carried during that phase: gravity is removed from
  // `acceleration`, so the old reading was road noise about zero.
  const m = MOUNTS.cradle;
  assert.equal(m.fwd.y, 0, 'forward has no +y component in this mount at all');
});

test('a phone mounted backwards works it out from GPS instead of asking', () => {
  // This is what the flip buttons were for. Pulling away must read as
  // acceleration even though the mount points the other way.
  const { samples } = runDrive(motion, TOWN_DRIVE, { mount: MOUNTS.backwards, sample: snap });

  assert.equal(at(samples, 'stopped').calib, 'assumed', 'nothing to learn from while parked');
  assert.equal(at(samples, 'cruise').calib, 'learned', 'the first pull away settles it');

  // The learning happens during the pull away, so judge it from the end of it
  // onwards: the corner and the stop must be the right way round.
  assert.ok(peak(samples, 'brake', 'brake') > 0.35,
    `braking still reads as braking, got ${peak(samples, 'brake', 'brake')}`);
  assert.equal(peak(samples, 'brake', 'accel'), 0, 'and never as acceleration');
});

test('bumps are thrown away, not integrated into speed', () => {
  // A rough surface shakes the phone hard vertically and barely at all along
  // the road. Flattening by gravity is what removes it; on the old fixed axes
  // a cradle-mounted phone read those bumps as forward acceleration, which is
  // both a phantom accel and, once integrated, a phantom speed.
  const { samples } = runDrive(motion, [
    { name: 'parked', s: 3,  long: 0, lat: 0, bump: 0 },
    { name: 'rough',  s: 15, long: 0, lat: 0, bump: 4.0 },
  ], { mount: MOUNTS.cradle, road: 0.05, gps: false, sample: snap });

  const end = at(samples, 'rough');
  assert.ok(Math.abs(end.accel) < 1e-9, `bumps read as accel ${end.accel}`);
  assert.ok(Math.abs(end.brake) < 1e-9, `bumps read as brake ${end.brake}`);
  assert.ok((end.speed || 0) < 0.7,
    `15s of bumps integrated into ${(end.speed || 0).toFixed(2)} m/s of phantom speed`);
});

// ---------------------------------------------------------------
// speed without GPS speed
// ---------------------------------------------------------------

test('a device that reports no GPS speed still gets a speed', () => {
  // Plenty of Android hardware never fills coords.speed in. The ladder had
  // nothing to climb with, which is most of why the drive fell flat.
  const { samples } = runDrive(motion, TOWN_DRIVE, { gps: false, sample: snap });
  const cruise = at(samples, 'cruise');

  assert.equal(cruise.src, 'dead', 'dead reckoned from forward acceleration');
  assert.ok(cruise.speed > 0, 'and it is a speed, not a null');
  const err = Math.abs(cruise.speed - cruise.trueSpeed) / cruise.trueSpeed;
  assert.ok(err < 0.35, `estimate ${cruise.speed.toFixed(1)} vs true ${cruise.trueSpeed.toFixed(1)} m/s`);
  assert.ok(tierOf(cruise) >= 2, 'which is enough to bring the layers in');
});

test('a GPS fix corrects the estimate rather than fighting it', () => {
  const { samples } = runDrive(motion, TOWN_DRIVE, { sample: snap });
  for (const s of during(samples, 'cruise')) {
    if (s.speed === null) continue;
    assert.ok(Math.abs(s.speed - s.trueSpeed) < 1.5,
      `${s.phase} @${s.t.toFixed(1)}s: ${s.speed.toFixed(1)} vs ${s.trueSpeed.toFixed(1)} m/s`);
  }
});

test('a stale fix is not treated as current', () => {
  // Into a tunnel: the last thing GPS said was 30 m/s, ten seconds ago.
  runDrive(motion, [{ name: 'a', s: 8, long: 2.5, lat: 0 }], { gps: false });
  motion.onFix({ speed: 30, t: 0 });
  runDrive(motion, [{ name: 'b', s: 6, long: 0, lat: 0 }], { gps: false });
  assert.notEqual(DS.speedSrc, 'gps', 'a fix from the start of the drive is not news');
});

// ---------------------------------------------------------------
// walking
// ---------------------------------------------------------------

test('walking does not read as a motorway', () => {
  // The original complaint in reverse: a pocket produced a fuller mix than a
  // car. It should produce a modest one - it is a walk.
  const samples = runWalk(motion, 30, { sample: snap });
  const end = samples[samples.length - 1];
  assert.ok(tierOf(end) <= 1, `walking reached tier ${tierOf(end)}`);
  assert.ok(end.speed < 3, `walking speed ${end.speed} m/s`);
});

test('walking is not mistaken for a stationary car either', () => {
  const samples = runWalk(motion, 30, { sample: snap });
  const end = samples[samples.length - 1];
  assert.equal(end.stationary, false, 'it is moving, so the pad is not alone');
});

test('a walk and a drive at the same speed are not the same thing', () => {
  const walk = runWalk(motion, 30, { sample: snap });
  reset();
  const drive = runDrive(motion, [
    { name: 'stopped', s: 3, long: 0, lat: 0 },
    { name: 'go', s: 8, long: 2.2, lat: 0 },
    { name: 'cruise', s: 20, long: 0, lat: 0 },
  ], { sample: snap }).samples;

  const w = walk[walk.length - 1], d = at(drive, 'cruise');
  assert.ok(tierOf(d) > tierOf(w),
    `driving (tier ${tierOf(d)}) must outrank walking (tier ${tierOf(w)})`);
});
