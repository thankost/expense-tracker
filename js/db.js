const DB_NAME = 'expense-tracker';
const DB_VERSION = 1;
export const STORES = ['categories', 'transactions', 'periods', 'budgets', 'recurring', 'settings'];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    const out = fn(t);
    if (out instanceof IDBRequest) out.onsuccess = () => { result = out.result; };
    else result = out;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

export const getAll = store => run(store, 'readonly', t => t.objectStore(store).getAll());
export const put = (store, value) => run(store, 'readwrite', t => { t.objectStore(store).put(value); return value; });
export const del = (store, id) => run(store, 'readwrite', t => { t.objectStore(store).delete(id); });

export const putAll = (store, values) => run(store, 'readwrite', t => {
  const s = t.objectStore(store);
  for (const v of values) s.put(v);
});

export const clearStores = (stores = STORES) => run(stores, 'readwrite', t => {
  for (const s of stores) t.objectStore(s).clear();
});

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
