// IndexedDB persistence layer.
//
// Stores:
//   snapshots -> { ...snapshot meta..., frame: Uint8Array (LZ77/stored frame) }
//   schemas   -> schema definitions keyed by schemaVersion
//   draft     -> current working state (plain object)
//   meta      -> { currentBaseId, autoSnapshot, ... }
import { SCHEMA_HISTORY, DEFAULT_SCHEMA } from './schema.js';
import { decompressBytes } from './compress.js';
import { decodeUtf8 } from './serialize.js';
import { deepClone } from './util.js';

const DB_NAME = 'form-snapshot-db';
const DB_VERSION = 1;

export class DBError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'DBError';
    this.cause = cause;
  }
}

function tx(db, storeNames, mode = 'readonly') {
  return db.transaction(storeNames, mode);
}

function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new DBError(request.error?.message || 'IndexedDB 操作失败', request.error));
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new DBError('transaction error', transaction.error));
    transaction.onabort = () => reject(new DBError('transaction aborted', transaction.error));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('snapshots')) {
        const store = db.createObjectStore('snapshots', { keyPath: 'id' });
        store.createIndex('parentId', 'parentId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('schemas')) {
        db.createObjectStore('schemas', { keyPath: 'schemaVersion' });
      }
      if (!db.objectStoreNames.contains('draft')) {
        db.createObjectStore('draft', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new DBError('打开 IndexedDB 失败', req.error));
  });
}

export async function initDB() {
  const db = await openDatabase();
  await seedSchemas(db);
  return db;
}

async function seedSchemas(db) {
  const t = tx(db, ['schemas'], 'readwrite');
  const store = t.objectStore('schemas');
  const count = await reqPromise(store.count());
  if (count === 0) {
    for (const schema of SCHEMA_HISTORY) await reqPromise(store.put(deepClone(schema)));
  } else {
    const existing = new Set((await reqPromise(store.getAllKeys())).map(Number));
    for (const schema of SCHEMA_HISTORY) {
      if (!existing.has(schema.schemaVersion)) await reqPromise(store.put(deepClone(schema)));
    }
  }
  await txDone(t);
}

export async function getAllSchemas(db) {
  const t = tx(db, ['schemas']);
  const all = await reqPromise(t.objectStore('schemas').getAll());
  return all.sort((a, b) => a.schemaVersion - b.schemaVersion);
}

export async function putSchema(db, schema) {
  const t = tx(db, ['schemas'], 'readwrite');
  await reqPromise(t.objectStore('schemas').put(deepClone(schema)));
  await txDone(t);
}

export async function putSnapshotRecord(db, meta, frame) {
  if (!(frame instanceof Uint8Array)) throw new DBError('snapshot frame must be Uint8Array');
  // Verify the frame round-trips before persisting: compression must never
  // lose or corrupt data. CRC is checked inside.
  decompressBytes(frame);
  const record = { ...deepClone(meta), id: meta.id, frame };
  // State lives only inside the compressed frame, never duplicated in meta.
  delete record.state;
  const t = tx(db, ['snapshots'], 'readwrite');
  await reqPromise(t.objectStore('snapshots').put(record));
  await txDone(t);
  return record;
}

export async function getAllSnapshotRecords(db) {
  const t = tx(db, ['snapshots']);
  const records = await reqPromise(t.objectStore('snapshots').getAll());
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getSnapshotRecord(db, id) {
  const t = tx(db, ['snapshots']);
  return reqPromise(t.objectStore('snapshots').get(id));
}

// Deletion is allowed only for leaf nodes; the rollback chain must stay whole.
export async function deleteSnapshotRecord(db, id) {
  const records = await getAllSnapshotRecords(db);
  const children = records.filter((r) => r.parentId === id);
  if (children.length > 0) {
    throw new DBError(`快照仍有 ${children.length} 个子快照，不能删除（保证回滚链完整）`);
  }
  const t = tx(db, ['snapshots'], 'readwrite');
  await reqPromise(t.objectStore('snapshots').delete(id));
  await txDone(t);
}

export function decodeSnapshotFrame(record) {
  const raw = decompressBytes(record.frame);
  const wrapped = JSON.parse(decodeUtf8(raw));
  return wrapped.state ? wrapped.state : wrapped;
}

export async function loadSnapshotState(record) {
  return decodeSnapshotFrame(record);
}

export async function saveDraft(db, state, extra = {}) {
  const t = tx(db, ['draft'], 'readwrite');
  await reqPromise(t.objectStore('draft').put({
    key: 'current', state: deepClone(state), savedAt: new Date().toISOString(), ...extra,
  }));
  await txDone(t);
}

export async function loadDraft(db) {
  const t = tx(db, ['draft']);
  return reqPromise(t.objectStore('draft').get('current'));
}

export async function saveMeta(db, meta) {
  const t = tx(db, ['meta'], 'readwrite');
  await reqPromise(t.objectStore('meta').put({ key: 'app', ...meta }));
  await txDone(t);
}

export async function loadMeta(db) {
  const t = tx(db, ['meta']);
  return reqPromise(t.objectStore('meta').get('app'));
}

export async function clearAll(db) {
  const t = tx(db, ['snapshots', 'draft', 'meta'], 'readwrite');
  await Promise.all(['snapshots', 'draft', 'meta'].map((n) => reqPromise(t.objectStore(n).clear())));
  await txDone(t);
}

export { DEFAULT_SCHEMA };
