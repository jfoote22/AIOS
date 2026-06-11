// AI layer. Phase 1: Gemini for snippet analysis + embeddings + Ask the Vault chat.
// Phase 2 will add OpenAI/Anthropic/Grok routing for DeepDive chat.

import { GoogleGenAI, Type } from '@google/genai';
import { apiUrl } from './apiBase';

export type OcrProvider = 'openai' | 'gemini' | 'anthropic' | 'grok';

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

let runtimeKey: string = '';
let client: GoogleGenAI | null = null;
const listeners = new Set<(ready: boolean) => void>();

export function setGeminiKey(key: string): void {
  const trimmed = (key || '').trim();
  if (trimmed === runtimeKey) return;
  runtimeKey = trimmed;
  client = null;
  for (const fn of listeners) fn(!!runtimeKey);
}

export function onGeminiReadyChange(fn: (ready: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function getClient(): GoogleGenAI {
  if (!runtimeKey) {
    throw new Error('Gemini API key is not configured. Open Models to add your key.');
  }
  if (!client) client = new GoogleGenAI({ apiKey: runtimeKey });
  return client;
}

export function isGeminiReady(): boolean {
  return !!runtimeKey;
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '5-10 word descriptive title for this capture' },
    summary: { type: Type.STRING, description: 'A concise paragraph (2-4 sentences) describing what is in the image and what it appears to be doing or showing' },
    category: { type: Type.STRING, description: 'One short category name like Houdini, Travel, Finance, Development, Design, Reference, Personal, General' },
    source: { type: Type.STRING, description: 'Best guess of the source app/website based on visible UI cues (e.g. Chrome, VS Code, Houdini, YouTube, Slack)' },
    tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: '3-8 lowercase keyword tags' },
    entities: {
      type: Type.ARRAY,
      description: 'Notable extracted entities like phone numbers, addresses, prices, URLs, dates, names, product names, version strings',
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, description: 'One of: link, number, address, info' },
          label: { type: Type.STRING, description: 'Short label for what this entity represents' },
          value: { type: Type.STRING, description: 'The literal extracted value' },
        },
        required: ['type', 'label', 'value'],
      },
    },
    extractedText: { type: Type.STRING, description: 'All readable text in the image, transcribed verbatim. Empty string if no text.' },
  },
  required: ['title', 'summary', 'category', 'source', 'tags', 'entities', 'extractedText'],
};

function dataUrlToInline(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) throw new Error('Invalid data URL');
  return { mimeType: match[1], data: match[2] };
}

export async function analyzeSnip(imageDataUrl: string): Promise<SnipAnalysis> {
  const ai = getClient();
  const inline = dataUrlToInline(imageDataUrl);

  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [
        { inlineData: inline },
        { text: `You are the AI curator for "AIOS Vault" — a personal knowledge capture tool. The user has just captured this screenshot. Analyze it and return structured metadata so it can be filed and searched later.\n\nBe specific and faithful to what is actually visible. Do not invent details. If the image is mostly empty or unreadable, say so honestly in the summary.` },
      ],
    }],
    config: { responseMimeType: 'application/json', responseSchema },
  });

  const text = result.text;
  if (!text) throw new Error('Gemini returned no content');
  const parsed = JSON.parse(text) as SnipAnalysis;

  const allowed = new Set(['link', 'number', 'address', 'info']);
  parsed.entities = (parsed.entities ?? []).map(e => ({ ...e, type: allowed.has(e.type) ? e.type : 'info' }));
  parsed.tags = parsed.tags ?? [];
  return parsed;
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

/** OCR a capture after downscaling. Preferred entry point for raw captures. */
export async function analyzeSnipScaled(dataUrl: string): Promise<SnipAnalysis> {
  return analyzeSnip(await downscaleDataUrl(dataUrl));
}

// Dispatches snippet analysis to the chosen vision provider.
// - 'gemini' uses the direct GoogleGenAI SDK from the renderer.
// - 'openai' goes through the local Electron API server (which holds the encrypted key
//   in main and pulls the user-configured model ID from provider-models.json).
// - 'anthropic' / 'grok' are not yet wired.
export async function analyzeSnipWith(provider: OcrProvider, imageDataUrl: string): Promise<SnipAnalysis> {
  if (provider === 'gemini') return analyzeSnip(imageDataUrl);
  if (provider === 'openai') {
    const res = await fetch(apiUrl('/api/vision/analyze-snip'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl, provider: 'openai' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `OpenAI vision failed (${res.status})`);
    }
    return res.json();
  }
  throw new Error(`${provider} OCR is not yet wired. Switch to OpenAI or Gemini.`);
}

