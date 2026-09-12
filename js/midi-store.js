import { M, loadParsed, parseMidi, rebuildNotes } from './midi.js';

  // ---- IndexedDB -------------------------------------------------
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('drivebeats', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function saveMidi(name, buf, roles) {
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put({ name, buf, roles }, 'current');
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* private mode / quota - not fatal */ }
  }
  async function loadSavedMidi() {
    try {
      const db = await idb();
      const rec = await new Promise((res, rej) => {
        const tx = db.transaction('files', 'readonly');
        const q = tx.objectStore('files').get('current');
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      if (!rec) return false;
      loadParsed(parseMidi(rec.buf), rec.name);
      window.__dbLastBuf = rec.buf;
      if (rec.roles && rec.roles.length === M.tracks.length) {
        M.tracks.forEach((t, i) => t.role = rec.roles[i]);
        rebuildNotes();
      }
      return true;
    } catch (e) { return false; }
  }
  async function clearMidi() {
    M.active = false; M.name = null; M.tracks = []; M.notes = [];
    try {
      const db = await idb();
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').delete('current');
    } catch (e) {}
  }

export { clearMidi, idb, loadSavedMidi, saveMidi };
