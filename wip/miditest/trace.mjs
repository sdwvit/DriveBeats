import fs from 'fs';
const f = process.argv[2];
const b = fs.readFileSync(f);
const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
let p = 0;
const u8 = () => v.getUint8(p++);
const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
const u16 = () => { const x = v.getUint16(p); p += 2; return x; };
const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
const vlq = () => { let x = 0, bb; do { bb = u8(); x = (x << 7) | (bb & 0x7f); } while (bb & 0x80); return x; };
console.log('magic', str(4)); const hlen = u32();
console.log('hlen', hlen, 'fmt', u16(), 'ntrk', u16(), 'div', u16());
p += hlen - 6;
let tn = 0;
while (p + 8 <= v.byteLength) {
  const cs = p; const id = str(4); const len = u32(); const end = p + len;
  console.log(`\n--- chunk#${tn} @${cs} id=${JSON.stringify(id)} len=${len} end=${end} (file ${v.byteLength})`);
  if (id !== 'MTrk') { console.log('  NOT MTrk, stopping'); break; }
  tn++;
  let running = 0, n = 0;
  while (p < end) {
    const evStart = p; const dt = vlq(); let st = u8(); let desc;
    if (st < 0x80) { p--; if (!running) { console.log(`  @${evStart} dt=${dt} RUNNING-STATUS-WITH-NONE byte=0x${st.toString(16)} REST OF TRACK ${end - p}B`); break; } st = running; desc = '(rs)'; }
    else if (st < 0xf0) running = st;
    const type = st & 0xf0;
    if (st === 0xff) { const mt = u8(), ml = vlq(); desc = 'meta 0x' + mt.toString(16) + ' len ' + ml; p += ml; }
    else if (st === 0xf0 || st === 0xf7) { const l = vlq(); desc = 'sysex ' + l; p += l; }
    else if (type === 0x90 || type === 0x80 || type === 0xb0 || type === 0xa0 || type === 0xe0) { desc = (desc || '') + ' evt 0x' + st.toString(16) + ' ' + u8() + ' ' + u8(); }
    else if (type === 0xc0 || type === 0xd0) { desc = (desc || '') + ' evt 0x' + st.toString(16) + ' ' + u8(); }
    else { console.log(`  @${evStart} UNKNOWN STATUS 0x${st.toString(16)}`); break; }
    if (n < 12 || p >= end - 8) console.log(`  @${evStart} dt=${dt} ${desc}`);
    n++;
  }
  console.log(`  events=${n} ended at p=${p} vs end=${end} delta=${p - end}`);
  p = end;
}
