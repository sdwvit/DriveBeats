// The SoundFont reader and voice.
//
// Everything here is a generator-level bug: the font parsed, the samples
// loaded, and the note played - just not the note the font describes. They are
// invisible without a real font in front of you, so the fixture builds one
// byte for byte (see sf2-fixture.mjs) and each case varies a single record.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAudioContext } from './fake-audio.mjs';
import { buildSf2 } from './sf2-fixture.mjs';
import {
  GEN, SF, cachedZones, loadSamples, neededSamples, parseSf2, presetCache,
  sampleUsable, sfVoice
} from '../js/sf2.js';

// A Blob-like stand-in: parseSf2 only ever calls file.slice().arrayBuffer().
function fakeFile(bytes, name = 'test.sf2') {
  return {
    name, size: bytes.length,
    slice(a, b) {
      const part = bytes.slice(a, b);
      return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
    }
  };
}

// 200 frames of ramp, so a slice can be checked against the frame it should
// have started at rather than against silence.
const PCM = new Int16Array(200);
for (let i = 0; i < PCM.length; i++) PCM[i] = i * 100;

const SAMPLE = {
  name: 'saw', start: 0, end: 200, loopStart: 50, loopEnd: 150,
  rate: 44100, pitch: 60, correction: 0, type: 1
};

const g = (op, v) => ({ op, v });
const range = (op, lo, hi) => ({ op, lo, hi });

/** A one-preset, one-instrument, one-sample font with the given zone gens. */
function font({ izones, pzones = [[g(GEN.instrument, 0)]], samples = [SAMPLE] }) {
  return fakeFile(buildSf2({
    pcm: PCM, samples,
    instruments: [{ name: 'inst', zones: izones }],
    presets: [{ name: 'preset', bank: 0, program: 0, zones: pzones }]
  }));
}

let ctx;
beforeEach(() => { ctx = new FakeAudioContext(); presetCache.clear(); });

const zone = (key = 60, vel = 100) => cachedZones(0, 0, key, vel);
const nodeOf = (c, type) => c.log.find(e => e.op === 'create' && e.node === type);
const events = (c, id, param) => c.log
  .filter(e => e.id === id && e.param === param)
  .sort((a, b) => a.time - b.time);

// ---------------------------------------------------------------
// the fixture itself
// ---------------------------------------------------------------

test('the fixture is a font parseSf2 can actually read', async () => {
  const r = await parseSf2(font({ izones: [[g(GEN.sampleID, 0)]] }));
  assert.deepEqual(r, { presets: 1, instruments: 1, samples: 2 }, 'samples counts the EOS terminal');
  assert.equal(SF.presets[0].name, 'preset');
  assert.equal(SF.instruments[0].zones.length, 1);
  assert.equal(SF.instruments[0].zones[0].id, 0);
  assert.equal(SF.smplLen, PCM.byteLength);
});

// ---------------------------------------------------------------
// global-zone inheritance
// ---------------------------------------------------------------

test('a global zone gives its generators to the zones after it', async () => {
  await parseSf2(font({
    izones: [
      [g(GEN.pan, 250)],                       // global: no sampleID
      [g(GEN.sampleID, 0)]
    ]
  }));
  const z = SF.instruments[0].zones;
  assert.equal(z.length, 1, 'the global zone is not a playable zone of its own');
  assert.equal(z[0].gens[GEN.pan], 250);
});

test('a zone that states its own value keeps it over the global', async () => {
  await parseSf2(font({
    izones: [[g(GEN.pan, 250)], [g(GEN.sampleID, 0), g(GEN.pan, -500)]]
  }));
  assert.equal(SF.instruments[0].zones[0].gens[GEN.pan], -500);
});

