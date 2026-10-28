// AI layer for snippets, notes, DeepDive maps, embeddings and Ask Second
// Brain. Every call names a task; the model it runs on is chosen in
// Settings → Models (electron/model-router.cjs).

import { Type } from '@google/genai';
import { apiUrl } from './apiBase';
import { aiGenerate, parseJsonObject, embeddingsMode, type AiTask } from './modelRouting';
import { embedLocal, LOCAL_EMBEDDING_DIM } from './localEmbeddings';

export interface AnalyzedEntity {
  type: 'link' | 'number' | 'address' | 'info';
  value: string;
  label: string;
}

export interface SnipAnalysis {
  title: string;
  summary: string;
  category: string;
  source: string;
  tags: string[];
  entities: AnalyzedEntity[];
  extractedText: string;
}

export interface MarkdownAnalysis {
  title: string;
  summary: string;
  category: string;
  tags: string[];
  entities: AnalyzedEntity[];
}

// True when a text model is connected (Settings → Models). A tiny event so
// tabs can enable their AI actions as soon as one is added.
let aiReady = false;
const listeners = new Set<(ready: boolean) => void>();

export function setAiReady(ready: boolean): void {
  if (ready === aiReady) return;
  aiReady = ready;
  for (const fn of listeners) fn(ready);
}

export function onAiReadyChange(fn: (ready: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function isAiReady(): boolean {
  return aiReady;
}

/** Run a task that must answer with JSON shaped like `schema` (a Gemini-style
 *  schema; its descriptions tell the model what each field holds). */
async function generateJson<T>(task: AiTask, prompt: string, schema: object): Promise<T> {
  const { text } = await aiGenerate({
    task,
    prompt: `${prompt}\n\nReturn JSON matching this schema (field descriptions say what each holds):\n${JSON.stringify(schema)}`,
    json: true,
  });
  return parseJsonObject<T>(text);
}

function dataUrlToInline(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) throw new Error('Invalid data URL');
  return { mimeType: match[1], data: match[2] };
}

/** Read a screenshot on the model routed to 'ocr' (see electron/snip-ocr.cjs). */
export async function analyzeSnip(imageDataUrl: string): Promise<SnipAnalysis> {
  const res = await fetch(apiUrl('/api/vision/analyze-snip'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Reading the screenshot failed (${res.status})`);
  }
  return res.json();
}

/** Downscale a capture before OCR so a large (multi-monitor) screenshot doesn't
 *  bloat the request and stall the model. The full-res image is still kept for
 *  display — only the OCR input shrinks. Resolves to the ORIGINAL on any failure
 *  so OCR is never blocked. */
export function downscaleDataUrl(dataUrl: string, maxDim = 1600): Promise<string> {
  return new Promise((resolve) => {
    try {
      if (typeof document === 'undefined' || typeof Image === 'undefined') { resolve(dataUrl); return; }
      const img = new Image();
      img.onload = () => {
        const longest = Math.max(img.width, img.height);
        if (!longest || longest <= maxDim) { resolve(dataUrl); return; }
        const scale = maxDim / longest;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(dataUrl); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        try { resolve(canvas.toDataURL('image/png')); } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch { resolve(dataUrl); }
  });
}

/** OCR a capture after downscaling. Preferred entry point for raw captures;
 *  the router falls back to other connected vision models if the chosen one fails. */
export async function analyzeSnipScaled(dataUrl: string): Promise<SnipAnalysis> {
  return analyzeSnip(await downscaleDataUrl(dataUrl));
}

export interface TextAnalysis {
  label: string;
  summary: string;
  tags: string[];
  entities: AnalyzedEntity[];
}

const textResponseSchema = {
  type: Type.OBJECT,
  properties: {
    label: { type: Type.STRING, description: '3-7 word descriptive label for this text fragment' },
    summary: { type: Type.STRING, description: '1-2 sentence summary of what this text is about' },
    tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: '2-6 lowercase keyword tags relevant to this text fragment' },
    entities: {
      type: Type.ARRAY,
      description: 'Notable entities in this text',
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING },
          label: { type: Type.STRING },
          value: { type: Type.STRING },
        },
        required: ['type', 'label', 'value'],
      },
    },
  },
  required: ['label', 'summary', 'tags', 'entities'],
};

export async function analyzeText(text: string): Promise<TextAnalysis> {
  const parsed = await generateJson<TextAnalysis>('tagging',
    `You are extracting a chunk of saved text from a user's personal knowledge vault. Analyze this text fragment and return structured metadata. Be specific. Do not invent details.\n\nText:\n"""\n${text}\n"""`,
    textResponseSchema);
  const allowed = new Set(['link', 'number', 'address', 'info']);
  parsed.entities = (parsed.entities ?? []).map(e => ({ ...e, type: allowed.has(e.type) ? e.type : 'info' }));
  parsed.tags = (parsed.tags ?? []).map(t => t.toLowerCase().trim()).filter(Boolean);
  return parsed;
}

const markdownResponseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '5-10 word descriptive title for this document' },
    summary: { type: Type.STRING, description: 'A concise paragraph (2-4 sentences) summarizing what this document contains and its purpose' },
    category: { type: Type.STRING, description: 'One short category name classifying the document topic, e.g. Research, Development, Design, Finance, Travel, Reference, Personal, General' },
    tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: '3-8 lowercase keyword tags' },
    entities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING },
          label: { type: Type.STRING },
          value: { type: Type.STRING },
        },
        required: ['type', 'label', 'value'],
      },
    },
  },
  required: ['title', 'summary', 'category', 'tags', 'entities'],
};

