import fs from 'fs';
import path from 'path';
const ROOT = path.resolve(import.meta.dirname, '../..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const a = html.indexOf('  function slewBpm() {');
const b = html.indexOf('  function schedulerMidi()', a);
const A = { bpm: 112, pendingBpm: 112 };
const slewBpm = new Function('A', html.slice(a, b) + '\nreturn slewBpm;')(A);

// The exact shape of the guard in applyMapping.
const spdOf = D => (typeof D.speed === 'number' && isFinite(D.speed))
  ? Math.min(1, Math.max(0, D.speed / 33)) : D.aggression;
const pendOf = D => { const s = spdOf(D); return 104 + 28 * (isFinite(s) ? s : 0); };

let fail = 0;
const ck = (name, cond) => { if (!cond) { console.log('FAIL ' + name); fail++; } else console.log('ok   ' + name); };

ck('NaN GPS speed -> finite bpm', isFinite(pendOf({ speed: NaN, aggression: 0.5 })));
ck('null GPS speed -> uses aggression', pendOf({ speed: null, aggression: 0.5 }) === 104 + 14);
ck('NaN aggression -> finite bpm', isFinite(pendOf({ speed: null, aggression: NaN })));
ck('negative speed clamps to 0', pendOf({ speed: -5, aggression: 0 }) === 104);
ck('normal speed maps', Math.abs(pendOf({ speed: 33, aggression: 0 }) - 132) < 1e-9);

// A poisoned bpm must heal rather than stick.
A.bpm = NaN; A.pendingBpm = 120; slewBpm();
ck('poisoned A.bpm recovers', A.bpm === 120);
A.bpm = 112; A.pendingBpm = NaN; slewBpm();
ck('poisoned pendingBpm recovers', isFinite(A.bpm) && isFinite(A.pendingBpm));
A.bpm = 112; A.pendingBpm = 132;
for (let i = 0; i < 10; i++) slewBpm();
ck('slew still reaches target', A.bpm === 132);
A.bpm = 112; A.pendingBpm = 132; slewBpm();
ck('slew still capped at +4/bar', A.bpm === 116);

// A finite bpm is what keeps note durations finite, which is what stopped
// the scheduler dying mid-song.
const tpq = 480, durTicks = 240;
ck('note duration finite', isFinite(durTicks * (60 / A.bpm / tpq)));
console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
