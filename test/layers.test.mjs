// The speed ladder: which layers are audible at which speed.
//
// This is the behaviour HANDOVER.md warns about - gating on acceleration alone
// empties the mix on a motorway, because a steady 70 mph reads as nothing on
// the accelerometer. Every case below holds acceleration at zero on purpose.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DS } from '../js/motion.js';
import { M } from '../js/midi.js';
import { A } from '../js/engine.js';
import { updateRoleGains } from '../js/playback.js';

const MPH = 0.44704;

/** Hold a steady speed until the gains settle, and report them. */
function cruise(mph, { ticks = 400, feel = 'straight' } = {}) {
  DS.speed = mph * MPH;
  DS.stationary = mph < 1;
  DS.intensity = 0;            // steady speed: the accelerometer sees nothing
  DS.aggression = 0;
  A.feel = feel;
  A.rest = DS.stationary ? 1 : 0;
  for (let i = 0; i < ticks; i++) updateRoleGains();
  return { ...M.roleGain, tier: A.tier };
}

const audible = (g, role) => g[role] > 0.5;
const silent = (g, role) => g[role] < 0.05;

beforeEach(() => {
  A.tier = 0;
  A.rest = 1;
  A.feel = 'straight';
  for (const k in M.roleGain) M.roleGain[k] = 0;
  M.roleGain.pad = 1;
});

test('stopped: the pad alone survives', () => {
  const g = cruise(0);
  assert.equal(g.tier, 0);
  assert.ok(audible(g, 'pad'), 'pad holds a red light');
  for (const r of ['bass', 'drums', 'keys', 'lead']) {
    assert.ok(silent(g, r), `${r} is silent when stopped (got ${g[r]})`);
  }
});

test('10 mph is a whole song: pad, bass and drums', () => {
  const g = cruise(12);
  assert.equal(g.tier, 1);
  for (const r of ['pad', 'bass', 'drums']) {
    assert.ok(audible(g, r), `${r} is playing at 10 mph (got ${g[r]})`);
  }
  assert.ok(silent(g, 'keys'), 'keys wait for 20');
  assert.ok(silent(g, 'lead'), 'lead waits for 30');
});

test('20 mph adds keys', () => {
  const g = cruise(22);
  assert.equal(g.tier, 2);
  assert.ok(audible(g, 'keys'), 'keys in at 20');
  assert.ok(silent(g, 'lead'), 'lead still out');
});

test('30 mph adds the lead', () => {
  const g = cruise(32);
  assert.equal(g.tier, 3);
  for (const r of ['pad', 'bass', 'drums', 'keys', 'lead']) {
    assert.ok(audible(g, r), `${r} is playing at 30 mph (got ${g[r]})`);
  }
});

test('70 mph is the full band, with no half-feel thinning of the drums', () => {
  const thinned = cruise(50, { feel: 'half' });
  assert.equal(thinned.tier, 3);
  const full = cruise(75, { feel: 'half' });
  assert.equal(full.tier, 4);
  assert.ok(full.drums > thinned.drums,
    `drums open up flat out (${full.drums} > ${thinned.drums})`);
  assert.ok(full.drums > 0.9, 'drums at full');
});

test('every breakpoint adds a layer and never takes one away', () => {
  let prev = null;
  for (const mph of [0, 12, 22, 32, 75]) {
    const g = cruise(mph);
    const on = ['pad', 'bass', 'drums', 'keys', 'lead'].filter(r => audible(g, r));
    if (prev) {
      assert.ok(on.length >= prev.length, `${mph} mph has at least as many layers`);
      for (const r of prev) assert.ok(on.includes(r), `${r} kept at ${mph} mph`);
    }
    prev = on;
  }
});

test('a motorway cruise keeps the full mix with zero acceleration', () => {
  const g = cruise(70);
  assert.equal(DS.intensity, 0, 'the accelerometer really does read nothing');
  assert.ok(audible(g, 'lead'), 'the mix does not empty out at speed');
  assert.ok(audible(g, 'keys'));
});

test('hovering on a breakpoint does not flicker the mix', () => {
  cruise(22);                       // settled at tier 2
  assert.equal(A.tier, 2);
  cruise(19.5, { ticks: 5 });       // a whisker below 20
  assert.equal(A.tier, 2, 'hysteresis holds the layer');
  cruise(17, { ticks: 5 });         // properly below
  assert.equal(A.tier, 1, 'dropped once clear of the breakpoint');
});

test('without GPS, sustained aggression stands in for speed', () => {
  DS.speed = null;
  DS.stationary = false;
  DS.intensity = 0;
  DS.aggression = 0.5;              // ~35 mph equivalent
  A.rest = 0;
  A.tier = 0;
  for (let i = 0; i < 400; i++) updateRoleGains();
  assert.ok(A.tier >= 3, `hard driving without GPS still opens the mix (tier ${A.tier})`);
});