test('a global velRange is inherited, not just a global keyRange', async () => {
  // velRange was consumed like keyRange but never copied down from the global,
  // so a font stating its velocity split once at the top had every zone
  // answering to every velocity: a soft note played the fortissimo sample on
  // top of the piano one.
  await parseSf2(font({
    izones: [
      [range(GEN.velRange, 0, 63)],
      [g(GEN.sampleID, 0)]
    ]
  }));
  const z = SF.instruments[0].zones[0];
  assert.deepEqual([z.velLo, z.velHi], [0, 63]);
  assert.equal(zone(60, 100).length, 0, 'a loud note must not reach a soft-only zone');
  assert.equal(zone(60, 40).length, 1);
});

test('a zone stating the full 0-127 range is not narrowed by the global', async () => {
  await parseSf2(font({
    izones: [
      [range(GEN.velRange, 0, 63)],
      [g(GEN.sampleID, 0), range(GEN.velRange, 0, 127)]
    ]
  }));
  assert.equal(zone(60, 127).length, 1);
});

test('an id-less zone that is not the first is dropped, not adopted as global', async () => {
  // Adopting it would leak its generators into every zone after it.
  await parseSf2(font({
    izones: [
      [g(GEN.sampleID, 0)],
      [g(GEN.pan, 500)],                       // malformed: no sampleID, not first
      [g(GEN.sampleID, 0), g(GEN.coarseTune, 12)]
    ]
  }));
  const z = SF.instruments[0].zones;
  assert.equal(z.length, 2);
  assert.equal(z[1].gens[GEN.pan], undefined, 'junk must not reach the later zone');
});

// ---------------------------------------------------------------
// ROM samples
// ---------------------------------------------------------------

test('a ROM sample is never sliced out of the file', async () => {
  // Bit 15 of shdr.type means the addresses point into the synth's own
  // wavetable ROM. Slicing smpl there yields unrelated PCM - noise at full
  // volume - so the sample is skipped and the note falls back to the synth.
  const rom = { ...SAMPLE, name: 'rom', type: 0x8001 };
  await parseSf2(font({ izones: [[g(GEN.sampleID, 0)]], samples: [rom] }));
  assert.equal(sampleUsable(SF.samples[0]), false);

  const tracks = [{ notes: [{ midi: 60, vel: 100, bank: 0, prog: 0 }] }];
  assert.equal(neededSamples(tracks).size, 1, 'the zone still resolves');
  const r = await loadSamples(tracks, ctx);
  assert.equal(r.samples, 0, 'but nothing is read for it');
  assert.equal(SF.buffers.size, 0);
});

test('a sample whose end runs past the smpl chunk is skipped', async () => {
  const liar = { ...SAMPLE, end: 5000 };
  await parseSf2(font({ izones: [[g(GEN.sampleID, 0)]], samples: [liar] }));
  assert.equal(sampleUsable(SF.samples[0]), false);
});

// ---------------------------------------------------------------
// the voice: loop offsets and sample modes
// ---------------------------------------------------------------

/** Parse, load, and voice one note. Returns the fake nodes it created. */
async function voice(izones, { key = 60, vel = 100, dur = 1, gain = 0.5 } = {}) {
  await parseSf2(font({ izones }));
  const tracks = [{ notes: [{ midi: key, vel, bank: 0, prog: 0 }] }];
  await loadSamples(tracks, ctx);
  ctx.clear();
  const dest = ctx.createGain();
  ctx.clear();
  const zs = zone(key, vel);
  assert.ok(zs.length, 'the note must resolve to a zone');
  const ok = sfVoice(ctx, zs[0], key, vel, 0, dur, gain, dest);
  return { ok, src: nodeOf(ctx, 'bufferSource'), gainNode: nodeOf(ctx, 'gain'), zs };
}

