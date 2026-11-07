/* Tiny IndexedDB wrapper shared by the page and the service worker. */
(function (g) {
  'use strict';
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('hubb', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('kv');                          // token, me, partner, settings
          d.createObjectStore('messages', { keyPath: 'id' }); // delivered messages (offline history)
          d.createObjectStore('outbox', { keyPath: 'id' });   // messages waiting to be sent
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbp = null; reject(req.error); };
      });
    }
    return dbp;
  }
  function tx(store, mode, fn) {
    return open().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  const table = (name) => ({
    get: (k) => tx(name, 'readonly', (s) => s.get(k)),
    put: (v) => tx(name, 'readwrite', (s) => s.put(v)),
    del: (k) => tx(name, 'readwrite', (s) => s.delete(k)),
    all: () => tx(name, 'readonly', (s) => s.getAll()),
    clear: () => tx(name, 'readwrite', (s) => s.clear()),
  });
  g.HubbDB = {
    kv: {
      get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
      set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
      del: (k) => tx('kv', 'readwrite', (s) => s.delete(k)),
      clear: () => tx('kv', 'readwrite', (s) => s.clear()),
    },
    messages: table('messages'),
    outbox: table('outbox'),
  };
})(self);
