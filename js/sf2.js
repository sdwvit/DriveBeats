  // ============================================================
  //  SOUNDFONT (SF2) — directory parsed up front, samples sliced
  //  off disk on demand. The whole file is never held in memory.
  //
  //  Decoding a whole 315MB font to Float32 needs 619MB and iOS
  //  kills the tab. So: resolve the zones the loaded MIDI actually
  //  triggers and slice only those (measured 9.4-38.4MB instead).
  // ============================================================
  const SF = {
    file: null, name: null, ready: false,
    presets: [], instruments: [], samples: [],
    smplOff: 0, smplLen: 0,
    buffers: new Map(),          // sampleId -> {buf, rate, loopStart, loopEnd, base}
    zoneCache: new Map(),        // "preset:key:vel" -> zones
    excl: new Map(),             // exclusiveClass -> voice to choke
    loading: false, progress: 0, status: '',
    bytes: 0, voices: 0
  };

  const MAX_SF_VOICES = 64;

  // Generator operators we act on.
  const GEN = {
    startAddrsOffset:0, endAddrsOffset:1, startloopAddrsOffset:2, endloopAddrsOffset:3,
    startAddrsCoarse:4, endAddrsCoarse:12, startloopAddrsCoarse:45, endloopAddrsCoarse:50,
    pan:17, delayVolEnv:33, attackVolEnv:34, holdVolEnv:35, decayVolEnv:36,
    sustainVolEnv:37, releaseVolEnv:38, instrument:41, keyRange:43, velRange:44,
    initialAttenuation:48, coarseTune:51, fineTune:52, sampleID:53, sampleModes:54,
    scaleTuning:56, exclusiveClass:57, overridingRootKey:58
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
    SF.smplOff = 0; SF.smplLen = 0;
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
    SF.file = file; SF.name = file.name; SF.ready = false;
    SF.buffers.clear(); SF.zoneCache.clear(); presetCache.clear();
    SF.excl.clear(); SF.bytes = 0;
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
        out.push({ sampleId: iz.id, gens: iz.gens, pgens: pz.gens });
      }
    }
    return out;
  }

  // Preset generators are offsets added to the instrument's, not
  // replacements (SF2 spec 9.4) - keyRange/velRange/sampleID excepted, and
  // those are consumed during zone building.
  const gv = (z, op, def) =>
    (z.gens[op] !== undefined ? z.gens[op] : def) +
    (z.pgens[op] !== undefined ? z.pgens[op] : 0);

  function cachedZones(bank, program, key, vel) {
    const k = bank + ':' + program + ':' + key + ':' + vel;
    let z = SF.zoneCache.get(k);
    if (!z) { z = zonesForNote(presetFor(bank, program), key, vel); SF.zoneCache.set(k, z); }
    return z;
  }

  // ---- pruned sample loading -------------------------------------
  //
  // Collect only the sample ids the loaded MIDI can actually trigger, then
  // read them off disk in merged, offset-ordered runs. Never the whole font.

  const presetCache = new Map();
  function presetFor(bank, program) {
    const k = bank + ':' + program;
    let p = presetCache.get(k);
    if (p === undefined) { p = findPreset(bank, program) || null; presetCache.set(k, p); }
    return p;
  }

  function neededSamples(tracks) {
    const ids = new Set(), seen = new Set();
    for (const t of tracks) {
      for (const n of t.notes) {
        // Notes carry their own bank/program, because a track can change
        // program mid-song; pruning must match what playback will ask for.
        const k = n.bank + ':' + n.prog + ':' + n.midi + ':' + n.vel;
        if (seen.has(k)) continue;
        seen.add(k);
        const preset = presetFor(n.bank, n.prog);
        if (!preset) continue;
        for (const z of zonesForNote(preset, n.midi, n.vel)) ids.add(z.sampleId);
      }
    }
    return ids;
  }

  // Merge nearby byte ranges so a few hundred samples become a few dozen reads.
  function sampleRuns(ids, gap) {
    const list = [...ids]
      .map(id => ({ id, sm: SF.samples[id] }))
      .filter(x => x.sm && x.sm.end > x.sm.start)
      .sort((a, b) => a.sm.start - b.sm.start);
    const runs = [];
    for (const x of list) {
      const a = SF.smplOff + x.sm.start * 2, b = SF.smplOff + x.sm.end * 2;
      const last = runs[runs.length - 1];
      if (last && a - last.b <= gap) { last.b = Math.max(last.b, b); last.items.push(x); }
      else runs.push({ a, b: b, items: [x] });
    }
    return runs;
  }

  async function loadSamples(tracks, ctx, onProgress) {
    const ids = neededSamples(tracks);
    const runs = sampleRuns(ids, 65536);
    const total = runs.reduce((s, r) => s + (r.b - r.a), 0);
    let done = 0;
    SF.buffers.clear(); SF.bytes = 0;
    for (const run of runs) {
      const ab = await rd(SF.file, run.a, run.b);
      const pcm = new Int16Array(ab, 0, (ab.byteLength >> 1));
      for (const it of run.items) {
        const sm = it.sm;
        const from = (SF.smplOff + sm.start * 2 - run.a) >> 1;
        const n = sm.end - sm.start;
        if (n <= 0 || from < 0 || from + n > pcm.length) continue;
        // The buffer is created at the context rate and the pitch difference
        // is folded into playbackRate - createBuffer rejects the odd rates
        // some fonts use, and loop points stay frame-exact either way.
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) ch[i] = pcm[from + i] / 32768;
        SF.buffers.set(it.id, {
          buf, rate: sm.rate || 44100,
          start: sm.start,
          loopStart: sm.loopStart - sm.start,
          loopEnd: sm.loopEnd - sm.start,
          root: sm.pitch, correction: sm.correction, frames: n
        });
        SF.bytes += n * 4;
      }
      done += run.b - run.a;
      SF.progress = total ? done / total : 1;
      if (onProgress) onProgress(SF.progress, SF.bytes);
      // Yield so the progress bar paints and iOS does not see a long block.
      await new Promise(r => setTimeout(r, 0));
    }
    SF.ready = SF.buffers.size > 0;
    return { samples: SF.buffers.size, runs: runs.length, bytes: SF.bytes, pcm: total };
  }

  // ---- the voice -------------------------------------------------
  //
  // Core fidelity only (spec): sample, tuning, loop, volume envelope, pan.
  // No SF2 low-pass filter and no modulator matrix.

  const tc2s = tc => Math.pow(2, tc / 1200);            // timecents -> seconds
  const cb2g = cb => Math.pow(10, -cb / 200);           // centibels of attenuation -> gain

  function sfVoice(ctx, z, key, vel, t, dur, gain, dest) {
    const s = SF.buffers.get(z.sampleId);
    if (!s) return false;

    const root = (() => {
      const o = gv(z, GEN.overridingRootKey, -1);
      return (o >= 0 && o <= 127) ? o : s.root;
    })();
    // scaleTuning is how many cents the pitch moves per key. Drum zones set
    // it to 0 so that the key selects a sample without transposing it; without
    // this a snare mapped high plays back at a comical rate.
    const scale = Math.max(0, Math.min(1200, gv(z, GEN.scaleTuning, 100)));
    const cents = (key - root) * scale +
                  gv(z, GEN.coarseTune, 0) * 100 +
                  gv(z, GEN.fineTune, 0) + s.correction;
    const rate = Math.pow(2, cents / 1200) * (s.rate / ctx.sampleRate);
    if (!isFinite(rate) || rate <= 0) return false;

    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = rate;

    const mode = gv(z, GEN.sampleModes, 0) & 3;
    let loopEnd = s.loopEnd;
    if ((mode === 1 || mode === 3) && s.loopEnd > s.loopStart && s.loopStart >= 0 &&
        s.loopEnd <= s.frames) {
      src.loop = true;
      src.loopStart = s.loopStart / s.buf.sampleRate;
      src.loopEnd = s.loopEnd / s.buf.sampleRate;
    }

    // Volume envelope. Defaults are -12000tc (~1ms) for every stage.
    const att = cb2g(Math.max(0, Math.min(1440, gv(z, GEN.initialAttenuation, 0))));
    const sustCb = Math.max(0, Math.min(1000, gv(z, GEN.sustainVolEnv, 0)));
    const peak = Math.max(1e-4, gain * att);
    const sust = Math.max(1e-4, peak * cb2g(sustCb));

    const delay = Math.min(4, tc2s(gv(z, GEN.delayVolEnv, -12000)));
    const attack = Math.min(8, tc2s(gv(z, GEN.attackVolEnv, -12000)));
    const hold = Math.min(8, tc2s(gv(z, GEN.holdVolEnv, -12000)));
    const decay = Math.min(16, tc2s(gv(z, GEN.decayVolEnv, -12000)));
    const rel = Math.max(0.02, Math.min(8, tc2s(gv(z, GEN.releaseVolEnv, -12000))));

    const g = ctx.createGain();
    const t0 = t + delay, off = t + Math.max(dur, 0.02);
    g.gain.setValueAtTime(1e-4, t);
    if (delay > 0.002) g.gain.setValueAtTime(1e-4, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.setValueAtTime(peak, t0 + attack + hold);
    g.gain.exponentialRampToValueAtTime(sust, t0 + attack + hold + decay);
    // Release starts at note-off regardless of where decay had got to.
    g.gain.cancelScheduledValues(off);
    g.gain.setValueAtTime(Math.max(1e-4, envAt(t0, attack, hold, decay, peak, sust, off)), off);
    g.gain.exponentialRampToValueAtTime(1e-4, off + rel);

    const panV = Math.max(-1, Math.min(1, gv(z, GEN.pan, 0) / 500));
    let node = g;
    if (ctx.createStereoPanner && panV) {
      const p = ctx.createStereoPanner();
      p.pan.value = panV;
      g.connect(p); node = p;
    }
    src.connect(g); node.connect(dest);

    // exclusiveClass: a new note in the class cuts the one before it. This is
    // what stops an open hi-hat ringing through the closed one that follows.
    const ec = gv(z, GEN.exclusiveClass, 0);
    if (ec > 0) {
      const prev = SF.excl.get(ec);
      if (prev && prev.until > t) {
        try {
          prev.g.gain.cancelScheduledValues(t);
          prev.g.gain.setValueAtTime(Math.max(1e-4, prev.g.gain.value), t);
          prev.g.gain.exponentialRampToValueAtTime(1e-4, t + 0.012);
          prev.src.stop(t + 0.02);
        } catch (e) { /* already stopped */ }
      }
      SF.excl.set(ec, { g, src, until: off + rel });
    }

    // onended must be wired before start/stop, or the voice count never
    // comes back down and the cap silently swallows every later note.
    SF.voices++;
    let done = false;
    src.onended = () => { if (!done) { done = true; SF.voices--; } };
    src.start(t);
    src.stop(off + rel + 0.02);
    return true;
  }

  // Where the DAHDSR has got to at time `at`, so release ramps from the real
  // level rather than jumping to the sustain level.
  function envAt(t0, attack, hold, decay, peak, sust, at) {
    const d = at - t0;
    if (d <= 0) return 1e-4;
    if (d < attack) return Math.max(1e-4, peak * (d / attack));
    if (d < attack + hold) return peak;
    const dd = d - attack - hold;
    if (dd >= decay || decay <= 0) return sust;
    return peak * Math.pow(sust / peak, dd / decay);
  }

export { GEN, MAX_SF_VOICES, SF, cachedZones, cb2g, envAt, findPreset, gv, loadSamples, neededSamples, parseSf2, presetCache, presetFor, rd, sampleRuns, sfVoice, tc2s, zonesForNote };