// Analyze a markdown document (e.g. Hermes task output) and auto-categorize it.
// Like analyzeText, but returns a real title + topical category so the note
// blends into the brain graph by subject instead of a fixed bucket.
export async function analyzeMarkdown(text: string): Promise<MarkdownAnalysis> {
  const parsed = await generateJson<MarkdownAnalysis>('tagging',
    `You are filing a markdown document into a personal knowledge vault. Analyze it and return structured metadata. Be specific; do not invent details.\n\nDocument:\n"""\n${text}\n"""`,
    markdownResponseSchema);
  const allowed = new Set(['link', 'number', 'address', 'info']);
  parsed.entities = (parsed.entities ?? []).map(e => ({ ...e, type: allowed.has(e.type) ? e.type : 'info' }));
  parsed.tags = (parsed.tags ?? []).map(t => t.toLowerCase().trim()).filter(Boolean);
  return parsed;
}

// --- DeepDive Understanding: semantic topic map of a conversation. ---
// Reads the whole transcript and returns the subject matter itself (topics,
// concrete takeaways, topic-to-topic relationships) rather than chat structure.

export interface UnderstandingTopic {
  id: string;
  label: string;
  summary: string;
  /** id of the parent topic when this is a subtopic; empty string for top-level. */
  parentId: string;
}

export interface UnderstandingInsight {
  topicId: string;
  label: string;
  detail: string;
}

export interface UnderstandingCrossLink {
  fromTopicId: string;
  toTopicId: string;
  label: string;
}

export interface UnderstandingSourceAssignment {
  sourceId: string;
  topicId: string;
}

export interface DeepDiveUnderstanding {
  title: string;
  summary: string;
  topics: UnderstandingTopic[];
  insights: UnderstandingInsight[];
  crossLinks: UnderstandingCrossLink[];
  sourceAssignments: UnderstandingSourceAssignment[];
}

const understandingSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '3-8 word title for what this conversation is fundamentally about' },
    summary: { type: Type.STRING, description: '2-3 sentence plain-language overview of what was explored and what was learned' },
    topics: {
      type: Type.ARRAY,
      description: 'The core subjects actually discussed: 4-10 top-level topics, plus subtopics where a topic has clearly distinct sub-areas',
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'Short stable kebab-case slug, e.g. "neural-rendering"' },
          label: { type: Type.STRING, description: '2-5 word topic name' },
          summary: { type: Type.STRING, description: '1-2 sentences on what the conversation actually said about this topic' },
          parentId: { type: Type.STRING, description: 'id of the parent topic if this is a subtopic, otherwise an empty string' },
        },
        required: ['id', 'label', 'summary', 'parentId'],
      },
    },
    insights: {
      type: Type.ARRAY,
      description: 'Concrete takeaways: specific facts, conclusions, mechanisms, numbers, or recommendations the conversation established. Aim for 2-5 per topic.',
      items: {
        type: Type.OBJECT,
        properties: {
          topicId: { type: Type.STRING, description: 'id of the topic this insight belongs to' },
          label: { type: Type.STRING, description: 'Short headline for the insight (under 12 words)' },
          detail: { type: Type.STRING, description: '1-3 sentences stating the insight plainly, faithful to the transcript' },
        },
        required: ['topicId', 'label', 'detail'],
      },
    },
    crossLinks: {
      type: Type.ARRAY,
      description: 'Meaningful relationships BETWEEN topics (not parent/child), each with a short relationship label',
      items: {
        type: Type.OBJECT,
        properties: {
          fromTopicId: { type: Type.STRING },
          toTopicId: { type: Type.STRING },
          label: { type: Type.STRING, description: 'Short relationship phrase, e.g. "depends on", "contrasts with", "enables", "is an example of"' },
        },
        required: ['fromTopicId', 'toTopicId', 'label'],
      },
    },
    sourceAssignments: {
      type: Type.ARRAY,
      description: 'For each provided source id, the topic it most directly supports. Omit sources that fit nowhere.',
      items: {
        type: Type.OBJECT,
        properties: {
          sourceId: { type: Type.STRING },
          topicId: { type: Type.STRING },
        },
        required: ['sourceId', 'topicId'],
      },
    },
  },
  required: ['title', 'summary', 'topics', 'insights', 'crossLinks', 'sourceAssignments'],
};

export interface UnderstandingSourceInput {
  id: string;
  title: string;
  description: string;
}

export async function analyzeDeepDiveUnderstanding(
  transcript: string,
  sources: UnderstandingSourceInput[],
): Promise<DeepDiveUnderstanding> {
  const sourcesBlock = sources.length
    ? sources.map(s => `[${s.id}] ${s.title}${s.description ? ` — ${s.description.slice(0, 200)}` : ''}`).join('\n')
    : '(no sources)';

  const prompt = `You are analyzing the full transcript of a "DeepDive" — a branching research conversation between a user and AI assistants. Your job is NOT to describe the chat's structure (threads, messages, branches). It is to map the SUBJECT MATTER itself: the actual ideas, facts, and themes that were discussed, and how they relate to each other.

Extract:
1. topics — the core subjects of the conversation. Use the user's questions to find what they were trying to understand, and the assistant responses for the substance. Add subtopics (via parentId) only when a topic has a clearly distinct sub-area that earned real discussion.
2. insights — the meat and bones: concrete facts, conclusions, mechanisms, trade-offs, numbers, and recommendations the conversation established, each attached to its topic.
3. crossLinks — how topics relate to EACH OTHER (depends on, contrasts with, enables, is an example of, ...). Only include relationships the transcript actually supports.
4. sourceAssignments — match each listed source to the single topic it most supports.

Ground everything in the transcript. Do not invent topics or insights that were not actually discussed. Write labels and summaries in plain language a reader could understand without seeing the chat.

SOURCES REFERENCED IN THE CONVERSATION:
${sourcesBlock}

TRANSCRIPT:
"""
${transcript}
"""`;

  return validateUnderstanding(await generateJson<DeepDiveUnderstanding>('understanding', prompt, understandingSchema));
}

function validateUnderstanding(parsed: DeepDiveUnderstanding): DeepDiveUnderstanding {
  parsed.topics = (parsed.topics ?? []).filter(t => t?.id && t?.label);
  if (!parsed.topics.length) throw new Error('The analysis found no topics in this conversation.');
  parsed.insights = (parsed.insights ?? []).filter(i => i?.label);
  parsed.crossLinks = (parsed.crossLinks ?? []).filter(l => l?.fromTopicId && l?.toTopicId);
  parsed.sourceAssignments = parsed.sourceAssignments ?? [];
  return parsed;
}

/**
 * Drill-down analysis: build a sub-network for ONE topic node of an existing
 * understanding map. Strictly conversation-grounded — it re-reads the same
 * transcript zoomed into the focus topic and maps only what was actually said
 * about it, so deeper levels never drift into invented material.
 */
