// Just enough IndexedDB to exercise js/midi-store.js in node.
//
// Requests fire their callbacks asynchronously, as the real one does, so code
// that forgets a transaction has closed still fails here.

class Req {
  constructor(run) {
    this.onsuccess = null; this.onerror = null; this.result = undefined;
    queueMicrotask(() => {
      try { this.result = run(); this.onsuccess && this.onsuccess(); }
      catch (e) { this.error = e; this.onerror && this.onerror(); }
    });
  }
}

class Store {
  constructor(map) { this.map = map; }
  get(k) { return new Req(() => this.map.get(k)); }
  put(v, k) { return new Req(() => { this.map.set(k, v); }); }
  delete(k) { return new Req(() => { this.map.delete(k); }); }
  clear() { return new Req(() => { this.map.clear(); }); }
  getAll() { return new Req(() => [...this.map.values()]); }
}

class Tx {
  constructor(map) {
    this.map = map;
    this.oncomplete = null; this.onerror = null; this.onabort = null;
    this._store = new Store(map);
    // Complete once the requests issued in this turn have drained.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
      this.done = true;
      this.oncomplete && this.oncomplete();
    })));
  }
  objectStore() {
    if (this.done) throw new Error('transaction already finished');
    return this._store;
  }
}

export function fakeIndexedDB() {
  const data = new Map();
  return {
    data,
    open() {
      const r = { onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        r.result = { transaction: () => new Tx(data), createObjectStore: () => {} };
        r.onupgradeneeded && r.onupgradeneeded();
        r.onsuccess && r.onsuccess();
      });
      return r;
    },
  };
}
