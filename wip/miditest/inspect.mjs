import fs from 'fs';
import path from 'path';
import os from 'os';
const ROOT = path.resolve(import.meta.dirname, '../..');
const TMP = process.env.T || os.tmpdir();
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const a = html.indexOf('  // General MIDI program names,');
const b = html.indexOf('  function loadParsed(', a);
fs.writeFileSync(path.join(TMP, '_pm2.mjs'), html.slice(a, b) + '\nexport {parseMidi, assignRoles};\n');
const { parseMidi, assignRoles } = await import('file://' + path.join(TMP, '_pm2.mjs') + '?v=' + Date.now());
const f = process.argv[2];
const buf = fs.readFileSync(f);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const parsed = parseMidi(ab);
assignRoles(parsed.tracks, parsed.tpq);
console.log('tpq', parsed.tpq, 'tracks', parsed.tracks.length);
for (const t of parsed.tracks) {
  const pitches = [...new Set(t.notes.map(n => n.midi))].sort((x, y) => x - y);
  const span = t.notes.length ? Math.max(...t.notes.map(n => n.start + n.dur)) : 0;
  console.log(
    JSON.stringify(t.name).padEnd(42),
    'ch' + String(t.ch ?? '?').padStart(2),
    'n=' + String(t.notes.length).padStart(5),
    'role=' + String(t.role).padEnd(6),
    'pitches=' + pitches.length,
    'span=' + (span / parsed.tpq).toFixed(0) + 'beats',
    'prog=' + t.program, 'bank=' + t.bank);
}
