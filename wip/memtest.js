const fs=require('fs');
const {parseMidi}=require(process.env.S+'/midionly.js');
class NodeFile{
  constructor(p){ this.fd=fs.openSync(p,'r'); this.size=fs.statSync(p).size; this.name=p.split('/').pop(); }
  slice(a,b){ const len=Math.max(0,b-a); const buf=Buffer.alloc(len);
    if(len) fs.readSync(this.fd,buf,0,len,a);
    return { arrayBuffer: async()=>buf.buffer.slice(buf.byteOffset,buf.byteOffset+len) }; }
}
// ============================================================
//  SOUNDFONT (SF2) — directory parsed up front, samples sliced
//  off disk on demand. The whole file is never held in memory.
// ============================================================
const SF = {
  file: null, name: null, ready: false,
  presets: [], instruments: [], samples: [],
  smplOff: 0, smplLen: 0, bps: 2,
  buffers: new Map(),          // sampleId -> AudioBuffer
  loading: false, progress: 0, loadedBytes: 0
};

// Generator operators we act on.
const GEN = {
  startAddrsOffset:0, endAddrsOffset:1, startloopAddrsOffset:2, endloopAddrsOffset:3,
  startAddrsCoarse:4, endAddrsCoarse:12, startloopAddrsCoarse:45, endloopAddrsCoarse:50,
  pan:17, delayVolEnv:33, attackVolEnv:34, holdVolEnv:35, decayVolEnv:36,
  sustainVolEnv:37, releaseVolEnv:38, instrument:41, keyRange:43, velRange:44,
  initialAttenuation:48, coarseTune:51, fineTune:52, sampleID:53, sampleModes:54,
  overridingRootKey:58
};

const rd = (f, a, b) => f.slice(a, b).arrayBuffer();

async function parseSf2(file) {
  const head = new DataView(await rd(file, 0, 12));
  const tag = s => String.fromCharCode(...new Uint8Array(s));
  if (tag(head.buffer.slice(0,4)) !== 'RIFF' || tag(head.buffer.slice(8,12)) !== 'sfbk')
    throw new Error('Not a SoundFont (.sf2) file.');

  // Walk the top-level chunks; only pdta is actually read into memory.
  let pos = 12, pdta = null;
  const size = file.size;
  while (pos < size - 8) {
    const h = new DataView(await rd(file, pos, pos + 12));
    const id = tag(h.buffer.slice(0,4));
    const csz = h.getUint32(4, true);
    const lbl = tag(h.buffer.slice(8,12));
    if (id === 'LIST' && lbl === 'sdta') {
      // find the smpl sub-chunk
      let p = pos + 12;
      const endc = pos + 8 + csz;
      while (p < endc) {
        const sh = new DataView(await rd(file, p, p + 8));
        const sid = tag(sh.buffer.slice(0,4));
        const ssz = sh.getUint32(4, true);
        if (sid === 'smpl') { SF.smplOff = p + 8; SF.smplLen = ssz; break; }
        p += 8 + ssz + (ssz & 1);
      }
    } else if (id === 'LIST' && lbl === 'pdta') {
      pdta = { off: pos + 12, len: csz - 4 };
    }
    pos += 8 + csz + (csz & 1);
  }
  if (!pdta) throw new Error('SoundFont has no pdta (preset data) chunk.');
  if (!SF.smplOff) throw new Error('SoundFont has no sample data.');

  const buf = await rd(file, pdta.off, pdta.off + pdta.len);
  const dv = new DataView(buf);
  const sub = {};
  let p = 0;
  while (p < buf.byteLength - 8) {
    const id = String.fromCharCode(dv.getUint8(p),dv.getUint8(p+1),dv.getUint8(p+2),dv.getUint8(p+3));
    const sz = dv.getUint32(p + 4, true);
    sub[id] = { off: p + 8, len: sz };
    p += 8 + sz + (sz & 1);
  }
  const need = ['phdr','pbag','pgen','inst','ibag','igen','shdr'];
  for (const n of need) if (!sub[n]) throw new Error('SoundFont is missing the ' + n + ' chunk.');

  const name = (o, n) => {
    let s = '';
    for (let i = 0; i < n; i++) { const c = dv.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); }
    return s.trim();
  };

  // --- raw records ---
  const phdr = [], nph = sub.phdr.len / 38;
  for (let i = 0; i < nph; i++) { const o = sub.phdr.off + i*38;
    phdr.push({ name:name(o,20), preset:dv.getUint16(o+20,true), bank:dv.getUint16(o+22,true), bag:dv.getUint16(o+24,true) }); }

  const pbag = [], npb = sub.pbag.len / 4;
  for (let i = 0; i < npb; i++) { const o = sub.pbag.off + i*4;
    pbag.push({ gen: dv.getUint16(o,true) }); }

  const readGens = (chunk) => {
    const g = [], n = chunk.len / 4;
    for (let i = 0; i < n; i++) { const o = chunk.off + i*4;
      g.push({ op: dv.getUint16(o,true), lo: dv.getUint8(o+2), hi: dv.getUint8(o+3),
               u: dv.getUint16(o+2,true), s: dv.getInt16(o+2,true) }); }
    return g;
  };
  const pgen = readGens(sub.pgen), igen = readGens(sub.igen);

  const inst = [], nin = sub.inst.len / 22;
  for (let i = 0; i < nin; i++) { const o = sub.inst.off + i*22;
    inst.push({ name:name(o,20), bag:dv.getUint16(o+20,true) }); }

  const ibag = [], nib = sub.ibag.len / 4;
  for (let i = 0; i < nib; i++) { const o = sub.ibag.off + i*4;
    ibag.push({ gen: dv.getUint16(o,true) }); }

  const shdr = [], nsh = sub.shdr.len / 46;
  for (let i = 0; i < nsh; i++) { const o = sub.shdr.off + i*46;
    shdr.push({ name:name(o,20), start:dv.getUint32(o+20,true), end:dv.getUint32(o+24,true),
                loopStart:dv.getUint32(o+28,true), loopEnd:dv.getUint32(o+32,true),
                rate:dv.getUint32(o+36,true), pitch:dv.getUint8(o+40),
                correction:dv.getInt8(o+41), type:dv.getUint16(o+44,true) }); }

  // --- zone building ---
  const zonesOf = (bagArr, gens, bagStart, bagEnd, idOp) => {
    const out = [];
    let global = {};
    for (let b = bagStart; b < bagEnd; b++) {
      const gs = bagArr[b].gen, ge = (b+1 < bagArr.length) ? bagArr[b+1].gen : gens.length;
      const z = { gens:{}, keyLo:0, keyHi:127, velLo:0, velHi:127, id:null };
      for (let gi = gs; gi < ge; gi++) {
        const g = gens[gi];
        if (g.op === GEN.keyRange) { z.keyLo = g.lo; z.keyHi = g.hi; }
        else if (g.op === GEN.velRange) { z.velLo = g.lo; z.velHi = g.hi; }
        else if (g.op === idOp) z.id = g.u;
        else z.gens[g.op] = g.s;
      }
      if (z.id === null) { global = z; continue; }       // global zone
      z.gens = Object.assign({}, global.gens, z.gens);
      if (global.keyLo !== undefined && z.keyLo === 0 && z.keyHi === 127 && global.keyLo !== 0) {
        z.keyLo = global.keyLo; z.keyHi = global.keyHi;
      }
      out.push(z);
    }
    return out;
  };

  // instruments -> sample zones
  const instruments = inst.slice(0, -1).map((it, i) => ({
    name: it.name,
    zones: zonesOf(ibag, igen, it.bag, inst[i+1].bag, GEN.sampleID)
  }));

  // presets -> instrument zones
  const presets = phdr.slice(0, -1).map((ph, i) => ({
    name: ph.name, bank: ph.bank, program: ph.preset,
    zones: zonesOf(pbag, pgen, ph.bag, phdr[i+1].bag, GEN.instrument)
  }));

  SF.presets = presets; SF.instruments = instruments; SF.samples = shdr;
  SF.file = file; SF.name = file.name; SF.ready = true;
  SF.buffers.clear(); SF.loadedBytes = 0;
  return { presets: presets.length, instruments: instruments.length, samples: shdr.length };
}

