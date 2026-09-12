  // ============================================================
  //  MIDI — inline Standard MIDI File parser + IndexedDB store
  // ============================================================
  const M = {
    active: false,
    name: null,
    tpq: 480,
    lengthTicks: 0,
    tracks: [],          // [{name, notes:[], role, avgPitch, isDrum}]
    notes: [],           // flat, sorted by startTick, each carries trackIdx
    idx: 0,
    curTick: 0,
    curTime: 0,
    roleGain: { drums: 0, bass: 0, pad: 1, lead: 0, keys: 0 }
  };

  const ROLES = ['drums', 'bass', 'pad', 'keys', 'lead', 'off'];

  // "pad" and "keys" mean nothing to a driver who does not read music, and the
  // choice that actually matters here is not timbre but when a part is audible:
  // the speed ladder in playback.js gates each role at a breakpoint. So the
  // menu names the breakpoint. Keep these in the same order as ROLES.
  const ROLE_LABELS = {
    drums: 'Beat \u2014 from 10 mph',
    bass:  'Bassline \u2014 from 10 mph',
    pad:   'Background \u2014 always on',
    keys:  'Extra \u2014 from 20 mph',
    lead:  'Melody \u2014 from 30 mph',
    off:   'Muted'
  };

  // General MIDI program names, for labelling a track whose own name is
  // missing or useless.
  const GM = ('Acoustic Grand Piano,Bright Acoustic Piano,Electric Grand Piano,Honky-tonk Piano,' +
    'Electric Piano 1,Electric Piano 2,Harpsichord,Clavi,Celesta,Glockenspiel,Music Box,' +
    'Vibraphone,Marimba,Xylophone,Tubular Bells,Dulcimer,Drawbar Organ,Percussive Organ,' +
    'Rock Organ,Church Organ,Reed Organ,Accordion,Harmonica,Tango Accordion,Acoustic Guitar,' +
    'Acoustic Guitar,Electric Guitar,Electric Guitar,Electric Guitar,Overdriven Guitar,' +
    'Distortion Guitar,Guitar Harmonics,Acoustic Bass,Finger Bass,Pick Bass,Fretless Bass,' +
    'Slap Bass 1,Slap Bass 2,Synth Bass 1,Synth Bass 2,Violin,Viola,Cello,Contrabass,' +
    'Tremolo Strings,Pizzicato Strings,Orchestral Harp,Timpani,String Ensemble 1,' +
    'String Ensemble 2,Synth Strings 1,Synth Strings 2,Choir Aahs,Voice Oohs,Synth Voice,' +
    'Orchestra Hit,Trumpet,Trombone,Tuba,Muted Trumpet,French Horn,Brass Section,Synth Brass 1,' +
    'Synth Brass 2,Soprano Sax,Alto Sax,Tenor Sax,Baritone Sax,Oboe,English Horn,Bassoon,' +
    'Clarinet,Piccolo,Flute,Recorder,Pan Flute,Blown Bottle,Shakuhachi,Whistle,Ocarina,' +
    'Square Lead,Sawtooth Lead,Calliope Lead,Chiff Lead,Charang Lead,Voice Lead,Fifths Lead,' +
    'Bass + Lead,New Age Pad,Warm Pad,Polysynth Pad,Choir Pad,Bowed Pad,Metallic Pad,Halo Pad,' +
    'Sweep Pad,Rain FX,Soundtrack FX,Crystal FX,Atmosphere FX,Brightness FX,Goblins FX,' +
    'Echoes FX,Sci-Fi FX,Sitar,Banjo,Shamisen,Koto,Kalimba,Bag pipe,Fiddle,Shanai,Tinkle Bell,' +
    'Agogo,Steel Drums,Woodblock,Taiko Drum,Melodic Tom,Synth Drum,Reverse Cymbal,' +
    'Guitar Fret Noise,Breath Noise,Seashore,Bird Tweet,Telephone Ring,Helicopter,Applause,' +
    'Gunshot').split(',');

  // Authors routinely type their credits into the track-name meta, one line
  // per track, so a whole song ends up labelled "Composed By: ...", "e-mail
  // me", "==============". Those tracks are ordinary music and must never be
  // dropped - doing so deletes the song - but the text is no use as a label,
  // so fall back to the instrument. A real part name is short; anything long,
  // wordy, punctuation-only or carrying contact details is credits.
  const CREDITS = /@|https?:|www\.|\bcompos|\barrang|\bsequenc|\bmade with\b|\bcopyright\b|\(c\)|\be-?mail\b|\bquestions\b|\bcomments\b|\bmidi by\b|\bby:/i;
  // Anything naming an instrument or a part is a real label however long it
  // runs - "Clean Rhythm Guitar" and "Backing Keyboards" are not credits.
  const PART = /\b(guitar|bass|drum|drums|piano|key|keys|keyboard|organ|string|strings|violin|viola|cello|horn|brass|trumpet|trombone|tuba|sax|flute|clarinet|oboe|bassoon|piccolo|choir|vocal|vocals|voice|lead|rhythm|pad|synth|snare|kick|hat|hihat|cymbal|tom|toms|perc|percussion|harp|bell|bells|chime|marimba|vibes|xylophone|timpani|acoustic|electric|melody|harmony|counter|arp|pluck|clav|accordion|banjo|sitar|whistle|recorder|ocarina|fx|solo|backing|intro|outro|verse|chorus|bridge)\b/i;
  function looksLikeCredits(s) {
    const t = (s || '').trim();
    if (!t) return true;
    if (!/[a-z0-9]/i.test(t)) return true;             // "==========", "- - -"
    if (CREDITS.test(t)) return true;
    if (PART.test(t)) return false;
    return t.length > 16 || t.split(/\s+/).length > 3;  // a title or a sentence
  }

  function trackLabel(name, bank, program, n) {
    if (!looksLikeCredits(name)) return name;
    if (bank === 128) return 'Drums';
    return GM[program] || ('Track ' + n);
  }

  // ---- parser ----------------------------------------------------
  function parseMidi(buf) {
    const v = new DataView(buf);
    let p = 0;
    const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
    const u16 = () => { const x = v.getUint16(p); p += 2; return x; };
    // Reads past the end yield 0 rather than throwing: a few real files run a
    // byte or two past the last track's declared length, and a RangeError
    // there would reject a song that is otherwise entirely fine.
    const u8  = () => (p < buf.byteLength ? v.getUint8(p++) : (p++, 0));
    const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
    const vlq = () => {
      let x = 0, b, n = 0;
      do { b = u8(); x = (x << 7) | (b & 0x7f); } while ((b & 0x80) && ++n < 4);
      return x;
    };

    if (str(4) !== 'MThd') throw new Error('Not a MIDI file (no MThd header).');
    const hlen = u32();
    u16();                                   // format
    u16();                                   // track count - a hint only, see below
    const div = u16();
    p += hlen - 6;
    if (div & 0x8000) throw new Error('SMPTE timecode MIDI files are not supported.');
    // A broken exporter writing 0 here used to poison every time downstream:
    // bar length 0, lengthTicks NaN, and a scheduler that advances by Infinity
    // seconds and then never plays another note - silence with no error.
    if (!div) throw new Error('That file declares no time division.');

    // The header's track count is only a hint - some exporters write 0 there
    // and still emit perfectly good MTrk chunks - so walk to the end of the
    // file instead. Chunks of any other type are skipped by their length
    // rather than ending the file, which is what the spec asks for.
    const tracks = [];
    while (p + 8 <= buf.byteLength) {
      const id = str(4);
      const len = u32();
      const end = Math.min(p + len, buf.byteLength);
      if (id !== 'MTrk') { p = end; continue; }
      let tick = 0, running = 0;
      const open = {};                       // key -> note being held
      const notes = [];
      let name = '';
      // Program and bank in effect per channel, so each note knows which
      // soundfont preset it wants.
      const prog = new Array(16).fill(0), bankM = new Array(16).fill(0);

      while (p < end) {
        tick += vlq();
        if (p >= end) break;
        let st = u8();
        // Only voice messages (0x80-0xef) may set running status. Letting meta
        // and SysEx set it too makes the next running-status event decode as
        // whichever system message came last, derailing the rest of the track.
        if (st < 0x80) { if (!running) break; p--; st = running; }
        else if (st < 0xf0) running = st;
        const type = st & 0xf0, ch = st & 0x0f;

        if (st === 0xff) {                   // meta
          const mt = u8(), ml = vlq();
          // ml is a 4-byte VLQ, so up to 268M. u8() reads past the end as 0,
          // so an unclamped str(ml) builds a quarter-billion-character string
          // and freezes the tab; one mis-synced running-status byte landing on
          // FF 03 is enough to trigger it.
          if (mt === 0x03 && !name) { const q = p; name = str(Math.min(ml, end - q)); p = q + ml; }
          else p += ml;
        } else if (st === 0xf0 || st === 0xf7) {
          // Read the length out first: `p += vlq()` evaluates p before vlq()
          // advances it, so the bytes the length field occupied are dropped,
          // p lands short, and every later event in the track is misread.
          const sl = vlq();
          p += sl;
        } else if (type === 0x90 || type === 0x80) {
          const n = u8(), vel = u8();
          const key = ch * 128 + n;
          if (type === 0x90 && vel > 0) {
            // A key is often struck again while it is still sounding - Doom
            // and Stonekeep files do it constantly - so keep a queue per key
            // and let each note-off close the oldest. A single slot per key
            // silently dropped whichever note was already held.
            (open[key] || (open[key] = [])).push({ midi: n, vel, start: tick, ch,
                          prog: prog[ch], bank: ch === 9 ? 128 : bankM[ch] });
          } else if (open[key] && open[key].length) {
            const o = open[key].shift();
            notes.push({ midi: o.midi, vel: o.vel, start: o.start,
                         dur: Math.max(1, tick - o.start), ch: o.ch,
                         prog: o.prog, bank: o.bank });
          }
        } else if (type === 0xb0) {
          const cc = u8(), val = u8();
          if (cc === 0) bankM[ch] = val;
        } else if (type === 0xa0 || type === 0xe0) { p += 2; }
        else if (type === 0xc0) { prog[ch] = u8(); }
        else if (type === 0xd0) { p += 1; }
        else if (st === 0xf2) { p += 2; }
        else if (st === 0xf1 || st === 0xf3) { p += 1; }
        // 0xf4-0xfe carry no data bytes. They have no business being in a
        // file, but a handful of these genuinely contain them, and giving up
        // on the track over one threw away everything after it.
      }
      p = end;

      // Anything still held at end-of-track gets a nominal length.
      for (const k in open) {
        for (const o of open[k]) {
          notes.push({ midi: o.midi, vel: o.vel, start: o.start, dur: div, ch: o.ch,
                       prog: o.prog, bank: o.bank });
        }
      }
      if (notes.length) {
        notes.sort((a, b) => a.start - b.start);
        // Format 0 files carry every instrument on a single track, separated
        // only by channel, so split on channel before assigning roles -
        // otherwise one channel-10 note makes the whole song percussion.
        const chans = [...new Set(notes.map(n => n.ch))].sort((a, b) => a - b);
        for (const ch of chans) {
          const cn = notes.filter(n => n.ch === ch);
          const avg = cn.reduce((s, n) => s + n.midi, 0) / cn.length;
          const tally = {};
          cn.forEach(n => { const k = n.bank + ':' + n.prog; tally[k] = (tally[k]||0)+1; });
          const top = Object.keys(tally).sort((a,b) => tally[b]-tally[a])[0].split(':');
          const label = trackLabel(name, +top[0], +top[1], tracks.length + 1);
          tracks.push({
            name: chans.length > 1 ? label + ' ch' + (ch + 1) : label,
            notes: cn, isDrum: ch === 9, avgPitch: avg, role: null,
            bank: +top[0], program: +top[1]
          });
        }
      }
    }
    if (!tracks.length) throw new Error('No notes found in that file.');
    return { tpq: div, tracks };
  }

  // Guess a role per track so a file is usable without any fiddling.
  // Files range from 4 tracks to 16+, so this both picks primary voices and
  // then distributes the remainder by character - dumping everything spare
  // into one role would make the layer gating meaningless.
  function assignRoles(tracks, tpq) {
    // Measured against the melodic tracks only: a 6000-hit drum track would
    // otherwise set the bar so high that every real part looks insubstantial,
    // and a four-note stab could then be picked as the bass.
    const melN = tracks.filter(t => !t.isDrum).map(t => t.notes.length);
    const maxN = Math.max.apply(null, melN.length ? melN : tracks.map(t => t.notes.length));
    tracks.forEach(t => {
      t.avgDur = t.notes.reduce((s, n) => s + n.dur, 0) / t.notes.length;
      // A handful of notes is usually a stab or a drone, not a main voice.
      t.substantial = t.notes.length >= Math.max(4, maxN * 0.05);
      t.role = t.isDrum ? 'drums' : null;
    });

    const mel = tracks.filter(t => !t.isDrum);
    if (!mel.length) return;
    const cand = mel.filter(t => t.substantial);
    const pick = cand.length ? cand : mel;

    // A lone melodic track carries the whole song, so it must not be routed
    // to the bass synth just for being the lowest thing present.
    if (mel.length === 1) {
      mel[0].role = mel[0].avgPitch < 48 ? 'bass' : 'keys';
      return;
    }

    const byPitch = pick.slice().sort((a, b) => a.avgPitch - b.avgPitch);
    byPitch[0].role = 'bass';
    if (byPitch.length > 1) byPitch[byPitch.length - 1].role = 'lead';
    const spare = pick.filter(t => !t.role);
    if (spare.length) {
      spare.sort((a, b) => b.avgDur - a.avgDur);
      spare[0].role = 'pad';
    }

    // Remaining tracks join whichever layer matches their character.
    //
    // Absolute pitch cutoffs do not survive contact with real files: Descent's
    // credits has five tracks averaging MIDI 32-47, so "below 48 is bass" put
    // 2144 of its 3891 notes on one saw bass - five parts playing the same
    // voice at once, which is mud rather than a bass line. Rank each track
    // within this song instead, and hard-cap the bass, because stacked
    // sawtooths at the bottom are the one pile-up that no compressor rescues.
    const MAX_BASS = 2;
    const order = mel.slice().sort((a, b) => a.avgPitch - b.avgPitch);
    const span = Math.max(1, order.length - 1);
    let bassCount = mel.filter(t => t.role === 'bass').length;
    order.forEach((t, i) => {
      if (t.role) return;
      if (t.avgDur >= tpq * 2) { t.role = 'pad'; return; }
      const frac = i / span;
      if (frac < 0.34 && bassCount < MAX_BASS) { t.role = 'bass'; bassCount++; }
      else if (frac > 0.75) t.role = 'lead';
      else t.role = 'keys';
    });
  }

  function loadParsed(parsed, name) {
    M.tpq = parsed.tpq;
    M.tracks = parsed.tracks;
    assignRoles(M.tracks, M.tpq);
    rebuildNotes();
    M.name = name;
    M.active = true;
    M.idx = 0; M.curTick = 0; M.curTime = 0;
  }

  function rebuildNotes() {
    M.notes = [];
    M.tracks.forEach((t, i) => {
      if (t.role === 'off') return;
      t.notes.forEach(n => M.notes.push({ ...n, trackIdx: i }));
    });
    M.notes.sort((a, b) => a.start - b.start);
    // Not Math.max(...notes): the spread passes one argument per note, and a
    // dense file runs past the engine's argument limit and throws a stack
    // overflow that surfaces as a bogus parse error.
    let end = 0;
    for (const n of M.notes) { const e = n.start + n.dur; if (e > end) end = e; }
    if (!end) end = M.tpq * 4;
    // Round the loop out to a whole bar so it rejoins the grid cleanly.
    const bar = M.tpq * 4;
    M.lengthTicks = Math.ceil(end / bar) * bar;
    // Changing one track's layer must not restart the song under the driver,
    // so keep the playhead and re-seek the note index to it.
    if (M.curTick >= M.lengthTicks) M.curTick = 0;
    M.idx = 0;
    while (M.idx < M.notes.length && M.notes[M.idx].start <= M.curTick) M.idx++;
  }

export { CREDITS, GM, M, PART, ROLES, ROLE_LABELS, assignRoles, loadParsed, looksLikeCredits, parseMidi, rebuildNotes, trackLabel };
