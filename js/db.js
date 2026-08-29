// IndexedDB: kv (folder handle, token, coach cache) and runs (parsed
// run metrics for personal stats).

const DB_NAME = 'kova-streak';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('runs')) {
        const runs = db.createObjectStore('runs', { keyPath: 'fileName' });
        runs.createIndex('scenario', 'scenario');
        runs.createIndex('date', 'date');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function putParsedRuns(runs) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('runs', 'readwrite');
    const s = t.objectStore('runs');
    for (const r of runs) s.put(r);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getParsedFileNames() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('runs', 'readonly');
    const req = t.objectStore('runs').getAllKeys();
    req.onsuccess = () => resolve(new Set(req.result));
    req.onerror = () => reject(req.error);
  });
}

export async function getAllParsedRuns() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('runs', 'readonly');
    const req = t.objectStore('runs').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function kvGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readonly');
    const req = t.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvDel(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
