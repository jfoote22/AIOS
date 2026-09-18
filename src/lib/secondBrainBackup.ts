// Export / import for ALL Second Brain data in one portable JSON file.
//
// "Second Brain data" = the neurons (snippets), DeepDive sessions
// (threads + messages), imported Claude/ChatGPT conversations (imports +
// their embedded chunks), and the handful of Second Brain prefs stored in meta
// (physics, reveal depth, expanded clusters, chat history).
//
// Export reads through the db.ts façade and bundles everything into a single
// object. Import merges it back via db.bulkLoad (upsert, so it never wipes
// existing data) and then fires the change buses so the live graph reloads.

import * as db from './db';
import { emitSnippetsChange } from './snippetStore';
import { emitDeepDivesChange } from './deepdiveStore';
import { emitImportsChange } from './imports';

export const BACKUP_TYPE = 'aios-second-brain-backup';
export const BACKUP_VERSION = 1;

// Second Brain prefs that live in the generic meta KV store. There is no
// "get all meta" op, so we enumerate the keys we own explicitly.
const META_KEYS = [
  'second-brain-physics',
  'second-brain-reveal-depth',
  'second-brain-expanded-docs',
  'second-brain-chat-history',
] as const;

export interface BackupCounts {
  snippets: number;
  threads: number;
  messages: number;
  imports: number;
  importChunks: number;
}

export interface SecondBrainBackup {
  type: typeof BACKUP_TYPE;
  version: number;
  exportedAt: number;
  counts: BackupCounts;
  data: {
    snippets: unknown[];
    threads: { id: string }[];
    messages: unknown[];
    imports: unknown[];
    importChunks: unknown[];
    meta: { key: string; value: unknown }[];
  };
}

/** Gather everything into a single in-memory backup object. */
export async function buildBackup(): Promise<SecondBrainBackup> {
  const [snippets, threads, imports, importChunks] = await Promise.all([
    db.getAllSnippets<unknown>(),
    db.getAllThreads<{ id: string }>(),
    db.getAllImports<unknown>(),
    db.getAllImportChunks<unknown>(),
  ]);

  // Messages are keyed per-thread; collect them thread by thread.
  const messages: unknown[] = [];
  for (const t of threads) {
    const msgs = await db.getMessagesForThread<unknown>(t.id);
    messages.push(...msgs);
  }

  const meta: { key: string; value: unknown }[] = [];
  for (const key of META_KEYS) {
    const value = await db.getMeta<unknown>(key);
    if (value != null) meta.push({ key, value });
  }

  return {
    type: BACKUP_TYPE,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    counts: {
      snippets: snippets.length,
      threads: threads.length,
      messages: messages.length,
      imports: imports.length,
      importChunks: importChunks.length,
    },
    data: { snippets, threads, messages, imports, importChunks, meta },
  };
}

/** Build the backup and trigger a browser download. Returns the counts written. */
export async function exportSecondBrain(): Promise<{ counts: BackupCounts; filename: string }> {
  const backup = await buildBackup();
  const json = JSON.stringify(backup);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date(backup.exportedAt).toISOString().slice(0, 10);
  const filename = `second-brain-backup-${stamp}.json`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { counts: backup.counts, filename };
}

/** Parse + validate a backup file, merge it into the store, notify listeners. */
export async function importSecondBrain(file: File): Promise<BackupCounts> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }

  const b = parsed as Partial<SecondBrainBackup>;
  if (!b || b.type !== BACKUP_TYPE || !b.data) {
    throw new Error("This doesn't look like a Second Brain backup file.");
  }

  const d = b.data;
  const payload = {
    snippets: d.snippets ?? [],
    threads: d.threads ?? [],
    messages: d.messages ?? [],
    imports: d.imports ?? [],
    importChunks: d.importChunks ?? [],
    meta: d.meta ?? [],
  };

  await db.bulkLoad(payload);

  // Refresh every Second Brain surface that listens for data changes.
  emitSnippetsChange();
  emitDeepDivesChange();
  emitImportsChange();

  return {
    snippets: payload.snippets.length,
    threads: payload.threads.length,
    messages: payload.messages.length,
    imports: payload.imports.length,
    importChunks: payload.importChunks.length,
  };
}
