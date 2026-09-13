// How long between the foot going down and the music answering?
//
// This is the one thing about the app a driver judges instantly, and it is the
// sum of a chain nobody can see: the sensor low-pass, the intensity smoothing,
// the applyMapping tick, the master filter's own glide, the rest fade, and the
// speed ladder's per-layer ramp. Each was defensible on its own and together
// they came to the better part of two seconds.
//
// So the latency is measured here rather than argued about: drive, and time
// how long until the thing a driver would actually hear has moved.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAudioContext } from './fake-audio.mjs';
import { A, RESP, applyMapping, initAudio } from '../js/engine.js';
import * as motion from '../js/motion.js';
import { DS } from '../js/motion.js';
import { M } from '../js/midi.js';
import { updateRoleGains } from '../js/playback.js';
import { MOUNTS } from './drive.mjs';

const HZ = 50, DT = 1 / HZ;
const MAP_HZ = 25;                       // what ui.js installs

let ctx;
beforeEach(() => {
  ctx = new FakeAudioContext();
  initAudio(ctx);
  motion.resetMotion();
  A.running = true; A.bpm = 112; A.rest = 1; A.tier = 0; A.lastMap = 0;
  A.scale = 'minor'; A.feel = 'straight'; A.pendingFeel = 'straight';
  for (const k in M.roleGain) M.roleGain[k] = k === 'pad' ? 1 : 0;
});

const G = 9.81;
const mount = MOUNTS.dash;                // up +z, forward +y, left -x
const scale = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

/**
 * Drive for `seconds` at a given forward acceleration and speed, running both
 * the sensor pipeline at 50Hz and applyMapping at 25Hz against a clock that
 * actually advances - which is the only way the time-based smoothing can be
 * measured at all.
 *
 * `watch` is sampled every motion event; the returned rows carry the elapsed
 * time so a threshold crossing can be read straight off.
 */
function drive(seconds, { long = 0, speed = 0, watch }, state = { t: 0, nextMap: 0 }) {
  const rows = [];
  const end = state.t + seconds;
  while (state.t < end) {
    const a = scale(mount.fwd, long);
    ctx.currentTime = state.t;
    motion.onFix({ speed, t: state.t * 1000 });
    motion.onMotion({
      acceleration: a,
      accelerationIncludingGravity: add(a, scale(mount.up, G)),
    }, state.t * 1000);

    if (state.t >= state.nextMap) {
      applyMapping();
      state.nextMap += 1 / MAP_HZ;
    }
    rows.push({ t: state.t, v: watch() });
    state.t += DT;
  }
  return rows;
}

/** Seconds from the start of `rows` until `v` first passes `frac` of its range. */
function timeTo(rows, frac) {
  const from = rows[0].v, to = rows[rows.length - 1].v;
  const target = from + (to - from) * frac;
  const hit = rows.find(r => (to > from ? r.v >= target : r.v <= target));
  return hit ? hit.t - rows[0].t : Infinity;
}

// The cutoff is exponential in intensity (340 * 38^i) and hearing is roughly
// logarithmic in frequency, so half of a filter sweep is half of its log, not
// half of its hertz. Measuring the hertz would put "halfway" long past where a
// driver hears it as halfway.
const cutoff = () => Math.log(A.lp.frequency.value);

// ---------------------------------------------------------------

test('the filter answers the throttle inside a fifth of a second', () => {
  // Already rolling, so this is throttle response and nothing else: the master
  // cutoff is the fastest channel and the one a driver reads as "it noticed".
  const state = { t: 0, nextMap: 0 };
  drive(6, { long: 0, speed: 12, watch: cutoff }, state);     // settled, cruising
  const rows = drive(2.5, { long: 3.5, speed: 14, watch: cutoff }, state);

  const t50 = timeTo(rows, 0.5);
  assert.ok(t50 < 0.2, `half the filter move took ${t50.toFixed(2)}s`);
  assert.ok(timeTo(rows, 0.9) < 0.6, 'and it is essentially there inside a second');
});

test('pulling away from a standstill is slower, because the band has to return', () => {
  // Two things at once here - the filter opening and the arrangement coming
  // back - so this is the honest worst case, not the throttle number above.
  const state = { t: 0, nextMap: 0 };
  drive(5, { long: 0, speed: 0, watch: cutoff }, state);
  const rows = drive(3, { long: 2.5, speed: 9, watch: cutoff }, state);
  assert.ok(timeTo(rows, 0.5) < 0.5,
    `half the move took ${timeTo(rows, 0.5).toFixed(2)}s from a standing start`);
});

test('intensity itself is most of that, and it is quick', () => {
  const state = { t: 0, nextMap: 0 };
  drive(4, { long: 0, speed: 0, watch: () => DS.intensity }, state);
  const rows = drive(2, { long: 3.5, speed: 12, watch: () => DS.intensity }, state);
  const t50 = timeTo(rows, 0.5);
  assert.ok(t50 < 0.2, `intensity took ${t50.toFixed(2)}s to get halfway`);
});

