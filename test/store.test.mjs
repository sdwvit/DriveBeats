// The MIDI library: many files kept, one of them current.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeIndexedDB } from './fake-idb.mjs';

const FIX = path.join(import.meta.dirname, 'fixtures');
const read = n => {
  const b = fs.readFileSync(path.join(FIX, n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

let db;
beforeEach(() => { db = globalThis.indexedDB = fakeIndexedDB(); });

const store = await import('../js/midi-store.js');
const { M } = await import('../js/midi.js');

test('an uploaded file is kept and becomes current', async () => {
  await store.saveMidi('map29.mid', read('map29.mid'), null);
  const list = await store.listMidi();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'map29.mid');
  assert.equal(db.data.get('current').name, 'map29.mid');
});

test('a second upload joins the library rather than replacing the first', async () => {
  await store.saveMidi('map29.mid', read('map29.mid'), null);
  await store.saveMidi('D_RUNNIN.mid', read('D_RUNNIN.mid'), null);
  const names = (await store.listMidi()).map(f => f.name);
  assert.equal(names.length, 2);
  assert.ok(names.includes('map29.mid'));
  assert.ok(names.includes('D_RUNNIN.mid'));
  assert.equal(db.data.get('current').name, 'D_RUNNIN.mid', 'newest is current');
});

test('picking a stored file loads it and makes it current', async () => {
  await store.saveMidi('map29.mid', read('map29.mid'), null);
  await store.saveMidi('D_RUNNIN.mid', read('D_RUNNIN.mid'), null);

  const buf = await store.loadMidiNamed('map29.mid');
  assert.ok(buf, 'returned the buffer');
  assert.equal(M.name, 'map29.mid');
  assert.ok(M.active);
  assert.ok(M.notes.length > 0);
  assert.equal(db.data.get('current').name, 'map29.mid');
});

test('picking a name that is not there changes nothing', async () => {
  await store.saveMidi('map29.mid', read('map29.mid'), null);
  await store.loadMidiNamed('map29.mid');
  const before = M.name;
  assert.equal(await store.loadMidiNamed('nope.mid'), null);
  assert.equal(M.name, before);
});

test('per-track roles survive a round trip', async () => {
  await store.saveMidi('map29.mid', read('map29.mid'), null);
  await store.loadMidiNamed('map29.mid');
  const roles = M.tracks.map((t, i) => i === 0 ? 'off' : t.role);
  await store.saveMidi('map29.mid', read('map29.mid'), roles);

  M.tracks = [];
  await store.loadMidiNamed('map29.mid');
  assert.deepEqual(M.tracks.map(t => t.role), roles);
});

test('re-uploading the same name keeps its place in the list', async () => {
  await store.saveMidi('a.mid', read('map29.mid'), null);
  const first = (await store.listMidi())[0].added;
  await store.saveMidi('b.mid', read('D_RUNNIN.mid'), null);
  await store.saveMidi('a.mid', read('map29.mid'), null);
  const a = (await store.listMidi()).find(f => f.name === 'a.mid');
  assert.equal(a.added, first, 'added date is not bumped by a re-upload');
});

test('deleting the current file falls back to the generator', async () => {
  await store.saveMidi('map29.mid', read('map29.mid'), null);
  await store.loadMidiNamed('map29.mid');
  await store.deleteMidi('map29.mid');
  assert.deepEqual(await store.listMidi(), []);
  assert.equal(db.data.get('current'), undefined, 'pointer cleared too');
});

test('deleting another file leaves the current one alone', async () => {
  await store.saveMidi('map29.mid', read('map29.mid'), null);
  await store.saveMidi('D_RUNNIN.mid', read('D_RUNNIN.mid'), null);
  await store.deleteMidi('map29.mid');
  assert.equal(db.data.get('current').name, 'D_RUNNIN.mid');
  assert.equal((await store.listMidi()).length, 1);
});

test('"Use built-in" keeps the library', async () => {
  await store.saveMidi('map29.mid', read('map29.mid'), null);
  await store.clearMidi();
  assert.equal(M.active, false);
  assert.equal(db.data.get('current'), undefined);
  assert.equal((await store.listMidi()).length, 1, 'the file is still there to pick again');
});

test('an existing single-file install is migrated into the library', async () => {
  // The old shape: 'current' held the record itself, with no library entry.
  db.data.set('current', { name: 'old.mid', buf: read('map29.mid'), roles: null });

  const buf = await store.loadSavedMidi();
  assert.ok(buf, 'the old file still loads');
  assert.equal(M.name, 'old.mid');

  const list = await store.listMidi();
  assert.equal(list.length, 1, 'it is now a library entry');
  assert.equal(list[0].name, 'old.mid');
  assert.equal(db.data.get('current').name, 'old.mid');
  assert.equal(db.data.get('current').buf, undefined, 'pointer is just a pointer now');

  // and a second load goes down the new path
  M.tracks = [];
  assert.ok(await store.loadSavedMidi());
  assert.equal(M.name, 'old.mid');
});

test('a store that cannot be opened degrades to no library', async () => {
  globalThis.indexedDB = { open() { const r = {}; queueMicrotask(() => r.onerror && r.onerror()); return r; } };
  assert.deepEqual(await store.listMidi(), []);
  assert.equal(await store.loadSavedMidi(), null);
  await store.saveMidi('x.mid', read('map29.mid'), null);   // must not throw
  await store.deleteMidi('x.mid');
});
