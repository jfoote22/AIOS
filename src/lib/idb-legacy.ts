// Legacy IndexedDB reader — used ONLY by the one-time IndexedDB→SQLite
// migration in db.ts. It opens the old `aios` database read-only WITHOUT a
// version (so it never triggers an upgrade or creates stores) and dumps every
// store. On a fresh install (no old DB / no stores) every list comes back
// empty and the migration becomes a no-op.

const DB_NAME = 'aios';

const STORES = [
  'snippets',
  'meta',
  'threads',
  'messages',
  'imports',
  'import_chunks',
  'agents',
  'runs',
] as const;

export interface IndexedDbDump {
  snippets: any[];
  meta: Array<{ key: string; value: any }>;
  threads: any[];
  messages: any[];
  imports: any[];
  importChunks: any[];
  agents: any[];
  runs: any[];
}

function openExisting(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME); // no version → open current, never upgrade
    } catch {
      return resolve(null);
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    // If this fires it's a brand-new empty DB — fine, it'll have no stores.
    req.onupgradeneeded = () => {};
  });
}

function readStore(db: IDBDatabase, store: string): Promise<any[]> {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains(store)) return resolve([]);
    try {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve((req.result as any[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** Read every legacy store. Returns null if no IndexedDB is available at all. */
export async function dumpIndexedDb(): Promise<IndexedDbDump | null> {
  const db = await openExisting();
  if (!db) return null;
  try {
    const [snippets, meta, threads, messages, imports, importChunks, agents, runs] = await Promise.all(
      STORES.map((s) => readStore(db, s)),
    );
    return { snippets, meta, threads, messages, imports, importChunks, agents, runs };
  } finally {
    db.close();
  }
}

export function dumpHasData(d: IndexedDbDump): boolean {
  return (
    d.snippets.length > 0 ||
    d.meta.length > 0 ||
    d.threads.length > 0 ||
    d.messages.length > 0 ||
    d.imports.length > 0 ||
    d.importChunks.length > 0 ||
    d.agents.length > 0 ||
    d.runs.length > 0
  );
}