test('sampleModes 1 loops, and the loop points come from the shdr', async () => {
  const { ok, src } = await voice([[g(GEN.sampleID, 0), g(GEN.sampleModes, 1)]]);
  assert.equal(ok, true);
  // loopStart/loopEnd are frames 50 and 150 of the buffer, at the context rate.
  const bs = ctxNode(ctx, src.id);
  assert.equal(bs.loop, true);
  assert.equal(Math.round(bs.loopStart * ctx.sampleRate), 50);
  assert.equal(Math.round(bs.loopEnd * ctx.sampleRate), 150);
});

test('a zone can move the loop with the address-offset generators', async () => {
  // Two zones sharing a sample are exactly why these exist. Ignoring them gave
  // every zone the shdr's loop, which is the one thing they override.
  const { src } = await voice([[
    g(GEN.sampleID, 0), g(GEN.sampleModes, 1),
    g(GEN.startloopAddrsOffset, 10), g(GEN.endloopAddrsOffset, -20)
  ]]);
  const bs = ctxNode(ctx, src.id);
  assert.equal(Math.round(bs.loopStart * ctx.sampleRate), 60);
  assert.equal(Math.round(bs.loopEnd * ctx.sampleRate), 130);
});

test('sampleModes 3 plays straight through so its release tail survives', async () => {
  // Mode 3 is "loop while depressed, then play the remainder". A BufferSource
  // cannot be un-looped at a scheduled time, so looping it would mean the
  // remainder - the whole point of mode 3 - never plays.
  const { src } = await voice([[g(GEN.sampleID, 0), g(GEN.sampleModes, 3)]]);
  assert.equal(ctxNode(ctx, src.id).loop, false);
});

test('sampleModes 0 does not loop', async () => {
  const { src } = await voice([[g(GEN.sampleID, 0)]]);
  assert.equal(ctxNode(ctx, src.id).loop, false);
});

test('a loop that runs past the sample is ignored rather than trusted', async () => {
  const bad = { ...SAMPLE, loopStart: 50, loopEnd: 5000 };
  await parseSf2(font({ izones: [[g(GEN.sampleID, 0), g(GEN.sampleModes, 1)]], samples: [bad] }));
  const tracks = [{ notes: [{ midi: 60, vel: 100, bank: 0, prog: 0 }] }];
  await loadSamples(tracks, ctx);
  ctx.clear();
  sfVoice(ctx, zone()[0], 60, 100, 0, 1, 0.5, ctx.createGain());
  assert.equal(ctxNode(ctx, nodeOf(ctx, 'bufferSource').id).loop, false);
});

test('startAddrsOffset starts the note inside the sample', async () => {
  const { src } = await voice([[g(GEN.sampleID, 0), g(GEN.startAddrsOffset, 40)]]);
  const start = ctx.log.find(e => e.id === src.id && e.op === 'start');
  assert.equal(Math.round(start.offset * ctx.sampleRate), 40);
  assert.equal(start.time, 0, 'the note still starts when it was scheduled');
});

test('an out-of-range startAddrsOffset does not lose the voice', async () => {
  // start() with an offset past the buffer throws, and the note vanishes.
  const { ok, src } = await voice([[g(GEN.sampleID, 0), g(GEN.startAddrsOffset, 9999)]]);
  assert.equal(ok, true);
  const start = ctx.log.find(e => e.id === src.id && e.op === 'start');
  assert.equal(start.offset, 0, 'the bad offset is dropped, the note is not');
});

// ---------------------------------------------------------------
// the voice: note-off
// ---------------------------------------------------------------

