// A minimum-viable .sf2 built in memory.
//
// There is no soundfont in the repo (they are tens of megabytes) and the bugs
// under test live in generator handling, so the tests need a font whose
// generators they can vary a record at a time. This writes a real RIFF/sfbk
// byte buffer - sdta/smpl plus a full pdta - so parseSf2 walks exactly the
// structure it walks in the field, terminal records included.

const GEN_SIZE = 4, BAG_SIZE = 4, MOD_SIZE = 10;
const PHDR_SIZE = 38, INST_SIZE = 22, SHDR_SIZE = 46;

// Names in phdr/inst/shdr are NUL-terminated in a fixed field, so the last
// byte is reserved. A FOURCC is not a name - it fills all four bytes - which is
// what `cc` below is for; writing 'RIFF' through here yields 'RIF\0'.
function ascii(str, n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < Math.min(str.length, n - 1); i++) b[i] = str.charCodeAt(i) & 0x7f;
  return b;
}

/** A growable little-endian byte writer. */
class Bytes {
  constructor() { this.parts = []; this.len = 0; }
  raw(u8) { this.parts.push(u8); this.len += u8.length; return this; }
  u8(v) { return this.raw(new Uint8Array([v & 0xff])); }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff, true); return this.raw(b); }
  i16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v, true); return this.raw(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return this.raw(b); }
  str(s, n) { return this.raw(ascii(s, n)); }
  /** A FOURCC: four bytes, no terminator. */
  cc(s) { const b = new Uint8Array(4); for (let i = 0; i < 4; i++) b[i] = s.charCodeAt(i) & 0x7f; return this.raw(b); }
  bytes() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** id + size + payload, padded to an even length as RIFF requires. */
function chunk(id, payload) {
  const b = new Bytes();
  b.cc(id).u32(payload.length).raw(payload);
  if (payload.length & 1) b.u8(0);
  return b.bytes();
}

function list(label, payloads) {
  const inner = new Bytes().cc(label);
  for (const p of payloads) inner.raw(p);
  return chunk('LIST', inner.bytes());
}

// A generator is {op, v} for a plain amount or {op, lo, hi} for a range.
function writeGens(zones) {
  const b = new Bytes();
  const bagIndex = [];
  let n = 0;
  for (const z of zones) {
    bagIndex.push(n);
    for (const g of z) {
      b.u16(g.op);
      if (g.lo !== undefined) b.u8(g.lo).u8(g.hi); else b.i16(g.v);
      n++;
    }
  }
  bagIndex.push(n);                       // where the terminal bag points
  b.u16(0).i16(0);                        // terminal generator record
  return { data: b.bytes(), bagIndex };
}

function writeBags(bagIndex) {
  const b = new Bytes();
  // One bag per zone plus the terminal bag; modNdx is always 0 because the
  // fixture carries no modulators, only the terminal one.
  for (const gi of bagIndex) b.u16(gi).u16(0);
  return b.bytes();
}

const terminalMod = () => new Bytes().u16(0).u16(0).i16(0).u16(0).u16(0).bytes();

/**
 * buildSf2({ pcm, samples, instruments, presets }) -> Uint8Array
 *
 *   pcm          Int16Array of sample data (the whole smpl chunk)
 *   samples      [{name, start, end, loopStart, loopEnd, rate, pitch, correction, type}]
 *   instruments  [{name, zones: [[gen, ...], ...]}]   zone gens include sampleID (53)
 *   presets      [{name, bank, program, zones: [[gen, ...], ...]}]  gens include instrument (41)
 *
 * A zone with no sampleID/instrument generator is a global zone, which is
 * exactly what the inheritance tests need to place deliberately.
 */
export function buildSf2({ pcm = new Int16Array(0), samples = [], instruments = [], presets = [] }) {
  const smpl = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);

  // --- instruments ---
  const izones = [], instRecs = new Bytes();
  for (const it of instruments) {
    instRecs.str(it.name, 20).u16(izones.length);
    for (const z of it.zones) izones.push(z);
  }
  instRecs.str('EOI', 20).u16(izones.length);
  const ig = writeGens(izones);

  // --- presets ---
  const pzones = [], phdrRecs = new Bytes();
  for (const pr of presets) {
    phdrRecs.str(pr.name, 20).u16(pr.program).u16(pr.bank).u16(pzones.length)
      .u32(0).u32(0).u32(0);
    for (const z of pr.zones) pzones.push(z);
  }
  phdrRecs.str('EOP', 20).u16(0).u16(0).u16(pzones.length).u32(0).u32(0).u32(0);
  const pg = writeGens(pzones);

  // --- samples ---
  const shdr = new Bytes();
  for (const s of samples) {
    shdr.str(s.name, 20).u32(s.start).u32(s.end).u32(s.loopStart).u32(s.loopEnd)
      .u32(s.rate ?? 44100).u8(s.pitch ?? 60).u8((s.correction ?? 0) & 0xff)
      .u16(0).u16(s.type ?? 1);
  }
  shdr.str('EOS', 20).u32(0).u32(0).u32(0).u32(0).u32(0).u8(0).u8(0).u16(0).u16(0);

  const pdta = list('pdta', [
    chunk('phdr', phdrRecs.bytes()),
    chunk('pbag', writeBags(pg.bagIndex)),
    chunk('pmod', terminalMod()),
    chunk('pgen', pg.data),
    chunk('inst', instRecs.bytes()),
    chunk('ibag', writeBags(ig.bagIndex)),
    chunk('imod', terminalMod()),
    chunk('igen', ig.data),
    chunk('shdr', shdr.bytes()),
  ]);
  const sdta = list('sdta', [chunk('smpl', smpl)]);

  const body = new Bytes().cc('sfbk').raw(sdta).raw(pdta).bytes();
  return chunk('RIFF', body);
}

// Sanity: the record sizes parseSf2 divides by. A wrong one here would show up
// as a nonsense record count rather than a failed assertion, so keep them named.
export const SIZES = { GEN_SIZE, BAG_SIZE, MOD_SIZE, PHDR_SIZE, INST_SIZE, SHDR_SIZE };
