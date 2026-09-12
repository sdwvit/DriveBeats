// Just enough IndexedDB to exercise js/midi-store.js in node.
//
// Requests fire their callbacks asynchronously, as the real one does, so code
// that forgets a transaction has closed still fails here.

class Req {
  constructor(run, tx) {
    this.onsuccess = null; this.onerror = null; this.result = undefined;
    queueMicrotask(() => {
      try { this.result = run(); this.onsuccess && this.onsuccess(); }
      catch (e) {
        this.error = e;
        this.onerror && this.onerror();
        // A request that fails and is not handled aborts its transaction, which
        // is how a quota rejection actually reaches code that issued a put and
        // then waited on the transaction rather than on the request.
        tx && tx._abort(e);
      }
    });
  }
}

class Store {
  constructor(map, failPut, tx) { this.map = map; this.failPut = failPut; this.tx = tx; }
  get(k) { return new Req(() => this.map.get(k), this.tx); }
  put(v, k) { return new Req(() => { if (this.failPut) throw this.failPut; this.map.set(k, v); }, this.tx); }
  delete(k) { return new Req(() => { this.map.delete(k); }, this.tx); }
  clear() { return new Req(() => { this.map.clear(); }, this.tx); }
  getAll() { return new Req(() => [...this.map.values()], this.tx); }
}

class Tx {
  constructor(map, failPut) {
    this.map = map;
    this.oncomplete = null; this.onerror = null; this.onabort = null;
    this._store = new Store(map, failPut, this);
    // Complete once the requests issued in this turn have drained.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
      if (this.done) return;
      this.done = true;
      this.oncomplete && this.oncomplete();
    })));
  }
  _abort(e) {
    if (this.done) return;
    this.done = true;
    this.error = e;
    this.onabort && this.onabort();
  }
  objectStore() {
    if (this.done) throw new Error('transaction already finished');
    return this._store;
  }
}

/**
 * opts.blocked   open() fires onblocked instead of onsuccess - what a real
 *                browser does when another connection holds the old version.
 * opts.failPut   an error every put() rejects with, to stand in for the quota.
 */
export function fakeIndexedDB(opts = {}) {
  const data = new Map();
  const fake = {
    data,
    opens: 0,          // so a test can see that the connection is reused
    closes: 0,
    open() {
      fake.opens++;
      const r = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (opts.blocked) { r.onblocked && r.onblocked(); return; }
        r.result = {
          transaction: () => new Tx(data, opts.failPut),
          createObjectStore: () => {},
          close: () => { fake.closes++; },
        };
        r.onupgradeneeded && r.onupgradeneeded();
        r.onsuccess && r.onsuccess();
      });
      return r;
    },
  };
  return fake;
}
