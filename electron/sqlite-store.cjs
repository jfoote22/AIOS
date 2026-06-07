// SQLite data store (main process). Backs the renderer's src/lib/db.ts façade.
//
// Design: each former IndexedDB object store becomes a table with a TEXT
// primary key + a `data` TEXT column holding the full JSON record. Only the
// fields that db.ts indexed / sorted / queried are promoted to real columns
// (so new optional fields ride inside `data` with no schema change). The one
// exception is import_chunks.embedding, stored as a Float32 BLOB so cosine
// search stays cheap and the main process can read it without the renderer.
//
// Every exported op is synchronous (better-sqlite3) and mirrors the exact
// semantics of the matching db.ts function — same ordering, same return shape
// — so swapping db.ts's body changes nothing for the 11 callers.

const Database = require('better-sqlite3');

let db = null;

// ── lifecycle ──────────────────────────────────────────────────────────────

/** Open (or create) the database at `dbPath` and ensure the schema exists. */
function init(dbPath) {
  if (db) return db;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = OFF');
  migrateSchema();
  return db;
}

function ensure() {
  if (!db) throw new Error('sqlite-store: init(dbPath) must be called before use');
  return db;
}

/** Idempotent schema creation, versioned via PRAGMA user_version. */
function migrateSchema() {
  const SCHEMA_VERSION = 1;
  db.exec(`
    CREATE TABLE IF NOT EXISTS snippets (
      id TEXT PRIMARY KEY,
      timestamp INTEGER,
      category TEXT,
      originThreadId TEXT,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snippets_timestamp ON snippets(timestamp);
    CREATE INDEX IF NOT EXISTS idx_snippets_category ON snippets(category);
    CREATE INDEX IF NOT EXISTS idx_snippets_origin ON snippets(originThreadId);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      timestamp INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_threads_timestamp ON threads(timestamp);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      threadId TEXT,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(threadId);

    CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY,
      provider TEXT,
      createdAt INTEGER,
      updatedAt INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_imports_provider ON imports(provider);
    CREATE INDEX IF NOT EXISTS idx_imports_created ON imports(createdAt);
    CREATE INDEX IF NOT EXISTS idx_imports_updated ON imports(updatedAt);

    CREATE TABLE IF NOT EXISTS import_chunks (
      id TEXT PRIMARY KEY,
      conversationId TEXT,
      provider TEXT,
      embedding BLOB,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_conversation ON import_chunks(conversationId);
    CREATE INDEX IF NOT EXISTS idx_chunks_provider ON import_chunks(provider);

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      updatedAt INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_updated ON agents(updatedAt);

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      updatedAt INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skills_updated ON skills(updatedAt);

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      cardId TEXT,
      agentId TEXT,
      startedAt INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_card ON runs(cardId);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agentId);
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(startedAt);
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

const parse = (row) => (row ? JSON.parse(row.data) : null);
const parseAll = (rows) => rows.map((r) => JSON.parse(r.data));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function floatsToBlob(arr) {
  if (!arr || !arr.length) return Buffer.alloc(0);
  return Buffer.from(Float32Array.from(arr).buffer);
}
function blobToFloats(buf) {
  if (!buf || !buf.byteLength) return [];
  // Copy into an aligned Float32Array (the Buffer may be an offset view).
  const f = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < f.length; i++) f[i] = buf.readFloatLE(i * 4);
  return Array.from(f);
}

// ── snippets ───────────────────────────────────────────────────────────────
// db.ts sorts by timestamp DESC.

function getAllSnippets() {
  return parseAll(ensure().prepare('SELECT data FROM snippets ORDER BY timestamp DESC').all());
}
function putSnippet(item) {
  ensure()
    .prepare('INSERT OR REPLACE INTO snippets (id, timestamp, category, originThreadId, data) VALUES (?, ?, ?, ?, ?)')
    .run(item.id, num(item.timestamp), item.category ?? null, item.originThreadId ?? null, JSON.stringify(item));
}
function removeSnippet(id) {
  ensure().prepare('DELETE FROM snippets WHERE id = ?').run(id);
}
function clearSnippets() {
  ensure().prepare('DELETE FROM snippets').run();
}

// ── meta (generic KV: board, maestro state, prefs, chat history, auth modes) ──

function getMeta(key) {
  const row = ensure().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row || row.value == null) return null;
  return JSON.parse(row.value);
}
function setMeta(key, value) {
  ensure()
    .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run(key, JSON.stringify(value));
}

// ── threads + messages ───────────────────────────────────────────────────────
// db.ts returns getAll() unsorted (IndexedDB key order = id asc).

function getAllThreads() {
  return parseAll(ensure().prepare('SELECT data FROM threads ORDER BY id ASC').all());
}
function putThread(item) {
  ensure()
    .prepare('INSERT OR REPLACE INTO threads (id, timestamp, data) VALUES (?, ?, ?)')
    .run(item.id, num(item.timestamp), JSON.stringify(item));
}
function removeThread(id) {
  ensure().prepare('DELETE FROM threads WHERE id = ?').run(id);
}
function getMessagesForThread(threadId) {
  return parseAll(
    ensure().prepare('SELECT data FROM messages WHERE threadId = ? ORDER BY id ASC').all(threadId),
  );
}
function putMessage(item) {
  ensure()
    .prepare('INSERT OR REPLACE INTO messages (id, threadId, data) VALUES (?, ?, ?)')
    .run(item.id, item.threadId ?? null, JSON.stringify(item));
}

// ── imports ──────────────────────────────────────────────────────────────────
// db.ts sorts by (updatedAt ?? createdAt ?? 0) DESC.

function getAllImports() {
  return parseAll(
    ensure()
      .prepare('SELECT data FROM imports ORDER BY COALESCE(updatedAt, createdAt, 0) DESC')
      .all(),
  );
}
/**
 * Lightweight per-import metadata WITHOUT the message bodies. A large export
 * can hold tens of thousands of messages; shipping all of them to the renderer
 * just to size graph nodes / render a list will exhaust renderer memory. JSON1's
 * json_array_length/json_extract read the count and a couple of fields straight
 * from the stored blob without materializing the messages.
 */
function getImportsMeta() {
  const d = ensure();
  try {
    // Fast path: JSON1 reads the count + a few fields without materializing
    // any message bodies.
    return d.prepare(`
      SELECT id,
             provider,
             COALESCE(json_extract(data, '$.title'), '') AS title,
             createdAt,
             updatedAt,
             COALESCE(json_array_length(data, '$.messages'), 0) AS messageCount
      FROM imports
      ORDER BY COALESCE(updatedAt, createdAt, 0) DESC
    `).all();
  } catch (e) {
    // Fallback (JSON1 unavailable): parse on the main side and strip messages.
    // Still never ships message bodies over IPC to the renderer.
    console.warn('getImportsMeta: JSON1 path failed, falling back to JS parse:', e?.message || e);
    const rows = d.prepare('SELECT data FROM imports ORDER BY COALESCE(updatedAt, createdAt, 0) DESC').all();
    return rows.map((r) => {
      const o = JSON.parse(r.data);
      return {
        id: o.id,
        provider: o.provider,
        title: o.title || '',
        createdAt: o.createdAt ?? null,
        updatedAt: o.updatedAt ?? null,
        messageCount: Array.isArray(o.messages) ? o.messages.length : 0,
      };
    });
  }
}
/** Fetch one full conversation (with messages) — used for lazy detail views. */
function getImport(id) {
  const row = ensure().prepare('SELECT data FROM imports WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
}
const _putImport = (stmt) => (item) =>
  stmt.run(item.id, item.provider ?? null, num(item.createdAt), num(item.updatedAt), JSON.stringify(item));
function putImports(items) {
  if (!items || !items.length) return;
  const d = ensure();
  const stmt = d.prepare(
    'INSERT OR REPLACE INTO imports (id, provider, createdAt, updatedAt, data) VALUES (?, ?, ?, ?, ?)',
  );
  const run = _putImport(stmt);
  d.transaction((arr) => { for (const it of arr) run(it); })(items);
}
function removeImport(id) {
  ensure().prepare('DELETE FROM imports WHERE id = ?').run(id);
}
function clearImports(provider) {
  // Matches db.ts: only clears the imports table (chunks are untouched here).
  if (!provider) ensure().prepare('DELETE FROM imports').run();
  else ensure().prepare('DELETE FROM imports WHERE provider = ?').run(provider);
}

// ── import_chunks (embedding stored out-of-band as Float32 BLOB) ──────────────

function chunkRow(row) {
  const obj = JSON.parse(row.data);
  obj.embedding = blobToFloats(row.embedding);
  return obj;
}
function getAllImportChunks() {
  return ensure().prepare('SELECT embedding, data FROM import_chunks').all().map(chunkRow);
}
function getChunksForConversation(conversationId) {
  return ensure()
    .prepare('SELECT embedding, data FROM import_chunks WHERE conversationId = ?')
    .all(conversationId)
    .map(chunkRow);
}
/** Returns [{ conversationId, count }] — db.ts reshapes this into a Map. */
function getConversationChunkCounts() {
  return ensure()
    .prepare('SELECT conversationId, COUNT(*) AS count FROM import_chunks GROUP BY conversationId')
    .all();
}
function putImportChunks(items) {
  if (!items || !items.length) return;
  const d = ensure();
  const stmt = d.prepare(
    'INSERT OR REPLACE INTO import_chunks (id, conversationId, provider, embedding, data) VALUES (?, ?, ?, ?, ?)',
  );
  d.transaction((arr) => {
    for (const it of arr) {
      const { embedding, ...rest } = it; // keep embedding out of the JSON blob
      stmt.run(it.id, it.conversationId ?? null, it.provider ?? null, floatsToBlob(embedding), JSON.stringify(rest));
    }
  })(items);
}
function deleteChunksForConversation(conversationId) {
  ensure().prepare('DELETE FROM import_chunks WHERE conversationId = ?').run(conversationId);
}

// ── agents (slug is UNIQUE — matches the IndexedDB unique index) ──────────────
// db.ts sorts by updatedAt DESC.

function getAllAgents() {
  return parseAll(ensure().prepare('SELECT data FROM agents ORDER BY updatedAt DESC').all());
}
function putAgent(item) {
  // Upsert on id, but let a duplicate slug on a *different* id raise the UNIQUE
  // constraint (matches IndexedDB's unique slug index, which rejects the put).
  // INSERT OR REPLACE is deliberately NOT used: it would silently clobber the
  // agent that already owns the slug.
  ensure()
    .prepare(
      `INSERT INTO agents (id, slug, updatedAt, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, updatedAt = excluded.updatedAt, data = excluded.data`,
    )
    .run(item.id, item.slug ?? null, num(item.updatedAt), JSON.stringify(item));
}
function removeAgent(id) {
  ensure().prepare('DELETE FROM agents WHERE id = ?').run(id);
}

// ── skills (slug is UNIQUE, mirrors agents) ──────────────────────────────────
// db.ts sorts by updatedAt DESC.

function getAllSkills() {
  return parseAll(ensure().prepare('SELECT data FROM skills ORDER BY updatedAt DESC').all());
}
function putSkill(item) {
  // Upsert on id; a duplicate slug on a different id raises UNIQUE (matches
  // agents' behavior). INSERT OR REPLACE avoided so we don't clobber the skill
  // that already owns the slug.
  ensure()
    .prepare(
      `INSERT INTO skills (id, slug, updatedAt, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, updatedAt = excluded.updatedAt, data = excluded.data`,
    )
    .run(item.id, item.slug ?? null, num(item.updatedAt), JSON.stringify(item));
}
function removeSkill(id) {
  ensure().prepare('DELETE FROM skills WHERE id = ?').run(id);
}

// ── runs ─────────────────────────────────────────────────────────────────────
// db.ts sorts by startedAt DESC (both getAllRuns and getRunsForCard).

function getAllRuns() {
  return parseAll(ensure().prepare('SELECT data FROM runs ORDER BY startedAt DESC').all());
}
function getRunsForCard(cardId) {
  return parseAll(
    ensure().prepare('SELECT data FROM runs WHERE cardId = ? ORDER BY startedAt DESC').all(cardId),
  );
}
function putRun(item) {
  ensure()
    .prepare('INSERT OR REPLACE INTO runs (id, cardId, agentId, startedAt, data) VALUES (?, ?, ?, ?, ?)')
    .run(item.id, item.cardId ?? null, item.agentId ?? null, num(item.startedAt), JSON.stringify(item));
}

// ── one-shot bulk loader (used by the one-time IndexedDB→SQLite migration) ────
// Accepts the full dump and writes it in a single transaction.

function bulkLoad(payload) {
  const d = ensure();
  d.transaction(() => {
    if (payload.snippets) for (const s of payload.snippets) putSnippet(s);
    if (payload.meta) for (const m of payload.meta) setMeta(m.key, m.value);
    if (payload.threads) for (const t of payload.threads) putThread(t);
    if (payload.messages) for (const m of payload.messages) putMessage(m);
    if (payload.imports && payload.imports.length) putImports(payload.imports);
    if (payload.importChunks && payload.importChunks.length) putImportChunks(payload.importChunks);
    if (payload.agents) for (const a of payload.agents) putAgent(a);
    if (payload.skills) for (const s of payload.skills) putSkill(s);
    if (payload.runs) for (const r of payload.runs) putRun(r);
  })();
}

// The dispatch whitelist: only these op names are callable over IPC.
const ops = {
  getAllSnippets, putSnippet, removeSnippet, clearSnippets,
  getMeta, setMeta,
  getAllThreads, putThread, removeThread,
  getMessagesForThread, putMessage,
  getAllImports, getImportsMeta, getImport, putImports, removeImport, clearImports,
  getAllImportChunks, getChunksForConversation, getConversationChunkCounts, putImportChunks, deleteChunksForConversation,
  getAllAgents, putAgent, removeAgent,
  getAllSkills, putSkill, removeSkill,
  getAllRuns, getRunsForCard, putRun,
  bulkLoad,
};

/** Invoke a whitelisted op by name. Throws on unknown ops. */
function call(op, args) {
  const fn = ops[op];
  if (typeof fn !== 'function') throw new Error(`sqlite-store: unknown op "${op}"`);
  return fn(...(args || []));
}

module.exports = { init, call, ops };
