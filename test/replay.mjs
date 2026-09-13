#!/usr/bin/env node
// Replay a recorded drive through motion.js and report on it.
//
//   npm run replay -- path/to/drivebeats-20260913-1042.csv
//   npm run replay -- log.csv --csv out.csv     also dump the derived trace
//   npm run replay -- log.csv --at 412          zoom in on one moment, seconds
//
// The point is to answer questions about a formula with a drive that happened
// rather than with a guess at one: did the car frame settle, and how long did
// it take; is dead-reckoned speed anywhere near the GPS; which rung of the
// layer ladder was the mix on, minute by minute; did anything read as a corner
// that was not one.

import fs from 'node:fs';
import * as motion from '../js/motion.js';
import { DS, S } from '../js/motion.js';
import { TIERS, tierFor } from '../js/playback.js';

const MPH = 0.44704;

// ---- the log ----------------------------------------------------

export function parseLog(text) {
  const meta = {}, events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line[0] === '#') {
      for (const m of line.matchAll(/(\w+)=(\S+)/g)) meta[m[1]] = m[2];
      continue;
    }
    const p = line.split(',');
    const t = +p[1];
    if (!isFinite(t)) continue;
    const num = i => (p[i] === '' || p[i] === undefined ? null : +p[i]);
    if (p[0] === 'm') {
      events.push({ kind: 'm', t,
        a: { x: num(2), y: num(3), z: num(4) },
        ag: num(5) === null ? null : { x: num(5), y: num(6), z: num(7) } });
    } else if (p[0] === 'g') {
      events.push({ kind: 'g', t, speed: num(2), heading: num(3), accuracy: num(4),
                    lat: num(5), lon: num(6) });
    } else if (p[0] === 'k') {
      events.push({ kind: 'k', t, label: p.slice(2).join(',') });
    }
  }
  events.sort((a, b) => a.t - b.t);
  return { meta, events };
}

// ---- the replay -------------------------------------------------

/**
 * Feed a parsed log through motion.js, sampling DriveState as it goes.
 * Returns one row per `every` seconds, plus the marks.
 */
export function replay({ events }, { every = 1 } = {}) {
  motion.resetMotion();
  const trace = [], marks = [];
  let nextSample = 0, lastGps = null;

  for (const e of events) {
    if (e.kind === 'm') {
      motion.onMotion({ acceleration: e.a, accelerationIncludingGravity: e.ag }, e.t);
    } else if (e.kind === 'g') {
      motion.onFix({ speed: e.speed, heading: e.heading, t: e.t });
      lastGps = e.speed;
    } else if (e.kind === 'k') {
      marks.push({ t: e.t / 1000, label: e.label });
      continue;
    }
    if (e.t / 1000 >= nextSample) {
      trace.push({
        t: +(e.t / 1000).toFixed(1),
        gps: lastGps,
        speed: DS.speed, src: DS.speedSrc, calib: DS.calib, conf: S.fwdConf,
        est: S.estSpeed,
        aLong: DS.aLong, aLat: DS.aLat,
        accel: DS.accel, brake: DS.brake, cornering: DS.cornering,
        intensity: DS.intensity, aggression: DS.aggression,
        stationary: DS.stationary,
        tier: tierFor((DS.speed || 0) / MPH, 0),
      });
      nextSample += every;
    }
  }
  return { trace, marks };
}

// ---- the report -------------------------------------------------

