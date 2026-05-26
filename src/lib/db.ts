// IndexedDB local storage. Phase 1: stores snippets + chat history.
// Phase 2 will migrate to SQLite via better-sqlite3 (for FTS5-powered Second Brain).

const DB_NAME = 'aios';
const DB_VERSION = 2;
const SNIPS = 'snippets';
const META = 'meta';
const THREADS = 'threads';
const MESSAGES = 'messages';
const IMPORTS = 'imports';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNIPS)) {
        const store = db.createObjectStore(SNIPS, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('category', 'category');
        store.createIndex('originThreadId', 'originThreadId');
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(THREADS)) {
        const store = db.createObjectStore(THREADS, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains(MESSAGES)) {
        const store = db.createObjectStore(MESSAGES, { keyPath: 'id' });
        store.createIndex('threadId', 'threadId');
      }
      if (!db.objectStoreNames.contains(IMPORTS)) {
        const store = db.createObjectStore(IMPORTS, { keyPath: 'id' });
        store.createIndex('provider', 'provider');
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function txStore(store: string, mode: IDBTransactionMode) {
  const db = await openDb();
  const tx = db.transaction(store, mode);
  return { tx, store: tx.objectStore(store) };
}

// --- Snippets ---
export async function getAllSnippets<T>(): Promise<T[]> {
  const { store } = await txStore(SNIPS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result as T[]) ?? [];
      items.sort((a: any, b: any) => b.timestamp - a.timestamp);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putSnippet<T extends { id: string }>(item: T): Promise<void> {
  const { tx, store } = await txStore(SNIPS, 'readwrite');
  store.put(item);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeSnippet(id: string): Promise<void> {
  const { tx, store } = await txStore(SNIPS, 'readwrite');
  store.delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearSnippets(): Promise<void> {
  const { tx, store } = await txStore(SNIPS, 'readwrite');
  store.clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Meta (chat history, prefs) ---
export async function getMeta<T>(key: string): Promise<T | null> {
  const { store } = await txStore(META, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result?.value as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  const { tx, store } = await txStore(META, 'readwrite');
  store.put({ key, value });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- DeepDive threads + messages (Phase 1 stubs ready for Phase 2 port) ---
export async function getAllThreads<T>(): Promise<T[]> {
  const { store } = await txStore(THREADS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function putThread<T extends { id: string }>(item: T): Promise<void> {
  const { tx, store } = await txStore(THREADS, 'readwrite');
  store.put(item);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeThread(id: string): Promise<void> {
  const { tx, store } = await txStore(THREADS, 'readwrite');
  store.delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMessagesForThread<T>(threadId: string): Promise<T[]> {
  const { store } = await txStore(MESSAGES, 'readonly');
  const idx = store.index('threadId');
  return new Promise((resolve, reject) => {
    const req = idx.getAll(threadId);
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function putMessage<T extends { id: string }>(item: T): Promise<void> {
  const { tx, store } = await txStore(MESSAGES, 'readwrite');
  store.put(item);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Imports (Claude / ChatGPT conversation exports) ---
export async function getAllImports<T>(): Promise<T[]> {
  const { store } = await txStore(IMPORTS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result as T[]) ?? [];
      items.sort((a: any, b: any) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putImports<T extends { id: string }>(items: T[]): Promise<void> {
  if (!items.length) return;
  const { tx, store } = await txStore(IMPORTS, 'readwrite');
  for (const item of items) store.put(item);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeImport(id: string): Promise<void> {
  const { tx, store } = await txStore(IMPORTS, 'readwrite');
  store.delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearImports(provider?: string): Promise<void> {
  const { tx, store } = await txStore(IMPORTS, 'readwrite');
  if (!provider) {
    store.clear();
  } else {
    const idx = store.index('provider');
    const req = idx.openCursor(IDBKeyRange.only(provider));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { cur.delete(); cur.continue(); }
    };
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
