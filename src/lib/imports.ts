// Parsers + storage helpers for Claude / ChatGPT data exports.
// Both providers package conversations into a `conversations.json` file inside
// the ZIP they email you. AIOS accepts the JSON directly — extract the ZIP
// first. We auto-detect the provider by inspecting the structure.

import * as db from './db';

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

  return {
    provider,
    added: toAdd.length,
    skipped: parsed.length - toAdd.length,
    total: parsed.length,
  };
}

export const listImports = () => db.getAllImports<ImportedConversation>();
export const deleteImport = (id: string) => db.removeImport(id);
export const clearImportsByProvider = (provider: ImportProvider) => db.clearImports(provider);
export const clearAllImports = () => db.clearImports();
