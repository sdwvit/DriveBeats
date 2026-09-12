// Strict reference SMF reader, used only to score the parser in index.html.
export function refNotes(ab) {
  const v = new DataView(ab);
  let p = 0;
  const u8 = () => v.getUint8(p++);
  const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
  const u16 = () => { const x = v.getUint16(p); p += 2; return x; };
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
  const vlq = () => { let x = 0, bb, g = 0; do { bb = u8(); x = (x << 7) | (bb & 0x7f); } while ((bb & 0x80) && ++g < 4); return x; };
  if (str(4) !== 'MThd') throw new Error('no MThd');
  const hlen = u32(); u16(); u16(); const div = u16();
  p += hlen - 6;
  const notes = [];
  while (p + 8 <= v.byteLength) {
    const id = str(4); const len = u32(); const end = Math.min(p + len, v.byteLength);
    if (id !== 'MTrk') { p = end; continue; }
    let tick = 0, running = 0; const open = {};
    while (p < end) {
      tick += vlq();
      if (p >= end) break;
      let st = u8();
      if (st < 0x80) { if (!running) break; p--; st = running; }
      else if (st < 0xf0) running = st;
      const type = st & 0xf0, ch = st & 0x0f;
      if (st === 0xff) { u8(); const ml = vlq(); p += ml; }
      else if (st === 0xf0 || st === 0xf7) { const sl = vlq(); p += sl; }
      else if (type === 0x90 || type === 0x80) {
        const n = u8(), vel = u8(); const key = ch * 128 + n;
        if (type === 0x90 && vel > 0) { (open[key] ||= []).push({ n, vel, ch, start: tick }); }
        else { const q = open[key]; if (q && q.length) { const o = q.shift(); notes.push({ midi: o.n, ch: o.ch, start: o.start, dur: Math.max(1, tick - o.start) }); } }
      } else if (type === 0xb0 || type === 0xa0 || type === 0xe0) p += 2;
      else if (type === 0xc0 || type === 0xd0) p += 1;
      else if (st === 0xf2) p += 2;
      else if (st === 0xf1 || st === 0xf3) p += 1;
      else { /* realtime 0xf4-0xfe: no data */ }
    }
    for (const k in open) for (const o of open[k]) notes.push({ midi: o.n, ch: o.ch, start: o.start, dur: div });
    p = end;
  }
  return { div, notes };
}