export async function analyzeUnderstandingDrilldown(
  focus: { label: string; detail: string },
  path: string[],
  transcript: string,
  sources: UnderstandingSourceInput[],
): Promise<DeepDiveUnderstanding> {
  const sourcesBlock = sources.length
    ? sources.map(s => `[${s.id}] ${s.title}${s.description ? ` — ${s.description.slice(0, 200)}` : ''}`).join('\n')
    : '(no sources)';

  const prompt = `You are analyzing the full transcript of a "DeepDive" — a branching research conversation between a user and AI assistants. An understanding map of the whole conversation already exists; the user is now DRILLING DOWN into one node of it to see its internal structure.

DRILL PATH (outer map → focus): ${path.join(' → ') || '(top level)'}

FOCUS TOPIC: ${focus.label}
${focus.detail ? `FOCUS CONTEXT: ${focus.detail}` : ''}

Map the internal structure of the FOCUS TOPIC ONLY, using strictly what the transcript actually says about it (or directly relates to it):
1. title — restate the focus topic in 3-8 words.
2. summary — 2-3 sentences on what the conversation established about this specific topic.
3. topics — the distinct facets/aspects OF THE FOCUS TOPIC that earned real discussion. These become the hubs of the sub-network. Use subtopics (parentId) sparingly.
4. insights — concrete facts, conclusions, mechanisms, trade-offs the conversation established about each facet.
5. crossLinks — how the facets relate to each other, with short relationship labels.
6. sourceAssignments — only sources that directly support a facet of the focus topic; omit the rest.

CRITICAL: Stay strictly grounded in the transcript. Do NOT pad with your own general knowledge of the topic. If the conversation only touched the focus topic briefly, return FEWER topics and insights — a small honest map beats an invented one.

SOURCES REFERENCED IN THE CONVERSATION:
${sourcesBlock}

TRANSCRIPT:
"""
${transcript}
"""`;

  return validateUnderstanding(await generateJson<DeepDiveUnderstanding>('understanding', prompt, understandingSchema));
}

const EMBED_MAX_CHARS = 8000;        // per-item cap (model input limit)
// Batch several chunks per request to stay well under the requests-per-minute
// quota. Bounded by both item count and total chars so a request never gets
// large enough to be rejected.
const EMBED_BATCH_ITEMS = 16;
const EMBED_BATCH_CHARS = 50_000;
const EMBED_MAX_RETRIES = 8;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Pull an HTTP status out of a genai SDK error (number field or JSON message). */
function embedErrorStatus(e: any): number | null {
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.code === 'number') return e.code;
  const msg = String(e?.message ?? e ?? '');
  const m = msg.match(/"code"\s*:\s*(\d{3})/) || msg.match(/\b(400|429|500|503)\b/);
  return m ? Number(m[1]) : null;
}

const isQuotaOrTransient = (s: number | null) => s === 429 || s === 500 || s === 503;

