/* IndexedDB 封装：snapshots 仓库 + kv 仓库 */
'use strict';

const DB_NAME = 'form-snapshot-db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('snapshots')) {
        const st = db.createObjectStore('snapshots', { keyPath: 'id' });
        st.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    fn(t.objectStore(store));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const DB = {
  async putSnapshot(snap) {
    const db = await openDB();
    return tx(db, 'snapshots', 'readwrite', s => { s.put(snap); });
  },
  async getSnapshot(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('snapshots').objectStore('snapshots').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },
  async allSnapshots() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('snapshots').objectStore('snapshots').getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.createdAt - b.createdAt));
      req.onerror = () => reject(req.error);
    });
  },
  async deleteSnapshot(id) {
    const db = await openDB();
    return tx(db, 'snapshots', 'readwrite', s => { s.delete(id); });
  },
  async kvGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async kvSet(key, value) {
    const db = await openDB();
    return tx(db, 'kv', 'readwrite', s => { s.put(value, key); });
  },
};
