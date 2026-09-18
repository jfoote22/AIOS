// Local storage façade. Backed by SQLite (better-sqlite3) in the Electron main
// process, reached over the window.aios.db IPC bridge. This file is the ONLY
// renderer module that talks to the store; all callers import it unchanged.
//
// History: storage was IndexedDB through Phase 2. The bodies below now delegate
// to SQLite; a one-time migration (ensureMigrated) copies any existing
// IndexedDB data into SQLite on first use. The legacy IndexedDB database is
// left intact as a fallback for one release.

import { dumpIndexedDb, dumpHasData } from './idb-legacy';

const MIGRATION_FLAG = '__migrated_idb_to_sqlite_v1';

// --- IPC bridge ---------------------------------------------------------------

function rawCall<T = unknown>(op: string, args?: unknown[]): Promise<T> {
  const bridge = window.aios?.db;
  if (!bridge) {
    return Promise.reject(
      new Error('AIOS SQLite bridge unavailable — the data layer requires running inside Electron.'),
    );
  }
  return bridge.call<T>(op, args);
}

// --- One-time IndexedDB → SQLite migration ------------------------------------
// Runs at most once per session (the resolved promise is cached). On success it
// sets a flag in SQLite so future launches skip it. On failure it logs and
// leaves the flag unset so the next launch retries — without a retry storm
// inside the current session.

let migrationPromise: Promise<void> | null = null;

async function doMigrate(): Promise<void> {
  try {
    const already = await rawCall<boolean | null>('getMeta', [MIGRATION_FLAG]);
    if (already) return;

    const dump = await dumpIndexedDb().catch(() => null);
    if (dump && dumpHasData(dump)) {
      await rawCall('bulkLoad', [dump]);
      console.info(
        `[db] Migrated IndexedDB → SQLite (snippets:${dump.snippets.length} threads:${dump.threads.length} ` +
          `messages:${dump.messages.length} imports:${dump.imports.length} chunks:${dump.importChunks.length} ` +
          `agents:${dump.agents.length} runs:${dump.runs.length} meta:${dump.meta.length})`,
      );
    }
    await rawCall('setMeta', [MIGRATION_FLAG, true]);
  } catch (e) {
    console.error('[db] IndexedDB→SQLite migration failed; will retry on next launch:', e);
    // Flag stays unset → retried next launch. migrationPromise stays resolved →
    // no repeated attempts this session.
  }
}

function ensureMigrated(): Promise<void> {
  if (!migrationPromise) migrationPromise = doMigrate();
  return migrationPromise;
}

async function call<T = unknown>(op: string, args?: unknown[]): Promise<T> {
  await ensureMigrated();
  return rawCall<T>(op, args);
}

// --- Snippets ---
export async function getAllSnippets<T>(): Promise<T[]> {
  return call<T[]>('getAllSnippets');
}

export async function putSnippet<T extends { id: string }>(item: T): Promise<void> {
  await call('putSnippet', [item]);
}

export async function removeSnippet(id: string): Promise<void> {
  await call('removeSnippet', [id]);
}

export async function clearSnippets(): Promise<void> {
  await call('clearSnippets');
}

// --- Meta (chat history, prefs, board, maestro state) ---
export async function getMeta<T>(key: string): Promise<T | null> {
  return call<T | null>('getMeta', [key]);
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  await call('setMeta', [key, value]);
}

// --- DeepDive threads + messages ---
export async function getAllThreads<T>(): Promise<T[]> {
  return call<T[]>('getAllThreads');
}

export async function putThread<T extends { id: string }>(item: T): Promise<void> {
  await call('putThread', [item]);
}

export async function removeThread(id: string): Promise<void> {
  await call('removeThread', [id]);
}

export async function getMessagesForThread<T>(threadId: string): Promise<T[]> {
  return call<T[]>('getMessagesForThread', [threadId]);
}

export async function putMessage<T extends { id: string }>(item: T): Promise<void> {
  await call('putMessage', [item]);
}

// --- Imports (Claude / ChatGPT conversation exports) ---
export async function getAllImports<T>(): Promise<T[]> {
  return call<T[]>('getAllImports');
}

/** Per-import metadata only (no message bodies) — cheap to load in bulk. */
export async function getImportsMeta<T>(): Promise<T[]> {
  return call<T[]>('getImportsMeta');
}

/** One full conversation (with messages), or null if not found. */
export async function getImport<T>(id: string): Promise<T | null> {
  return call<T | null>('getImport', [id]);
}

export async function putImports<T extends { id: string }>(items: T[]): Promise<void> {
  if (!items.length) return;
  await call('putImports', [items]);
}

export async function removeImport(id: string): Promise<void> {
  await call('removeImport', [id]);
}

// --- Agents (Kanban orchestration) ---
export async function getAllAgents<T>(): Promise<T[]> {
  return call<T[]>('getAllAgents');
}

export async function putAgent<T extends { id: string }>(item: T): Promise<void> {
  await call('putAgent', [item]);
}

export async function removeAgent(id: string): Promise<void> {
  await call('removeAgent', [id]);
}

// --- Skills (reusable SKILL.md definitions, mirror of agents) ---
export async function getAllSkills<T>(): Promise<T[]> {
  return call<T[]>('getAllSkills');
}

export async function putSkill<T extends { id: string }>(item: T): Promise<void> {
  await call('putSkill', [item]);
}

export async function removeSkill(id: string): Promise<void> {
  await call('removeSkill', [id]);
}

// --- Runs (each Play of an agent on a card creates one run) ---
export async function getAllRuns<T>(): Promise<T[]> {
  return call<T[]>('getAllRuns');
}

export async function getRunsForCard<T>(cardId: string): Promise<T[]> {
  return call<T[]>('getRunsForCard', [cardId]);
}

export async function putRun<T extends { id: string }>(item: T): Promise<void> {
  await call('putRun', [item]);
}

// --- Import chunks (for Second Brain semantic search) ---
export async function getAllImportChunks<T>(): Promise<T[]> {
  return call<T[]>('getAllImportChunks');
}

export async function getChunksForConversation<T>(conversationId: string): Promise<T[]> {
  return call<T[]>('getChunksForConversation', [conversationId]);
}

export async function getConversationsWithChunkCounts(): Promise<Map<string, number>> {
  const rows = await call<Array<{ conversationId: string; count: number }>>('getConversationChunkCounts');
  return new Map(rows.map((r) => [r.conversationId, r.count]));
}

export async function putImportChunks<T extends { id: string }>(items: T[]): Promise<void> {
  if (!items.length) return;
  await call('putImportChunks', [items]);
}

export async function deleteChunksForConversation(conversationId: string): Promise<void> {
  await call('deleteChunksForConversation', [conversationId]);
}

export async function clearImports(provider?: string): Promise<void> {
  await call('clearImports', [provider]);
}

// --- Bulk load (merge a backup payload in a single transaction) ---
// Mirrors the one-shot loader the IndexedDB→SQLite migration uses. Any omitted
// table is simply skipped; rows are upserted (INSERT OR REPLACE), so importing
// a backup merges with existing data rather than wiping it.
export interface BulkLoadPayload {
  snippets?: unknown[];
  meta?: { key: string; value: unknown }[];
  threads?: unknown[];
  messages?: unknown[];
  imports?: unknown[];
  importChunks?: unknown[];
  agents?: unknown[];
  skills?: unknown[];
  runs?: unknown[];
}

export async function bulkLoad(payload: BulkLoadPayload): Promise<void> {
  await call('bulkLoad', [payload]);
}
