const DB_NAME = 'snapshot-time-machine';
const DB_VERSION = 1;
const STORE = 'kv';

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, callback) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result;
    try {
      result = callback(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function getValue(key) {
  return withStore('readonly', (store) => requestToPromise(store.get(key)));
}

export function putValue(key, value) {
  return withStore('readwrite', (store) => {
    const request = store.put(value, key);
    return requestToPromise(request);
  });
}

export async function getRecords() {
  const records = await getValue('records');
  return Array.isArray(records) ? records : [];
}

export async function saveRecords(records) {
  await putValue('records', records);
}

export async function getDraft() {
  const draft = await getValue('draft');
  return draft && typeof draft === 'object' ? draft : null;
}

export async function saveDraft(draft) {
  await putValue('draft', {
    state: draft.state,
    baseSnapshotId: draft.baseSnapshotId ?? null,
    updatedAt: Date.now()
  });
}
