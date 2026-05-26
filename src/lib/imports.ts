// Parsers + storage helpers for Claude / ChatGPT data exports.
// Both providers package conversations into a `conversations.json` file inside
// the ZIP they email you. AIOS accepts the JSON directly — extract the ZIP
// first. We auto-detect the provider by inspecting the structure.

import * as db from './db';
import { embedText } from './ai';

export type ImportProvider = 'claude' | 'chatgpt';
export type ImportRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ImportedMessage {
  role: ImportRole;
  content: string;
  ts?: number; // ms
}

export interface ImportedConversation {
  id: string;                // `${provider}-${nativeId}`
  provider: ImportProvider;
  title: string;
  createdAt: number;         // ms
  updatedAt: number;         // ms
  messages: ImportedMessage[];
}

export interface ImportResult {
  provider: ImportProvider;
  added: number;
  skipped: number;
  total: number;
}

// ── Provider detection ─────────────────────────────────────────────────────────

export function detectProvider(json: unknown): ImportProvider | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  const first = json[0] as any;
  if (first && typeof first === 'object') {
    if ('chat_messages' in first || ('uuid' in first && 'name' in first)) return 'claude';
    if ('mapping' in first) return 'chatgpt';
  }
  return null;
}

// ── Claude ─────────────────────────────────────────────────────────────────────
// Shape: [{ uuid, name, created_at, updated_at, chat_messages: [...] }]
//   chat_messages: [{ uuid, text, sender:'human'|'assistant', created_at,
//                     content: [{ type:'text', text }, ...] }]

export function parseClaude(json: any[]): ImportedConversation[] {
  const out: ImportedConversation[] = [];
  for (const c of json) {
    if (!c || typeof c !== 'object') continue;
    const nativeId = c.uuid || c.id;
    if (!nativeId) continue;
    const messages: ImportedMessage[] = [];
    const chat = Array.isArray(c.chat_messages) ? c.chat_messages : [];
    for (const m of chat) {
      const role: ImportRole = m.sender === 'human' ? 'user' : 'assistant';
      let text = '';
      if (Array.isArray(m.content)) {
        text = m.content
          .map((p: any) => (p?.type === 'text' ? p.text : ''))
          .filter(Boolean)
          .join('\n\n');
      }
      if (!text && typeof m.text === 'string') text = m.text;
      if (!text) continue;
      messages.push({ role, content: text, ts: toMs(m.created_at) });
    }
    if (!messages.length) continue;
    out.push({
      id: `claude-${nativeId}`,
      provider: 'claude',
      title: (c.name || '').trim() || '(untitled)',
      createdAt: toMs(c.created_at) ?? messages[0].ts ?? Date.now(),
      updatedAt: toMs(c.updated_at) ?? messages[messages.length - 1].ts ?? Date.now(),
      messages,
    });
  }
  return out;
}

// ── ChatGPT ────────────────────────────────────────────────────────────────────
// Shape: [{ id, title, create_time, update_time, mapping: { msgId: node }, current_node }]
//   node: { id, parent, children: [...], message: { author: { role }, content:
//          { content_type, parts: [...] | { ... } }, create_time } }
// Walk root → current_node, collecting messages in order.

export function parseChatGPT(json: any[]): ImportedConversation[] {
  const out: ImportedConversation[] = [];
  for (const c of json) {
    if (!c || typeof c !== 'object' || !c.mapping) continue;
    const nativeId = c.id || c.conversation_id;
    if (!nativeId) continue;

    const mapping = c.mapping as Record<string, any>;
    // Find ordered path from root → leaf. ChatGPT exports include `current_node`;
    // if missing, pick the deepest leaf.
    const leafId: string = c.current_node || findDeepestLeaf(mapping);
    const path: string[] = [];
    let cursor: string | null = leafId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      path.unshift(cursor);
      cursor = mapping[cursor]?.parent ?? null;
    }

    const messages: ImportedMessage[] = [];
    for (const nodeId of path) {
      const node = mapping[nodeId];
      const msg = node?.message;
      if (!msg) continue;
      const role = mapChatGPTRole(msg.author?.role);
      if (!role) continue;
      const text = extractChatGPTText(msg.content);
      if (!text) continue;
      messages.push({ role, content: text, ts: toMs(msg.create_time) });
    }
    if (!messages.length) continue;

    out.push({
      id: `chatgpt-${nativeId}`,
      provider: 'chatgpt',
      title: (c.title || '').trim() || '(untitled)',
      createdAt: toMs(c.create_time) ?? messages[0].ts ?? Date.now(),
      updatedAt: toMs(c.update_time) ?? messages[messages.length - 1].ts ?? Date.now(),
      messages,
    });
  }
  return out;
}