const pc = (xs, q) => {
  const s = xs.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const f = (v, n = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(n) : '—');

function report({ meta, events }, { trace, marks }) {
  const motionEvents = events.filter(e => e.kind === 'm');
  const fixes = events.filter(e => e.kind === 'g');
  const span = events.length ? events[events.length - 1].t / 1000 : 0;
  const withGrav = motionEvents.filter(e => e.ag).length;

  const out = [];
  const say = (...a) => out.push(a.join(' '));

  say('# the log');
  for (const k of Object.keys(meta)) say('   ', k + ':', meta[k]);
  say('    duration:', f(span, 0) + 's', '(' + f(span / 60, 1) + ' min)');
  say('    motion events:', motionEvents.length,
      '(' + f(motionEvents.length / span, 0) + ' Hz)');
  say('    with gravity:', withGrav,
      withGrav === motionEvents.length ? '(all — the car frame is usable)'
        : withGrav === 0 ? '(NONE — this device reports no gravity, so the car frame cannot be built)'
        : '(partial)');
  say('    GPS fixes:', fixes.length,
      fixes.length ? '(one every ' + f(span / fixes.length, 1) + 's)' : '(none)');
  const named = fixes.filter(x => x.speed !== null).length;
  say('    fixes carrying speed:', named + '/' + fixes.length,
      named === 0 ? '(device never reports speed — dead reckoning is all there is)' : '');

  // --- the car frame ---
  say('');
  say('# the car frame');
  const learned = trace.find(r => r.calib === 'learned');
  say('    settled:', learned ? 'after ' + f(learned.t, 0) + 's' : 'NEVER (forward stayed a guess)');
  say('    confidence at the end:', f(trace.length ? trace[trace.length - 1].conf : 0));

  // --- speed ---
  say('');
  say('# speed');
  const bySrc = {};
  for (const r of trace) bySrc[r.src] = (bySrc[r.src] || 0) + 1;
  say('    where it came from:', Object.entries(bySrc)
    .map(([k, v]) => k + ' ' + f(100 * v / trace.length, 0) + '%').join(', '));
  const paired = trace.filter(r => r.gps !== null && r.gps > 1 && isFinite(r.est));
  if (paired.length) {
    const err = paired.map(r => Math.abs(r.est - r.gps));
    say('    dead reckoning vs GPS:',
        'median', f(pc(err, 0.5)) + ' m/s,',
        '90th', f(pc(err, 0.9)) + ' m/s',
        '(over ' + paired.length + ' samples above 1 m/s)');
  }
  const top = Math.max(...trace.map(r => r.speed || 0));
  say('    top speed:', f(top * 3.6, 0) + ' km/h', '(' + f(top / MPH, 0) + ' mph)');

  // --- what the music did ---
  say('');
  say('# what the music was told');
  const tiers = new Array(TIERS.length).fill(0);
  for (const r of trace) tiers[r.tier]++;
  TIERS.forEach((t, i) => say('    tier ' + i, '(' + t.mph + '+ mph):',
    f(100 * tiers[i] / trace.length, 0) + '% of the drive',
    '— ' + t.roles.join(', ')));
  say('    stationary:', f(100 * trace.filter(r => r.stationary).length / trace.length, 0) + '%');
  say('    intensity  median', f(pc(trace.map(r => r.intensity), 0.5)),
      ' 90th', f(pc(trace.map(r => r.intensity), 0.9)),
      ' max', f(Math.max(...trace.map(r => r.intensity))));
  say('    aggression median', f(pc(trace.map(r => r.aggression), 0.5)),
      ' 90th', f(pc(trace.map(r => r.aggression), 0.9)));
  say('    cornering  90th', f(pc(trace.map(r => r.cornering), 0.9)),
      ' max', f(Math.max(...trace.map(r => r.cornering))));
  say('    accel      90th', f(pc(trace.map(r => r.accel), 0.9)),
      ' max', f(Math.max(...trace.map(r => r.accel))));
  say('    brake      90th', f(pc(trace.map(r => r.brake), 0.9)),
      ' max', f(Math.max(...trace.map(r => r.brake))));

  // Saturation is the tell that a divisor is wrong: a value pinned at 1 has
  // stopped carrying information about the drive.
  const pinned = k => 100 * trace.filter(r => r[k] > 0.98).length / trace.length;
  say('    pinned at 1.0:',
      ['intensity', 'accel', 'brake', 'cornering', 'aggression']
        .map(k => k + ' ' + f(pinned(k), 0) + '%').join(', '));
  const dead = k => 100 * trace.filter(r => r[k] < 0.02).length / trace.length;
  say('    sitting at 0.0:',
      ['intensity', 'accel', 'brake', 'cornering', 'aggression']
        .map(k => k + ' ' + f(dead(k), 0) + '%').join(', '));

  // --- the marks ---
  if (marks.length) {
    say('');
    say('# marks');
    for (const m of marks) {
      const near = trace.filter(r => Math.abs(r.t - m.t) <= 5);
      say('   ', f(m.t, 0) + 's', '"' + m.label + '"',
          '— speed', f(Math.max(...near.map(r => r.speed || 0)) * 3.6, 0) + ' km/h,',
          'accel', f(Math.max(...near.map(r => r.accel))) + ',',
          'brake', f(Math.max(...near.map(r => r.brake))) + ',',
          'corner', f(Math.max(...near.map(r => r.cornering))) + ',',
          'tier', Math.max(...near.map(r => r.tier)));
    }
  }
  return out.join('\n');
}

/** Every derived value at one moment, for looking closely at a mark. */
function zoom(trace, at, window = 10) {
  const rows = trace.filter(r => Math.abs(r.t - at) <= window);
  const cols = ['t', 'gps', 'speed', 'src', 'tier', 'aLong', 'aLat', 'accel', 'brake',
                'cornering', 'intensity', 'aggression', 'calib'];
  const head = cols.map(c => c.padStart(11)).join('');
  const body = rows.map(r => cols.map(c =>
    String(typeof r[c] === 'number' ? f(r[c]) : r[c]).padStart(11)).join(''));
  return [head, ...body].join('\n');
}

// ---- cli --------------------------------------------------------

function main(argv) {
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('usage: npm run replay -- <log.csv> [--csv out.csv] [--at SECONDS] [--every N]');
    process.exit(2);
  }
  const arg = (name, def) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : def;
  };
  const log = parseLog(fs.readFileSync(file, 'utf8'));
  const every = +arg('every', 1);
  const r = replay(log, { every });

  console.log(report(log, r));

  const at = arg('at', null);
  if (at !== null) {
    console.log('\n# around ' + at + 's');
    console.log(zoom(r.trace, +at, +arg('window', 10)));
  }
  const csv = arg('csv', null);
  if (csv) {
    const cols = Object.keys(r.trace[0] || {});
    fs.writeFileSync(csv, [cols.join(','), ...r.trace.map(x => cols.map(c => x[c]).join(','))].join('\n'));
    console.log('\nderived trace written to ' + csv);
  }
}

if (import.meta.filename === process.argv[1]) main(process.argv.slice(2));

export { report, zoom };
