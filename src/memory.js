/* utag-fixer: learned-fix memory storage.
   Minimal adapter interface, two implementations:

     { get(key), put(record), all(), count() }

   Records always carry a string `key`. The engine stores three kinds of
   records under one store:
     - learned fixes:        key 'f:<fileName>::<fileSize>' (this file) and
                             't:<title>|<artist>|<album>' (the broken-tags
                             fingerprint, catches a different rip of the
                             same song with the same mangled tags)
     - manual skips:         same 'f:' record with `skip: true`
     - calibration signals:  key 'calib:<source>:<bucket>' plus the
                             'calibidx:<source>' bucket index

   A skip flag lives on the same record as learned fixes, so a skip
   survives restarts and a later unskip keeps any learned fix. */

export function createInMemory() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? { ...map.get(key) } : null; },
    async put(record) { map.set(record.key, { ...record }); },
    async all() { return [...map.values()].map(r => ({ ...r })); },
    async count() { return map.size; },
  };
}

// IndexedDB adapter. Works wherever IndexedDB exists (browsers).
// Storage ops are plain promises; the engine bounds every op with a
// timeout so a wedged transaction can never hang a fix run.
export function createIndexedDB(dbName, storeName) {
  const NAME = dbName || 'utag-fixer';
  const STORE = storeName || 'utag-memory';
  let db = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode, fn) {
    return open().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const s = t.objectStore(STORE);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      // An aborted transaction fires neither oncomplete nor onerror;
      // without this the promise never settles and the caller hangs.
      t.onabort = () => reject(t.error || new Error('IDB transaction aborted: ' + STORE));
    }));
  }

  const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  return {
    get(key) { return tx('readonly', s => req2p(s.get(key))).then(r => r || null); },
    put(record) { return tx('readwrite', s => { s.put(record); }); },
    all() { return tx('readonly', s => req2p(s.getAll())); },
    count() { return tx('readonly', s => req2p(s.count())); },
  };
}