export function isOcrProviderReady(provider: OcrProvider, configured: Set<string>): boolean {
  if (provider === 'gemini') return configured.has('gemini') || isGeminiReady();
  if (provider === 'openai') return configured.has('openai');
  return false;
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
  const ai = getClient();
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [{ text: `You are extracting a chunk of saved text from a user's personal knowledge vault. Analyze this text fragment and return structured metadata. Be specific. Do not invent details.\n\nText:\n"""\n${text}\n"""` }],
    }],
    config: { responseMimeType: 'application/json', responseSchema: textResponseSchema },
  });

  const out = result.text;
  if (!out) throw new Error('Gemini returned no content');
  const parsed = JSON.parse(out) as TextAnalysis;
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
  const ai = getClient();
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [{ text: `You are filing a markdown document into a personal knowledge vault. Analyze it and return structured metadata. Be specific; do not invent details.\n\nDocument:\n"""\n${text}\n"""` }],
    }],
    config: { responseMimeType: 'application/json', responseSchema: markdownResponseSchema },
  });

  const out = result.text;
  if (!out) throw new Error('Gemini returned no content');
  const parsed = JSON.parse(out) as MarkdownAnalysis;
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
  const ai = getClient();

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

  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseMimeType: 'application/json', responseSchema: understandingSchema },
  });

  const out = result.text;
  if (!out) throw new Error('Gemini returned no content');
  return validateUnderstanding(JSON.parse(out) as DeepDiveUnderstanding);
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
  const ai = getClient();

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

  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseMimeType: 'application/json', responseSchema: understandingSchema },
  });

  const out = result.text;
  if (!out) throw new Error('Gemini returned no content');
  return validateUnderstanding(JSON.parse(out) as DeepDiveUnderstanding);
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
  // Embeddings run through the local Electron API server, which holds the
  // Gemini key in main (encrypted keystore). This is immune to the renderer's
  // in-memory key being wiped by a hot-reload or boot race mid-job.
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
  if (!Array.isArray(embs) || !embs.length) throw new Error('Gemini returned no embeddings');
  return embs.map((v: unknown) => {
    if (!Array.isArray(v) || !v.length) throw new Error('Gemini returned an empty embedding');
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
      throw new Error('Gemini returned the wrong number of embeddings');
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

export async function* chatWithVault(history: ChatTurn[], question: string, contextItems: VaultContextItem[]): AsyncGenerator<string> {
  const ai = getClient();

  const contextBlock = contextItems.length
    ? contextItems.map((c, i) => {
        const date = new Date(c.timestamp).toLocaleString();
        return `[Snip ${i + 1}] (id=${c.id}, captured ${date})\nTitle: ${c.title || '(no title)'}\nCategory: ${c.category} | Source: ${c.source}\nTags: ${c.tags.join(', ') || '(none)'}\nSummary: ${c.summary}\nExtracted text: ${(c.extractedText || '(no text)').slice(0, 1500)}`;
      }).join('\n\n')
    : '(The vault has no relevant snips for this question.)';

  const systemInstruction = `You are the personal AI assistant for "AIOS Vault" — a private knowledge base of screenshots and notes the user has captured over time. Answer the user's question using ONLY the snips provided as context. If the answer is not in the context, say so honestly and suggest what they could capture or search for. When you reference information, cite which snip it came from like [Snip 2]. Keep answers concise and useful. Today's date is ${new Date().toLocaleDateString()}.`;

  const contents = [
    ...history.map(t => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: 'user', parts: [{ text: `Context from my vault (top matches for my question):\n\n${contextBlock}\n\nMy question: ${question}` }] },
  ];

  const stream = await ai.models.generateContentStream({
    model: 'gemini-2.5-flash',
    contents,
    config: { systemInstruction },
  });

  for await (const chunk of stream) {
    const t = chunk.text;
    if (t) yield t;
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