function findPreset(bank, program) {
  let p = SF.presets.find(x => x.bank === bank && x.program === program);
  if (!p && bank === 128) p = SF.presets.find(x => x.bank === 128);
  if (!p) p = SF.presets.find(x => x.bank === 0 && x.program === program);
  if (!p) p = SF.presets.find(x => x.bank === 0) || SF.presets[0];
  return p;
}

// Every (sample, generator-set) pair that a given key/velocity triggers.
function zonesForNote(preset, key, vel) {
  const out = [];
  if (!preset) return out;
  for (const pz of preset.zones) {
    if (key < pz.keyLo || key > pz.keyHi || vel < pz.velLo || vel > pz.velHi) continue;
    const it = SF.instruments[pz.id];
    if (!it) continue;
    for (const iz of it.zones) {
      if (key < iz.keyLo || key > iz.keyHi || vel < iz.velLo || vel > iz.velHi) continue;
      if (iz.id === null || iz.id === undefined) continue;
      out.push({ sampleId: iz.id, gens: Object.assign({}, pz.gens, iz.gens), pgens: pz.gens });
    }
  }
  return out;
}

(async()=>{
  const sfPath=process.argv[2], midPath=process.argv[3];
  await parseSf2(new NodeFile(sfPath));
  const r=fs.readFileSync(midPath);
  const mid=parseMidi(r.buffer.slice(r.byteOffset,r.byteOffset+r.byteLength));

  const needed=new Set(); let naive=new Set();
  for(const t of mid.tracks){
    const preset=findPreset(t.bank,t.program);
    // keys and velocities actually present on this channel
    const keys=[...new Set(t.notes.map(n=>n.midi))];
    const vels=[...new Set(t.notes.map(n=>n.vel))];
    for(const k of keys) for(const v of vels)
      for(const z of zonesForNote(preset,k,v)) needed.add(z.sampleId);
    // what loading the whole preset would cost instead
    for(let k=0;k<128;k++) for(const z of zonesForNote(preset,k,64)) naive.add(z.sampleId);
  }
  const bytes=ids=>[...ids].reduce((s,i)=>{const sm=SF.samples[i];return s+(sm?(sm.end-sm.start)*2:0);},0);
  const pcm=bytes(needed), npcm=bytes(naive);
  console.log(`  presets used      : ${new Set(mid.tracks.map(t=>t.bank+':'+t.program)).size}`);
  console.log(`  samples needed    : ${needed.size} of ${SF.samples.length}`);
  console.log(`  PCM  (int16)      : ${(pcm/1048576).toFixed(1)} MB`);
  console.log(`  as Float32 buffers: ${(pcm*2/1048576).toFixed(1)} MB   <-- actual browser memory`);
  console.log(`  if whole presets  : ${(npcm*2/1048576).toFixed(1)} MB Float32`);
  console.log(`  if whole font     : ${(SF.smplLen*2/1048576).toFixed(0)} MB Float32`);
})().catch(e=>{console.error('ERROR:',e.message);process.exit(1)});
