import fs from 'fs';
import path from 'path';
import os from 'os';
const ROOT = path.resolve(import.meta.dirname, '../..');
const TMP = process.env.T || os.tmpdir();
import { refNotes } from './ref.mjs';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const a = html.indexOf('  function parseMidi(buf) {');
const b = html.indexOf('  function loadParsed(', a);
fs.writeFileSync(path.join(TMP, '_pm.mjs'), html.slice(a, b) + '\nexport {parseMidi, assignRoles};\n');
const { parseMidi } = await import('file://' + path.join(TMP, '_pm.mjs') + '?v=' + Date.now());

const dir = '/home/sdwvit/MX500-900/Music/midi';
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p, out); else if (/\.midi?$/i.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(dir).sort();
const rows = [];
let clean = 0;
for (const f of files) {
  const buf = fs.readFileSync(f);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let r, g = null, err = null;
  try { r = refNotes(ab); } catch (e) { rows.push([f, 'REF-FAIL ' + e.message, 0, 0]); continue; }
  try { const parsed = parseMidi(ab); g = parsed.tracks.reduce((s, t) => s + t.notes.length, 0); }
  catch (e) { err = e.message; }
  const want = r.notes.length;
  if (err) rows.push([f, 'THROW: ' + err, want, 0]);
  else if (g !== want) rows.push([f, 'notes ' + g + ' vs ref ' + want + ' (' + (100 * g / want).toFixed(1) + '%)', want, g]);
  else clean++;
}
console.log('total', files.length, 'identical to reference:', clean, 'differing:', rows.length);
rows.sort((x, y) => (x[3] / (x[2] || 1)) - (y[3] / (y[2] || 1)));
for (const r of rows) console.log(r[0].replace(dir + '/', '') + '  ::  ' + r[1]);