function mapChatGPTRole(role: string | undefined): ImportRole | null {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  return null;
}

function extractChatGPTText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // Standard text turn: { content_type: 'text', parts: [...] }
  if (Array.isArray(content.parts)) {
    return content.parts
      .map((p: any) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && typeof p.text === 'string') return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  if (typeof content.text === 'string') return content.text;
  return '';
}

function findDeepestLeaf(mapping: Record<string, any>): string {
  let best = '';
  let bestDepth = -1;
  for (const id of Object.keys(mapping)) {
    const node = mapping[id];
    if (!node || (node.children && node.children.length)) continue;
    let depth = 0;
    let cur: string | null = id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      depth++;
      cur = mapping[cur]?.parent ?? null;
    }
    if (depth > bestDepth) { bestDepth = depth; best = id; }
  }
  return best;
}

// ── Common helpers ─────────────────────────────────────────────────────────────

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number') {
    // Unix seconds vs ms heuristic
    return v < 1e12 ? Math.round(v * 1000) : v;
  }
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function importFromFile(file: File): Promise<ImportResult> {
  const text = await file.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file. Extract the ZIP and select conversations.json.');
  }
  const provider = detectProvider(json);
  if (!provider) {
    throw new Error('Could not detect Claude or ChatGPT export format in this file.');
  }
  const parsed = provider === 'claude'
    ? parseClaude(json as any[])
    : parseChatGPT(json as any[]);
  if (!parsed.length) {
    return { provider, added: 0, skipped: 0, total: 0 };
  }

  // De-dupe against what's already stored.
  const existing = await db.getAllImports<ImportedConversation>();
  const existingIds = new Set(existing.map(e => e.id));
  const toAdd = parsed.filter(p => !existingIds.has(p.id));
  await db.putImports(toAdd);
  if (toAdd.length) emitImportsChange();

  return {
    provider,
    added: toAdd.length,
    skipped: parsed.length - toAdd.length,
    total: parsed.length,
  };
}

export const listImports = () => db.getAllImports<ImportedConversation>();
export const deleteImport = async (id: string) => {
  await db.deleteChunksForConversation(id);
  await db.removeImport(id);
};
export const clearImportsByProvider = (provider: ImportProvider) => db.clearImports(provider);
export const clearAllImports = () => db.clearImports();

// ── Chunking + indexing for Second Brain ──────────────────────────────────────
// Strategy: split each conversation into turn-pair chunks (user msg + the
// assistant reply that follows). System messages stand alone. Cap each chunk
// at ~3500 chars; if a pair exceeds that, split mid-message at paragraph
// boundaries so we never cross a turn boundary. One chunk = one embedding.

export interface ImportChunk {
  id: string;                  // `${conversationId}-c${index}`
  conversationId: string;
  provider: ImportProvider;
  conversationTitle: string;
  turnIndex: number;           // ordering within the conversation
  text: string;                // the chunk content (already prefixed with role labels)
  charCount: number;
  createdAt: number;
  embedding: number[];
}

const MAX_CHUNK_CHARS = 3500;

export function chunkConversation(c: ImportedConversation): Array<Omit<ImportChunk, 'embedding'>> {
  const out: Array<Omit<ImportChunk, 'embedding'>> = [];
  const msgs = c.messages;
  let i = 0;
  let turnIndex = 0;

  const push = (text: string, ts?: number) => {
    const t = text.trim();
    if (!t) return;
    // If still too big after pair-level split, fall back to paragraph splitting
    for (const piece of splitOversized(t, MAX_CHUNK_CHARS)) {
      out.push({
        id: `${c.id}-c${turnIndex}`,
        conversationId: c.id,
        provider: c.provider,
        conversationTitle: c.title,
        turnIndex,
        text: piece,
        charCount: piece.length,
        createdAt: ts ?? c.createdAt,
      });
      turnIndex++;
    }
  };

  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === 'user' && i + 1 < msgs.length && msgs[i + 1].role === 'assistant') {
      const u = msgs[i];
      const a = msgs[i + 1];
      const pair = `USER: ${u.content}\n\nASSISTANT: ${a.content}`;
      push(pair, u.ts ?? a.ts);
      i += 2;
    } else {
      // Lone turn (system msg, orphan user, orphan assistant, tool, etc.)
      push(`${m.role.toUpperCase()}: ${m.content}`, m.ts);
      i++;
    }
  }
  return out;
}

