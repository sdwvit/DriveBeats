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
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('drivebeats', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

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

  async function saveMidi(name, buf, roles) {
    try {
      const prev = await getKey(KEY(name)).catch(() => null);
      await putKey(KEY(name), { name, buf, roles, added: (prev && prev.added) || Date.now() });
      await putKey('current', { name });
    } catch (e) { /* private mode / quota - not fatal */ }
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

  /** Back to the built-in generator. The library is kept. */
  async function clearMidi() {
    M.active = false; M.name = null; M.tracks = []; M.notes = [];
    try { await delKey('current'); } catch (e) {}
  }

export { clearMidi, deleteMidi, idb, listMidi, loadMidiNamed, loadSavedMidi, saveMidi };