test('note-off truncates the decay instead of deleting it', async () => {
  // cancelScheduledValues(off) removes any ramp ENDING at or after off, so a
  // long decay under a short note was deleted outright and the gain held at
  // peak until it stepped down - a click, and a note far louder than written.
  // The pinned value has to sit between sustain and peak.
  const { gainNode } = await voice([[
    g(GEN.sampleID, 0),
    g(GEN.attackVolEnv, -12000),          // ~1ms
    g(GEN.decayVolEnv, 1200),             // 2s decay
    g(GEN.sustainVolEnv, 600)             // -6dB sustain
  ]], { dur: 0.5 });

  const gs = events(ctx, gainNode.id, 'gain');
  const peak = Math.max(...gs.map(e => e.value ?? 0));
  const atOff = gs.filter(e => Math.abs(e.time - 0.5) < 1e-6 && e.op !== 'cancel');
  assert.equal(atOff.length, 1, 'the level at note-off is pinned exactly once');
  // The scheduled decay is exponential from peak to sust (-60dB) over 2s, so
  // a quarter of the way through it sits at peak * 0.001^0.25 = peak * 0.178.
  // The point is that it is strictly between the two, not pinned at either.
  const held = atOff[0].value;
  const sust = peak * 0.001;
  assert.ok(held < peak, 'the decay had started, so it is below peak');
  assert.ok(held > sust * 10, 'and it is nowhere near finished');
  assert.ok(Math.abs(held - peak * Math.pow(0.001, 0.25)) < peak * 0.02,
    'it is read off the decay curve, not guessed');

  // ...and the cancel comes after the pin, or it would remove it too.
  const cancel = gs.concat(ctx.log.filter(e => e.id === gainNode.id && e.op === 'cancel'))
    .find(e => e.op === 'cancel' && e.time >= 0.5);
  assert.ok(cancel.time > atOff[0].time, 'cancelled after the pin, not at it');
});

test('a note shorter than its attack releases from where the attack got to', async () => {
  // Reading the attack as a linear ramp put the release far above the real
  // level, which is a jump up on note-off - audible on every staccato note.
  const { gainNode } = await voice([[
    g(GEN.sampleID, 0), g(GEN.attackVolEnv, 0)   // 1s attack
  ]], { dur: 0.05, gain: 0.5 });

  const pin = events(ctx, gainNode.id, 'gain')
    .find(e => Math.abs(e.time - 0.05) < 1e-6 && e.op === 'setValueAtTime');
  assert.ok(pin, 'the level at note-off is pinned');
  // An exponential from 1e-4 to 0.5 is at ~1.6e-4 after 5% of its attack; a
  // linear read of the same ramp would give 0.025, over a hundred times louder.
  assert.ok(pin.value < 0.001, 'read off the exponential, not a straight line');
  assert.ok(pin.value > 1e-4);
});

// ---------------------------------------------------------------
// the voice: exclusiveClass
// ---------------------------------------------------------------

test('a later note in an exclusive class chokes the one before it', async () => {
  await parseSf2(font({ izones: [[g(GEN.sampleID, 0), g(GEN.exclusiveClass, 1)]] }));
  const tracks = [{ notes: [{ midi: 60, vel: 100, bank: 0, prog: 0 }] }];
  await loadSamples(tracks, ctx);
  const dest = ctx.createGain();
  const z = zone()[0];

  ctx.clear();                 // or nodeOf would find `dest` instead
  sfVoice(ctx, z, 60, 100, 0, 2, 0.5, dest);
  const first = nodeOf(ctx, 'gain');
  ctx.clear();
  sfVoice(ctx, z, 60, 100, 0.5, 2, 0.5, dest);

  const choke = ctx.log.filter(e => e.id === first.id && e.param === 'gain');
  assert.ok(choke.some(e => e.op === 'exponentialRamp' && e.time > 0.5 && e.time < 0.52),
    'the open hat is ramped out ~12ms after the closed one starts');
});

