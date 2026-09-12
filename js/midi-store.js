import { silenceAll } from './engine.js';
import { M, loadParsed, parseMidi, rebuildNotes } from './midi.js';

  // ---- IndexedDB -------------------------------------------------
  //
  // Every uploaded file is kept under 'midi:<name>', and 'current' is a pointer
  // to whichever one is loaded. Before this there was a single 'current' record
  // holding the file itself; that shape is migrated on first read, so an
  // existing install keeps the file it already had.
  //
  // Reads and writes are separate one-shot transactions. An IndexedDB
  // transaction closes as soon as its requests drain, so awaiting a read and
  // then issuing a write inside the same one is a portability trap; there is
  // only ever one user here, so nothing is lost by not sharing a transaction.
  //
  // One connection is opened and then reused. Opening a fresh one per call
  // meant dozens of live connections, and an open connection blocks a version
  // change: the day the schema is bumped, the upgrade fires onblocked - which
  // nothing handled - and startup waits for a deleteDatabase that never comes.
  // So: a single cached connection, closed as soon as another tab asks for an
  // upgrade (onversionchange), and onblocked rejected with something the UI can
  // actually show instead of hanging.
  //
  // The cache is keyed on the indexedDB object itself so that swapping the
  // global - which is what the tests do between cases - cannot hand back a
  // connection into the store that was just thrown away.
  let conn = null, connFor = null;

  function idb() {
    if (conn && connFor === indexedDB) return conn;
    connFor = indexedDB;
    conn = new Promise((res, rej) => {
      const r = indexedDB.open('drivebeats', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onblocked = () => rej(new Error('Another DriveBeats tab is open. Close it and reload.'));
      r.onsuccess = () => {
        const db = r.result;
        // Hold nothing open across a schema change, in either direction: drop
        // the connection and the cache so the next call opens the new version.
        db.onversionchange = () => { closeDb(); try { db.close(); } catch (e) {} };
        db.onclose = () => closeDb();
        res(db);
      };
      r.onerror = () => { closeDb(); rej(r.error); };
    });
    // A failed open must not be cached as the answer for every later call.
    conn.catch(() => closeDb());
    return conn;
  }

  function closeDb() { conn = null; connFor = null; }

  const KEY = name => 'midi:' + name;

  function request(mode, fn) {
    return idb().then(db => new Promise((res, rej) => {
      const tx = db.transaction('files', mode);
      const q = fn(tx.objectStore('files'));
      if (q) { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }
      else { tx.oncomplete = () => res(); }
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    }));
  }

  const getKey = key => request('readonly', os => os.get(key));
  const putKey = (key, val) => request('readwrite', os => { os.put(val, key); });
  const delKey = key => request('readwrite', os => { os.delete(key); });

  /** Store a file and make it current. Returns null on success, else a message.
   *
   *  The failure that matters here is the quota: a few MIDI files are nothing,
   *  but a browser in private mode - or one already full - rejects the write.
   *  Swallowing that left the song playing and apparently saved, with the
   *  library silently empty and the file gone on the next reload. It is not
   *  fatal, so nothing throws, but the caller has to be able to say so.
   */
  async function saveMidi(name, buf, roles) {
    try {
      const prev = await getKey(KEY(name)).catch(() => null);
      await putKey(KEY(name), { name, buf, roles, added: (prev && prev.added) || Date.now() });
      await putKey('current', { name });
      return null;
    } catch (e) {
      const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
      return quota
        ? 'Not enough storage to keep this file, so it is playing but not saved.'
        : 'This file is playing but could not be saved: ' + ((e && e.message) || e);
    }
  }

  /** Every stored file, most recently added first. Never throws. */
  async function listMidi() {
    try {
      const all = await request('readonly', os => os.getAll());
      return (all || [])
        .filter(r => r && r.name && r.buf)
        .sort((a, b) => (b.added || 0) - (a.added || 0))
        .map(r => ({ name: r.name, bytes: r.buf.byteLength, added: r.added || 0 }));
    } catch (e) { return []; }
  }

  /** Apply a stored record to M. Returns its buffer, or null. */
  function apply(rec) {
    if (!rec || !rec.buf) return null;
    loadParsed(parseMidi(rec.buf), rec.name);
    if (rec.roles && rec.roles.length === M.tracks.length) {
      M.tracks.forEach((t, i) => t.role = rec.roles[i]);
      rebuildNotes();
    }
    // The caller keeps the buffer so it can re-save when roles change.
    return rec.buf;
  }

  /** Load one file from the library by name and make it current. */
  async function loadMidiNamed(name) {
    try {
      const rec = await getKey(KEY(name));
      if (!rec) return null;
      const buf = apply(rec);
      if (buf) await putKey('current', { name });
      return buf;
    } catch (e) { return null; }
  }

  async function loadSavedMidi() {
    try {
      const cur = await getKey('current');
      if (!cur) return null;
      // Old format: 'current' held the record itself. Move it into the library.
      if (cur.buf) {
        await putKey(KEY(cur.name), { name: cur.name, buf: cur.buf, roles: cur.roles, added: Date.now() });
        await putKey('current', { name: cur.name });
        return apply(cur);
      }
      return apply(await getKey(KEY(cur.name)));
    } catch (e) { return null; }
  }

  /** Forget one stored file. Clears the pointer too if it was current. */
  async function deleteMidi(name) {
    try {
      await delKey(KEY(name));
      const cur = await getKey('current').catch(() => null);
      if (cur && cur.name === name) await delKey('current');
    } catch (e) {}
  }

  /** Wipe everything this app has stored: the whole library and the pointer.
   *  The caller resets its own in-memory state; nothing here throws. */
  async function resetStorage() {
    try { await request('readwrite', os => { os.clear(); }); } catch (e) {}
  }

  /** Back to the built-in generator. The library is kept. */
  async function clearMidi() {
    // Back to the generator, but the file's notes are scheduled ahead of the
    // playhead and would keep playing underneath it.
    silenceAll();
    M.active = false; M.name = null; M.tracks = []; M.notes = []; M.gen++;
    try { await delKey('current'); } catch (e) {}
  }

export { clearMidi, closeDb, deleteMidi, idb, listMidi, loadMidiNamed, loadSavedMidi, resetStorage, saveMidi };
