// DriveState, driven by a synthetic accelerometer at an exact event rate.
//
// Nothing here could run before the split: CFG read localStorage at import time,
// so importing the module outside a browser threw.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DS, S, CFG, onMotion } from '../js/motion.js';

const HZ = 60, DT = 1000 / HZ;

/** Feed `seconds` of motion at a fixed longitudinal/lateral acceleration. */
function drive(seconds, { long = 0, lat = 0, gps = null } = {}) {
  S.gps.speed = gps;
  const n = Math.round(seconds * HZ);
  for (let i = 0; i < n; i++) {
    S.lastT = S.lastT || 0;
    const t = (S._t = (S._t || 0) + DT);
    onMotion({ acceleration: { x: lat, y: long, z: 0 }, accelerationIncludingGravity: null }, t);
  }
}

function reset() {
  Object.assign(DS, {
    speed: null, aLong: 0, aLat: 0, jerk: 0, intensity: 0, aggression: 0,
    cornering: 0, accel: 0, brake: 0, stationary: true,
  });
  Object.assign(S, {
    started: false, t0: 0, lastT: 0, count: 0, dropped: 0, rate: 0,
    f: { x: 0, y: 0, z: 0 }, grav: { x: 0, y: 0, z: 0 }, gravInit: false,
    prevLong: 0, stillSince: 0, gps: { speed: null, status: 'idle' }, _t: 0,
  });
  CFG.signFwd = 1; CFG.signLat = 1;
}

beforeEach(reset);

test('a stationary car produces no intensity', () => {
  drive(5);
  assert.equal(Math.abs(DS.intensity), 0);
  assert.equal(Math.abs(DS.accel), 0);
  assert.equal(Math.abs(DS.brake), 0);
});

test('small vibration is swallowed by the deadband', () => {
  drive(3, { long: 0.3 });      // below DEADBAND = 0.4
  assert.equal(Math.abs(DS.aLong), 0);
  assert.equal(Math.abs(DS.intensity), 0);
});

test('sustained acceleration raises intensity and reads as accel, not brake', () => {
  drive(4, { long: 3 });
  assert.ok(DS.intensity > 0.3, `intensity ${DS.intensity}`);
  assert.ok(DS.accel > 0.4, `accel ${DS.accel}`);
  assert.equal(Math.abs(DS.brake), 0);
});

test('braking is asymmetric - the same magnitude reads lower than acceleration', () => {
  drive(4, { long: 4 });
  const accel = DS.accel;
  reset();
  drive(4, { long: -4 });
  assert.ok(DS.brake > 0, 'braking detected');
  assert.ok(DS.brake < accel, `brake ${DS.brake} < accel ${accel} for equal force`);
  assert.equal(Math.abs(DS.accel), 0);
});

test('the forward sign flip reverses accel and brake', () => {
  drive(4, { long: 4 });
  const accel = DS.accel;
  reset();
  CFG.signFwd = -1;
  drive(4, { long: 4 });
  assert.equal(Math.abs(DS.accel), 0);
  assert.ok(Math.abs(DS.brake) > 0, 'flipped: now reads as braking');
  assert.ok(accel > 0);
});

test('cornering rises with lateral force only', () => {
  drive(6, { lat: 4 });
  assert.ok(DS.cornering > 0.2, `cornering ${DS.cornering}`);
  assert.equal(Math.abs(DS.accel), 0);
  assert.equal(Math.abs(DS.brake), 0);
});

test('events arriving slower than MAX_DT are dropped, not integrated', () => {
  const before = S.dropped;
  onMotion({ acceleration: { x: 0, y: 5, z: 0 }, accelerationIncludingGravity: null }, 1000);
  onMotion({ acceleration: { x: 0, y: 5, z: 0 }, accelerationIncludingGravity: null }, 1500);
  assert.ok(S.dropped > before, 'a 500ms gap counts as dropped');
});

test('a null acceleration reading is ignored', () => {
  onMotion({ acceleration: null, accelerationIncludingGravity: null }, 100);
  onMotion({ acceleration: { x: null, y: null, z: null } }, 200);
  assert.equal(S.count, 0);
});

test('GPS speed decides stationary, overriding the accelerometer', () => {
  // Moving steadily at 30 m/s: the accelerometer reads nothing, but the car is
  // very much not stationary. This is the motorway case.
  drive(5, { gps: 30 });
  assert.equal(DS.stationary, false);
  assert.equal(DS.speed, 30);

  reset();
  drive(5, { gps: 0 });
  assert.equal(DS.stationary, true, 'stopped at lights after 3s');
});

test('aggression is slow and intensity is fast', () => {
  drive(2, { long: 5 });
  assert.ok(DS.intensity > DS.aggression * 2,
    `intensity ${DS.intensity} should outrun aggression ${DS.aggression} early on`);
});
