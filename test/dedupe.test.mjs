// Muting duplicate parts.
//
// Early-90s MIDIs ship alternate arrangements in one file, because a file was
// expected to play on whatever sound card you had: Descent 2's credits carries
// Slap Bass 1 and Synth Bass 1 playing identical notes. We play both, so the
// part comes out doubled.
//
// The risk is the opposite case - two instruments deliberately in unison - so
// the match here is exact and these check that it stays exact.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { M, MIN_DUP_NOTES, loadParsed, markDuplicates, parseMidi, rebuildNotes } from '../js/midi.js';

const FIX = path.join(import.meta.dirname, 'fixtures');
const read = n => {
  const b = fs.readFileSync(path.join(FIX, n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

beforeEach(() => { M.dedupe = false; });

/** n notes, ascending, one per beat. */
const line = (n, from = 60) =>
  Array.from({ length: n }, (_, i) => ({ midi: from + (i % 5), start: i * 120, dur: 100, vel: 90 }));

const track = (name, notes, extra = {}) => ({ name, notes, isDrum: false, role: null, ...extra });

test('a note-for-note copy is marked, and the original is not', () => {
  const notes = line(20);
  const tracks = [track('a', notes), track('b', notes.map(n => ({ ...n })))];
  assert.equal(markDuplicates(tracks), 1);
  assert.equal(tracks[0].dupOf, null, 'the first one is the part');
  assert.equal(tracks[1].dupOf, 0, 'the second one is the copy');
});

test('a different velocity is still the same part', () => {
  // An alternate arrangement is often mixed a little differently. That does not
  // make it another part, so velocity is not compared.
  const notes = line(20);
  const tracks = [track('a', notes), track('b', notes.map(n => ({ ...n, vel: 40 })))];
  assert.equal(markDuplicates(tracks), 1);
});

test('one note moved by one tick is a different part', () => {
  const notes = line(20);
  const other = notes.map(n => ({ ...n }));
  other[7].start += 1;
  const tracks = [track('a', notes), track('b', other)];
  assert.equal(markDuplicates(tracks), 0, 'the match is exact, or it is not a match');
});

test('one note transposed is a different part', () => {
  // This is the case that matters: unison doubling an octave apart, or a
  // harmony line, must survive.
  const notes = line(20);
  const tracks = [track('a', notes), track('b', notes.map(n => ({ ...n, midi: n.midi + 12 })))];
  assert.equal(markDuplicates(tracks), 0);
});

test('a different note length is a different part', () => {
  const notes = line(20);
  const tracks = [track('a', notes), track('b', notes.map(n => ({ ...n, dur: 60 })))];
  assert.equal(markDuplicates(tracks), 0);
});

test('short tracks are left alone however well they match', () => {
  // Two stabs landing together are not evidence of anything.
  const notes = line(MIN_DUP_NOTES - 1);
  const tracks = [track('a', notes), track('b', notes.map(n => ({ ...n })))];
  assert.equal(markDuplicates(tracks), 0);
});

test('three copies of one part leave one playing', () => {
  const notes = line(20);
  const tracks = [track('a', notes), track('b', notes.map(n => ({ ...n }))), track('c', notes.map(n => ({ ...n })))];
  assert.equal(markDuplicates(tracks), 2);
  assert.deepEqual(tracks.map(t => t.dupOf), [null, 0, 0], 'both copies point at the original');
});

// ---------------------------------------------------------------
// what it does to playback
// ---------------------------------------------------------------

test('the copy is dropped only while the box is ticked', () => {
  loadParsed(parseMidi(read('credits.mid')), 'credits.mid');
  const dup = M.tracks.filter(t => t.dupOf != null);
  assert.ok(dup.length, 'the fixture has a copy in it');

  M.dedupe = false; rebuildNotes();
  const both = M.notes.length;
  M.dedupe = true; rebuildNotes();
  const one = M.notes.length;

  const dropped = dup.reduce((s, t) => s + t.notes.length, 0);
  assert.equal(both - one, dropped, 'exactly the copy is gone, nothing else');

  M.dedupe = false; rebuildNotes();
  assert.equal(M.notes.length, both, 'and unticking brings it straight back');
});

test('toggling the box does not restart the song', () => {
  loadParsed(parseMidi(read('credits.mid')), 'credits.mid');
  M.curTick = 4000;
  M.dedupe = true; rebuildNotes();
  assert.equal(M.curTick, 4000, 'the playhead is where the driver left it');
  assert.ok(M.notes[M.idx] === undefined || M.notes[M.idx].start > M.curTick,
    'and the note index was re-seeked to it');
});

test("credits.mid's two basses are the same part", () => {
  // Slap Bass 1 and Synth Bass 1, 314 notes each, note for note.
  loadParsed(parseMidi(read('credits.mid')), 'credits.mid');
  const dup = M.tracks.filter(t => t.dupOf != null);
  assert.equal(dup.length, 1);
  assert.match(dup[0].name, /Bass/);
  assert.match(M.tracks[dup[0].dupOf].name, /Bass/);
});

test("credits.mid's two electric guitars are not", () => {
  // They look like a duplicate pair - same instrument, 572 and 576 notes - and
  // they are not: no two notes share a pitch and a tick. This is the case the
  // exact match exists to protect.
  loadParsed(parseMidi(read('credits.mid')), 'credits.mid');
  const gtr = M.tracks.filter(t => /Electric Guitar/.test(t.name));
  assert.equal(gtr.length, 2);
  assert.ok(gtr.every(t => t.dupOf == null));
});

test('files with no copies in them are untouched', () => {
  for (const f of ['map29.mid', 'D_RUNNIN.mid']) {
    loadParsed(parseMidi(read(f)), f);
    assert.equal(M.tracks.filter(t => t.dupOf != null).length, 0, f);
    M.dedupe = false; rebuildNotes();
    const before = M.notes.length;
    M.dedupe = true; rebuildNotes();
    assert.equal(M.notes.length, before, f + ' plays exactly as before');
  }
});
