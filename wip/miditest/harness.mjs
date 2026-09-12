import fs from 'fs';
import path from 'path';
import os from 'os';
const ROOT = path.resolve(import.meta.dirname, '../..');
const TMP = process.env.T || os.tmpdir();
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
function grab(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  const b = html.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('marker missing: ' + startMarker);
  return html.slice(a, b);
}
const src = grab('  function parseMidi(buf) {', '  function loadParsed(');
fs.writeFileSync(path.join(TMP, '_pm.mjs'), src + '\nexport {parseMidi, assignRoles};\n');
const { parseMidi, assignRoles } = await import('file://' + path.join(TMP, '_pm.mjs') + '?v=' + Date.now());

const dir = '/home/sdwvit/MX500-900/Music/midi';
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p, out);
    else if (/\.midi?$/i.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(dir).sort();
let ok = 0; const fails = []; const warns = [];
for (const f of files) {
  const b = fs.readFileSync(f);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  try {
    const parsed = parseMidi(ab);
    assignRoles(parsed.tracks, parsed.tpq);
    ok++;
    const notes = parsed.tracks.reduce((s, t) => s + t.notes.length, 0);
    const all = parsed.tracks.flatMap(t => t.notes);
    const maxTick = Math.max(...all.map(n => n.start + n.dur));
    const longest = Math.max(...all.map(n => n.dur));
    const w = [];
    if (notes < 16) w.push('only ' + notes + ' notes');
    if (longest > parsed.tpq * 64) w.push('note dur ' + (longest / parsed.tpq).toFixed(0) + ' beats');
    if (w.length) warns.push([f, w.join(', '), notes, maxTick / parsed.tpq]);
  } catch (e) { fails.push([f, e.message]); }
}
console.log('files:', files.length, 'parsed ok:', ok, 'failed:', fails.length);
console.log('\n=== FAILURES ===');
for (const [f, m] of fails) console.log(f.replace(dir + '/', '') + '  ::  ' + m);
console.log('\n=== WARNINGS (' + warns.length + ') ===');
for (const [f, m, n, beats] of warns.slice(0, 60))
  console.log(f.replace(dir + '/', '') + '  ::  ' + m + '  (' + n + ' notes, ' + beats.toFixed(0) + ' beats)');