/** Backoff delay; honors a server-provided `retryDelay: "37s"` when present. */
function embedRetryDelayMs(e: any, attempt: number): number {
  const msg = String(e?.message ?? '');
  const m = msg.match(/retryDelay["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)s/i);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 500;
  return Math.min(60_000, 2_000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
}

async function rawEmbed(contents: string[]): Promise<number[][]> {
  // The built-in model runs here; other providers run in main, which holds
  // their keys (encrypted keystore).
  if (embeddingsMode() === 'local') return embedLocal(contents);
  const res = await fetch(apiUrl('/api/embeddings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status; // so embedErrorStatus() can drive backoff on 429
    throw err;
  }
  const data = await res.json();
  const embs = data?.embeddings;
  if (!Array.isArray(embs) || !embs.length) throw new Error('No embeddings were returned');
  return embs.map((v: unknown) => {
    if (!Array.isArray(v) || !v.length) throw new Error('An embedding came back empty');
    return v as number[];
  });
}

/** Embed one batch, retrying quota/transient errors and falling back to
 *  per-item requests if the batch endpoint rejects the multi-content request. */
async function embedBatch(batch: string[], signal?: AbortSignal): Promise<number[][]> {
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Embedding aborted', 'AbortError');
    try {
      const vecs = await rawEmbed(batch);
      if (vecs.length === batch.length) return vecs;
      if (batch.length > 1) return embedEach(batch, signal); // count mismatch → per-item
      throw new Error('The wrong number of embeddings came back');
    } catch (e) {
      const status = embedErrorStatus(e);
      if (status === 400 && batch.length > 1) return embedEach(batch, signal); // too large → split
      if (isQuotaOrTransient(status) && attempt < EMBED_MAX_RETRIES) {
        await sleep(embedRetryDelayMs(e, attempt));
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

async function embedEach(batch: string[], signal?: AbortSignal): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of batch) out.push((await embedBatch([t], signal))[0]);
  return out;
}

/**
 * Embed many texts efficiently: groups them into batched requests (bounded by
 * item count and total chars), with retry/backoff on rate limits. Reports
 * cumulative progress and supports cancellation.
 */
export async function embedTexts(
  texts: string[],
  opts?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<number[][]> {
  const prepared = texts.map(t => (t || '').slice(0, EMBED_MAX_CHARS) || ' ');
  const out: number[][] = [];
  let i = 0;
  while (i < prepared.length) {
    if (opts?.signal?.aborted) throw new DOMException('Embedding aborted', 'AbortError');
    // Build the next char/item-bounded batch.
    const batch: string[] = [];
    let chars = 0;
    while (
      i < prepared.length &&
      batch.length < EMBED_BATCH_ITEMS &&
      (batch.length === 0 || chars + prepared[i].length <= EMBED_BATCH_CHARS)
    ) {
      chars += prepared[i].length;
      batch.push(prepared[i]);
      i++;
    }
    const vecs = await embedBatch(batch, opts?.signal);
    out.push(...vecs);
    opts?.onProgress?.(out.length, prepared.length);
  }
  return out;
}

export async function embedText(text: string): Promise<number[]> {
  const trimmed = (text || '').slice(0, EMBED_MAX_CHARS);
  if (!trimmed) return [];
  const [vec] = await embedBatch([trimmed]);
  return vec;
}

/** Vector length the current embeddings provider produces, when known. A
 *  stored vector of another length came from a different model and must be
 *  rebuilt before it can be compared. */
export function currentEmbeddingDim(): number | null {
  const mode = embeddingsMode();
  if (mode === 'local') return LOCAL_EMBEDDING_DIM;
  if (mode === 'gemini') return 3072;
  return null;
}

/** True when a record has no vector, or one from a different embedding model. */
export function needsEmbedding(embedding: number[] | undefined): boolean {
  if (!embedding?.length) return true;
  const dim = currentEmbeddingDim();
  return dim !== null && embedding.length !== dim;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface VaultContextItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  source: string;
  tags: string[];
  extractedText: string;
  timestamp: number;
}

export interface ChatTurn { role: 'user' | 'model'; text: string; }

const toWireHistory = (history: ChatTurn[]) =>
  history.map(t => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text }));

/**
 * The model routed to Ask Second Brain reads a catalog of every snip and
 * returns the ids that help answer `question`, best first (keyword match if no
 * model can). Runs in main — see electron/vault-ask.cjs.
 */
export async function pickVaultSnippets(question: string, history: ChatTurn[] = [], limit?: number): Promise<string[]> {
  const res = await fetch(apiUrl('/api/vault/pick'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history: toWireHistory(history), limit }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return Array.isArray(data?.ids) ? data.ids : [];
}

/** Grounded answer from the given snips, on the model routed to Ask Second Brain. */
export async function* chatWithVault(history: ChatTurn[], question: string, contextItems: VaultContextItem[]): AsyncGenerator<string> {
  const res = await fetch(apiUrl('/api/vault/answer'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history: toWireHistory(history), items: contextItems }),
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith('0:')) yield JSON.parse(line.slice(2)) as string;
      else if (line.startsWith('3:')) throw new Error(JSON.parse(line.slice(2)));
    }
  }
}

export function buildEmbedSource(s: { title: string; summary: string; tags: string[]; extractedText: string; category: string; source: string; chunks?: { text: string; label: string; summary: string }[]; addedShots?: { extractedText: string }[] }): string {
  const parts = [s.title, s.summary, s.category, s.source, s.tags.join(' '), s.extractedText];
  if (s.chunks?.length) {
    for (const c of s.chunks) parts.push(c.label, c.summary, c.text);
  }
  if (s.addedShots?.length) {
    for (const a of s.addedShots) parts.push(a.extractedText);
  }
  return parts.filter(Boolean).join('\n');
}
