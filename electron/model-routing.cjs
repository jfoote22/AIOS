// Which model each AI task uses. Plain JSON at %APPDATA%/AIOS/model-routing.json
// (model names and URLs aren't secrets; API keys for custom connections live in
// the encrypted keystore under `conn:<id>`).
//
// A model reference is "<connection>:<model>", e.g. "claude:claude-sonnet-5",
// "ollama:qwen3:8b" (split on the first colon only), or "chatgpt:" for the
// connection's own default model.
//
//   default     — the model every task uses unless it has its own entry
//   tasks       — task → model ref; missing/empty means "use the default"
//   embeddings  — 'local' (built-in, no key), 'gemini', or "<connection>:<model>"
//   fallback    — when the chosen model fails, try other connected models
//   connections — user-added OpenAI-compatible endpoints (Ollama, LM Studio,
//                 OpenRouter, DeepSeek, Hugging Face, ...)

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// The AI tasks a user can route. Keep in sync with src/lib/modelRouting.ts.
// coding/general/planning are the roles Hermes delegates to (hermes-bridge.cjs).
const TASKS = ['vault-ask', 'ocr', 'tagging', 'understanding', 'research', 'drafting', 'coding', 'general', 'planning'];

const EMPTY = { default: '', tasks: {}, embeddings: 'local', fallback: true, connections: [] };

const CONNECTION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Built-in connection ids a custom connection may not take.
const RESERVED = new Set(['claude', 'chatgpt', 'grok', 'gemini', 'hermes', 'local']);

function filePath() {
  return path.join(app.getPath('userData'), 'model-routing.json');
}

function splitRef(ref) {
  const s = typeof ref === 'string' ? ref : '';
  const i = s.indexOf(':');
  return i < 0 ? { connection: s, model: '' } : { connection: s.slice(0, i), model: s.slice(i + 1) };
}

function cleanRef(ref) {
  if (typeof ref !== 'string') return '';
  const t = ref.trim();
  if (!t || t.length > 300) return '';
  return CONNECTION_ID.test(splitRef(t).connection) ? t : '';
}

function cleanConnection(c) {
  if (!c || typeof c !== 'object') throw new Error('Invalid connection.');
  const id = String(c.id || '').trim().toLowerCase();
  if (!CONNECTION_ID.test(id) || RESERVED.has(id)) {
    throw new Error('Connection id must be lowercase letters, digits or dashes, and not a built-in name.');
  }
  const baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('Base URL must be a full http(s) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Base URL must be http(s) without credentials.');
  }
  const models = (Array.isArray(c.models) ? c.models : [])
    .map((m) => String(m || '').trim()).filter(Boolean).slice(0, 100);
  return {
    id,
    label: String(c.label || id).trim().slice(0, 60) || id,
    baseUrl,
    models: [...new Set(models)],
    vision: c.vision === true,
  };
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8') || '{}');
    const tasks = {};
    for (const t of TASKS) { const r = cleanRef(raw.tasks?.[t]); if (r) tasks[t] = r; }
    const connections = [];
    for (const c of Array.isArray(raw.connections) ? raw.connections : []) {
      try { connections.push(cleanConnection(c)); } catch { /* drop invalid */ }
    }
    return {
      default: cleanRef(raw.default),
      tasks,
      embeddings: raw.embeddings === 'local' || raw.embeddings === 'gemini' ? raw.embeddings : (cleanRef(raw.embeddings) || 'local'),
      fallback: raw.fallback !== false,
      connections,
    };
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error('Failed to read model routing:', e.message);
    return structuredClone(EMPTY);
  }
}

function write(store) {
  const file = filePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/** Update default/tasks/embeddings/fallback; connections change via the functions below. */
function update(patch) {
  const store = read();
  if (patch && 'default' in patch) store.default = cleanRef(patch.default);
  if (patch?.tasks && typeof patch.tasks === 'object') {
    for (const t of TASKS) {
      if (!(t in patch.tasks)) continue;
      const r = cleanRef(patch.tasks[t]);
      if (r) store.tasks[t] = r; else delete store.tasks[t];
    }
  }
  if (patch && 'embeddings' in patch) {
    const e = patch.embeddings;
    store.embeddings = e === 'local' || e === 'gemini' ? e : (cleanRef(e) || 'local');
  }
  if (patch && 'fallback' in patch) store.fallback = patch.fallback !== false;
  write(store);
  return store;
}

function upsertConnection(input) {
  const conn = cleanConnection(input);
  const store = read();
  const i = store.connections.findIndex((c) => c.id === conn.id);
  if (i >= 0) store.connections[i] = conn; else store.connections.push(conn);
  write(store);
  return store;
}

/** Removes the connection and any routing that pointed at it. */
function removeConnection(id) {
  const store = read();
  store.connections = store.connections.filter((c) => c.id !== id);
  const uses = (ref) => splitRef(ref).connection === id;
  if (uses(store.default)) store.default = '';
  for (const t of Object.keys(store.tasks)) if (uses(store.tasks[t])) delete store.tasks[t];
  if (uses(store.embeddings)) store.embeddings = 'local';
  write(store);
  return store;
}

module.exports = { TASKS, read, update, upsertConnection, removeConnection, splitRef, cleanRef };