function splitOversized(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  const paras = text.split(/\n\n+/);
  let buf = '';
  for (const p of paras) {
    if (buf.length + p.length + 2 > max && buf) {
      out.push(buf);
      buf = '';
    }
    if (p.length > max) {
      // Single paragraph is bigger than max — hard-split on char boundary
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export interface IndexProgress {
  conversationsTotal: number;
  conversationsDone: number;
  chunksTotal: number;
  chunksDone: number;
  currentTitle?: string;
}

/**
 * Index every conversation that has no chunks yet. Embeddings are produced
 * one chunk at a time via the Gemini embeddings API; chunks for a conversation
 * are written as a single transaction.
 */
export async function indexUnindexed(
  onProgress?: (p: IndexProgress) => void,
  signal?: AbortSignal,
): Promise<{ indexed: number; chunks: number; skipped: number }> {
  const all = await db.getAllImports<ImportedConversation>();
  const haveChunks = await db.getConversationsWithChunkCounts();
  const todo = all.filter(c => !haveChunks.has(c.id));

  // Pre-compute total chunk count for an honest progress bar.
  const plans = todo.map(c => ({ conv: c, chunks: chunkConversation(c) }));
  const chunksTotal = plans.reduce((sum, p) => sum + p.chunks.length, 0);

  let chunksDone = 0;
  let indexed = 0;

  for (let pi = 0; pi < plans.length; pi++) {
    if (signal?.aborted) break;
    const { conv, chunks } = plans[pi];
    onProgress?.({
      conversationsTotal: plans.length,
      conversationsDone: pi,
      chunksTotal,
      chunksDone,
      currentTitle: conv.title,
    });

    const embedded: ImportChunk[] = [];
    for (const c of chunks) {
      if (signal?.aborted) break;
      try {
        const vec = await embedText(c.text);
        embedded.push({ ...c, embedding: vec });
      } catch (e) {
        // If embedding fails (rate limit, etc.) propagate so the caller can decide
        throw new Error(`Embedding failed on "${conv.title}": ${(e as Error)?.message ?? e}`);
      }
      chunksDone++;
      onProgress?.({
        conversationsTotal: plans.length,
        conversationsDone: pi,
        chunksTotal,
        chunksDone,
        currentTitle: conv.title,
      });
    }
    if (embedded.length) {
      await db.putImportChunks(embedded);
      indexed++;
    }
  }

  if (indexed) emitImportsChange();
  return { indexed, chunks: chunksDone, skipped: all.length - todo.length };
}

export const listAllChunks = () => db.getAllImportChunks<ImportChunk>();
export const listChunkCounts = () => db.getConversationsWithChunkCounts();
export const removeChunksForConversation = (id: string) => db.deleteChunksForConversation(id);

// Cross-component change bus so Second Brain reloads when a fresh index
// or a new import shows up.
type Listener = () => void;
const importListeners = new Set<Listener>();
export function onImportsChange(fn: Listener): () => void {
  importListeners.add(fn);
  return () => importListeners.delete(fn);
}
export function emitImportsChange(): void {
  for (const fn of importListeners) {
    try { fn(); } catch (e) { console.error('imports change listener failed', e); }
  }
}

/** Cheap estimate for the index-confirmation dialog. */
export async function estimateIndexCost(): Promise<{
  conversations: number;
  chunks: number;
  approxTokens: number;
}> {
  const all = await db.getAllImports<ImportedConversation>();
  const haveChunks = await db.getConversationsWithChunkCounts();
  const todo = all.filter(c => !haveChunks.has(c.id));
  let chunks = 0;
  let chars = 0;
  for (const c of todo) {
    const ch = chunkConversation(c);
    chunks += ch.length;
    chars += ch.reduce((s, x) => s + x.charCount, 0);
  }
  return {
    conversations: todo.length,
    chunks,
    approxTokens: Math.ceil(chars / 4), // industry-standard rough char→token ratio
  };
}