test('but it does not chatter on the way back down', () => {
  // The reason the rise and the fall are not the same number: a pothole should
  // not flap the filter shut. Coming down is deliberately slower than going up.
  const state = { t: 0, nextMap: 0 };
  drive(4, { long: 3.5, speed: 12, watch: () => DS.intensity }, state);
  const rows = drive(3, { long: 0, speed: 12, watch: () => DS.intensity }, state);
  const t50 = timeTo(rows, 0.5);
  assert.ok(t50 > 0.3, `the decay is ${t50.toFixed(2)}s, which is too twitchy`);
  assert.ok(t50 < 1.2, `but ${t50.toFixed(2)}s is sluggish`);
});

test('pulling away brings the band back in well under a second', () => {
  const state = { t: 0, nextMap: 0 };
  drive(6, { long: 0, speed: 0, watch: () => A.rest }, state);
  assert.ok(A.rest > 0.9, 'at rest at the lights');
  assert.equal(DS.stationary, true);

  const rows = drive(3, { long: 2.5, speed: 9, watch: () => A.rest }, state);
  const t50 = timeTo(rows, 0.5);
  assert.ok(t50 < 0.6, `the band took ${t50.toFixed(2)}s to start coming back`);
});

test('stopping fades out gently rather than cutting the arrangement off', () => {
  const state = { t: 0, nextMap: 0 };
  drive(8, { long: 1.5, speed: 14, watch: () => A.rest }, state);
  assert.ok(A.rest < 0.1, 'full band while moving');
  const rows = drive(8, { long: 0, speed: 0, watch: () => A.rest }, state);
  const t50 = timeTo(rows, 0.5);
  assert.ok(t50 > 1.5, `the mix collapsed in ${t50.toFixed(2)}s - that reads as a fault`);
});

test('a layer the speed ladder wins arrives in about a quarter second', () => {
  // The ladder decides instantly; what a driver hears is the ramp behind it.
  // updateRoleGains re-reads the tier from the speed every call, so the speed
  // has to be there or the rung it is being asked about is not won at all.
  DS.speed = 35; DS.stationary = false;
  M.roleGain.lead = 0;
  A.rest = 0; A.tier = 4; A.feel = 'straight';
  let t = 0;
  const rows = [];
  while (t < 2) {
    updateRoleGains(1 / MAP_HZ);
    rows.push({ t, v: M.roleGain.lead });
    t += 1 / MAP_HZ;
  }
  const t50 = timeTo(rows, 0.5);
  assert.ok(t50 < 0.3, `the lead took ${t50.toFixed(2)}s to arrive`);
  assert.ok(rows[rows.length - 1].v > 0.95, 'and it does get all the way there');
});

test('a layer it loses takes longer to go than it did to arrive', () => {
  A.rest = 0;
  M.roleGain.lead = 1;
  DS.speed = 2; DS.stationary = false;      // back to walking pace: lead is out
  A.tier = 4;
  const rows = [];
  let t = 0;
  while (t < 3) {
    updateRoleGains(1 / MAP_HZ);
    rows.push({ t, v: M.roleGain.lead });
    t += 1 / MAP_HZ;
  }
  assert.ok(timeTo(rows, 0.5) > 0.4, 'a part vanishing quickly sounds like a dropout');
});

// ---------------------------------------------------------------

test('the response constants do not depend on how often the UI ticks', () => {
  // They used to: each was a fraction applied per call, so the feel of the car
  // was set by a setInterval argument in another file. Running the same drive
  // at two different tick rates must give the same answer.
  const at = hz => {
    ctx = new FakeAudioContext();
    initAudio(ctx);
    motion.resetMotion();
    A.running = true; A.rest = 1; A.lastMap = 0; A.tier = 0;
    let t = 0, nextMap = 0;
    while (t < 2) {
      const a = scale(mount.fwd, 3);
      ctx.currentTime = t;
      motion.onFix({ speed: 12, t: t * 1000 });
      motion.onMotion({ acceleration: a,
        accelerationIncludingGravity: add(a, scale(mount.up, G)) }, t * 1000);
      if (t >= nextMap) { applyMapping(); nextMap += 1 / hz; }
      t += DT;
    }
    return A.rest;
  };
  const slow = at(10), fast = at(50);
  assert.ok(Math.abs(slow - fast) < 0.05,
    `rest reached ${slow.toFixed(3)} at 10Hz but ${fast.toFixed(3)} at 50Hz`);
});

test('a tab that was asleep does not teleport the mix on its first wake', () => {
  // dt is real elapsed time now, so a minute-long gap would otherwise apply a
  // minute of smoothing in one step.
  A.rest = 1; A.lastMap = 0;
  DS.stationary = false;
  ctx.currentTime = 60;
  applyMapping();
  assert.ok(A.rest > 0.8, `one wake after a minute away moved rest to ${A.rest.toFixed(2)}`);
});
