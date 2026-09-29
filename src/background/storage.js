// Camada de armazenamento em IndexedDB para as falhas capturadas.
// Usamos IndexedDB (e nao chrome.storage) porque response bodies podem ser
// grandes e o chrome.storage.local tem limites e serializa tudo de uma vez.

const DB_NAME = 'failwatch';
// v2: adiciona o indice 'groupKey' para agrupar falhas repetidas.
const DB_VERSION = 2;
const STORE = 'failures';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      let store;
      if (!db.objectStoreNames.contains(STORE)) {
        store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      } else {
        store = req.transaction.objectStore(STORE);
      }
      // Migracao para v2: indice de agrupamento.
      if (event.oldVersion < 2 && !store.indexNames.contains('groupKey')) {
        store.createIndex('groupKey', 'groupKey', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function addFailure(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite');
    const req = store.add(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Substitui/atualiza um registro existente (mesmo id).
export async function putFailure(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite');
    const req = store.put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Retorna as falhas ordenadas do mais recente para o mais antigo.
// Aceita { limit } opcional.
export async function getFailures({ limit } = {}) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readonly');
    const index = store.index('timestamp');
    const results = [];
    // Cursor em ordem decrescente por timestamp.
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      results.push(cursor.value);
      if (limit && results.length >= limit) {
        resolve(results);
        return;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getFailure(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readonly');
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// Encontra a falha mais recente de um grupo (para agregar repetidas).
export async function findByGroupKey(groupKey) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readonly');
    if (!store.indexNames.contains('groupKey')) {
      resolve(null);
      return;
    }
    const index = store.index('groupKey');
    const req = index.getAll(IDBKeyRange.only(groupKey));
    req.onsuccess = () => {
      const items = req.result || [];
      if (!items.length) {
        resolve(null);
        return;
      }
      // Mais recente do grupo.
      items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      resolve(items[0]);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteFailure(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite');
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearFailures() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite');
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function countFailures() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readonly');
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Mantem o store dentro do limite maximo, removendo as entradas mais antigas.
export async function pruneToLimit(maxEntries) {
  if (!maxEntries || maxEntries < 1) return;
  const db = await openDb();
  const total = await countFailures();
  const excess = total - maxEntries;
  if (excess <= 0) return;

  return new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite');
    const index = store.index('timestamp');
    // Ordem crescente: apaga os mais antigos primeiro.
    const req = index.openCursor(null, 'next');
    let removed = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || removed >= excess) {
        resolve();
        return;
      }
      cursor.delete();
      removed += 1;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
