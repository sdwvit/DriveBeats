import fs from 'fs';
import path from 'path';
import os from 'os';
const ROOT = path.resolve(import.meta.dirname, '../..');
const TMP = process.env.T || os.tmpdir();
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const a = html.indexOf('  // General MIDI program names,');
const b = html.indexOf('  function loadParsed(', a);
fs.writeFileSync(path.join(TMP, '_pm3.mjs'), html.slice(a, b) + '\nexport {parseMidi, looksLikeCredits};\n');
const { parseMidi, looksLikeCredits } = await import('file://' + path.join(TMP, '_pm3.mjs') + '?v=' + Date.now());
const dir = '/home/sdwvit/MX500-900/Music/midi';
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p, out); else if (/\.midi?$/i.test(e.name)) out.push(p);
  }
  return out;
}
// Re-read every track-name meta so we can see what was replaced and why.
const kept = new Set(), dropped = new Set();
for (const f of walk(dir)) {
  const buf = fs.readFileSync(f);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const u8 = () => (p < v.byteLength ? v.getUint8(p++) : (p++, 0));
  const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
  const vlq = () => { let x = 0, bb, g = 0; do { bb = u8(); x = (x << 7) | (bb & 0x7f); } while ((bb & 0x80) && ++g < 4); return x; };
  if (str(4) !== 'MThd') continue;
  const hl = u32(); p += hl;
  while (p + 8 <= v.byteLength) {
    const id = str(4); const len = u32(); const end = Math.min(p + len, v.byteLength);
    if (id !== 'MTrk') { p = end; continue; }
    let running = 0;
    while (p < end) {
      vlq(); if (p >= end) break;
      let st = u8();
      if (st < 0x80) { if (!running) break; p--; st = running; } else if (st < 0xf0) running = st;
      const ty = st & 0xf0;
      if (st === 0xff) {
        const mt = u8(), ml = vlq(); const q = p;
        if (mt === 0x03) { const nm = str(ml); (looksLikeCredits(nm) ? dropped : kept).add(nm.trim()); }
        p = q + ml;
      } else if (st === 0xf0 || st === 0xf7) { const sl = vlq(); p += sl; }
      else if (ty === 0x90 || ty === 0x80 || ty === 0xb0 || ty === 0xa0 || ty === 0xe0) p += 2;
      else if (ty === 0xc0 || ty === 0xd0) p += 1;
      else if (st === 0xf2) p += 2; else if (st === 0xf1 || st === 0xf3) p += 1;
    }
    p = end;
  }
}
console.log('KEPT as labels: ' + kept.size + ' distinct');
console.log([...kept].slice(0, 40).map(s => JSON.stringify(s)).join('  '));
console.log('\nREPLACED by instrument name: ' + dropped.size + ' distinct');
console.log([...dropped].slice(0, 40).map(s => JSON.stringify(s)).join('  '));