test('the two zones of one stereo note do not choke each other', async () => {
  // Both zones voice at the same instant with the same exclusiveClass, so the
  // second one used to cut the first 12ms in: the note played mono and clipped.
  await parseSf2(font({
    izones: [
      [g(GEN.sampleID, 0), g(GEN.exclusiveClass, 1), g(GEN.pan, -500)],
      [g(GEN.sampleID, 0), g(GEN.exclusiveClass, 1), g(GEN.pan, 500)]
    ]
  }));
  const tracks = [{ notes: [{ midi: 60, vel: 100, bank: 0, prog: 0 }] }];
  await loadSamples(tracks, ctx);
  const dest = ctx.createGain();
  const zs = zone();
  assert.equal(zs.length, 2, 'a stereo note is two zones');

  ctx.clear();
  sfVoice(ctx, zs[0], 60, 100, 0, 2, 0.5, dest);
  const left = nodeOf(ctx, 'gain');
  ctx.clear();
  sfVoice(ctx, zs[1], 60, 100, 0, 2, 0.5, dest);

  const cut = ctx.log.filter(e => e.id === left.id && e.param === 'gain');
  assert.deepEqual(cut, [], 'the left half is left alone');
});

test('the same key at the same time on a different bus is a different note', async () => {
  // The drum bus and the pan bus are two destinations; a note on one must not
  // be treated as the same note on the other.
  await parseSf2(font({ izones: [[g(GEN.sampleID, 0), g(GEN.exclusiveClass, 1)]] }));
  await loadSamples([{ notes: [{ midi: 60, vel: 100, bank: 0, prog: 0 }] }], ctx);
  const z = zone()[0];

  const destA = ctx.createGain(), destB = ctx.createGain();
  ctx.clear();
  sfVoice(ctx, z, 60, 100, 0, 2, 0.5, destA);
  const first = nodeOf(ctx, 'gain');
  ctx.clear();
  sfVoice(ctx, z, 60, 100, 0, 2, 0.5, destB);

  assert.ok(ctx.log.some(e => e.id === first.id && e.param === 'gain'),
    'a second destination is a second note, so the first is choked');
});

// ---------------------------------------------------------------
// sfSync: two songs picked in quick succession
// ---------------------------------------------------------------

test('a song picked during a sample load is not left on the old samples', async () => {
  // Loading takes seconds and the second file arrives inside them. Returning
  // early while a load was in flight left the new song playing the previous
  // one's samples, with the status line claiming it had loaded.
  const { initAudio } = await import('../js/engine.js');
  const { M } = await import('../js/midi.js');
  const { sfSync } = await import('../js/playback.js');

  initAudio(ctx);
  await parseSf2(font({ izones: [[g(GEN.sampleID, 0)]] }));
  M.active = true;
  M.tracks = [{ notes: [{ midi: 60, vel: 100, bank: 0, prog: 0 }] }];

  // Count entries into the load, not every progress callback.
  let loads = 0, wasLoading = false;
  SF.onChange = () => {
    const now = SF.status.startsWith('Loading');
    if (now && !wasLoading) loads++;
    wasLoading = now;
  };

  const first = sfSync();
  const second = sfSync();                 // while the first is still running
  M.tracks = [{ notes: [{ midi: 72, vel: 100, bank: 0, prog: 0 }] }];
  await Promise.all([first, second]);

  SF.onChange = null;
  assert.equal(loads, 2, 'the request made during the load is serviced after it');
  assert.equal(SF.loading, false);
  assert.match(SF.status, /samples/);
});

test('a font cleared mid-load does not leave loaded samples behind', async () => {
  const { initAudio } = await import('../js/engine.js');
  const { M } = await import('../js/midi.js');
  const { sfSync, sfReset } = await import('../js/playback.js');

  initAudio(ctx);
  await parseSf2(font({ izones: [[g(GEN.sampleID, 0)]] }));
  M.active = true;
  M.tracks = [{ notes: [{ midi: 60, vel: 100, bank: 0, prog: 0 }] }];

  const p = sfSync();
  sfReset();                               // the driver taps "Use synth"
  await p;

  assert.equal(SF.ready, false, 'nothing is playable from a font that is gone');
  assert.equal(SF.buffers.size, 0);
});

// A FakeNode carries its own live properties (loop, loopStart, buffer); the log
// only records automation, so reach for the node itself.
function ctxNode(c, id) {
  return c._nodes.get(id);
}
