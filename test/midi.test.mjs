// The MIDI parser, scored against a deliberately strict reference reader.
//
// This is the test that has caught every parser bug so far (see git log for the
// seven fixed in 47088d9). Before the js/ split it could only run by slicing
// the function out of index.html with string markers; it now imports the module
// that ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseMidi, assignRoles, M, loadParsed, rebuildNotes } from '../js/midi.js';
import { refNotes } from './ref.mjs';

const FIX = path.join(import.meta.dirname, 'fixtures');
const read = n => {
  const b = fs.readFileSync(path.join(FIX, n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

// Format 1 (16 tracks) and format 0 (9 channels on one track). Each has already
// caught a real bug that the other missed, so both must stay.
const FILES = ['map29.mid', 'D_RUNNIN.mid'];

for (const name of FILES) {
  test(`${name}: finds every note the reference reader finds`, () => {
    const ab = read(name);
    const parsed = parseMidi(ab);
    const got = parsed.tracks.reduce((s, t) => s + t.notes.length, 0);
    assert.equal(got, refNotes(ab).notes.length);
  });

  test(`${name}: every note is finite and ordered`, () => {
    const parsed = parseMidi(read(name));
    for (const t of parsed.tracks) {
      for (const n of t.notes) {
        assert.ok(Number.isFinite(n.start), 'start is finite');
        assert.ok(Number.isFinite(n.dur), 'dur is finite');
        assert.ok(n.dur > 0, 'dur is positive');
        assert.ok(n.midi >= 0 && n.midi <= 127, 'midi in range');
        assert.ok(n.vel > 0 && n.vel <= 127, 'velocity in range');
      }
    }
  });

  test(`${name}: assignRoles gives every track a role`, () => {
    const parsed = parseMidi(read(name));
    assignRoles(parsed.tracks, parsed.tpq);
    for (const t of parsed.tracks) {
      assert.ok(t.role, `${t.name} has a role`);
      assert.ok(['drums', 'bass', 'pad', 'keys', 'lead', 'off'].includes(t.role));
    }
    // A file must never collapse into a single layer - that would make the
    // driving-gated mix meaningless.
    const roles = new Set(parsed.tracks.map(t => t.role));
    assert.ok(roles.size >= 2, 'more than one role in play');
  });
}

test('drum tracks are channel 10 and only channel 10', () => {
  const parsed = parseMidi(read('D_RUNNIN.mid'));
  assignRoles(parsed.tracks, parsed.tpq);
  for (const t of parsed.tracks) {
    assert.equal(t.role === 'drums', t.isDrum, `${t.name}: drums iff channel 10`);
  }
});

test('loadParsed rounds the loop out to a whole bar', () => {
  const parsed = parseMidi(read('map29.mid'));
  loadParsed(parsed, 'map29.mid');
  assert.equal(M.lengthTicks % (M.tpq * 4), 0);
  assert.ok(M.notes.length > 0);
  // flattened notes are sorted by start tick
  for (let i = 1; i < M.notes.length; i++) {
    assert.ok(M.notes[i].start >= M.notes[i - 1].start, 'notes sorted by start');
  }
});

test('a track set to off contributes no notes', () => {
  const parsed = parseMidi(read('map29.mid'));
  loadParsed(parsed, 'map29.mid');
  const before = M.notes.length;
  const victim = M.tracks.findIndex(t => t.notes.length > 0);
  const lost = M.tracks[victim].notes.length;
  M.tracks[victim].role = 'off';
  rebuildNotes();
  assert.equal(M.notes.length, before - lost);
});

test('garbage input is rejected, not silently accepted', () => {
  assert.throws(() => parseMidi(new Uint8Array(64).buffer));
  assert.throws(() => parseMidi(new TextEncoder().encode('not a midi file at all').buffer));
});
