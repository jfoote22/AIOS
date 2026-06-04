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

export async function embedText(text: string): Promise<number[]> {
  const ai = getClient();
  const trimmed = (text || '').slice(0, 8000);
  if (!trimmed) return [];
  const result = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: trimmed,
  });
  const values = result.embeddings?.[0]?.values;
  if (!values) throw new Error('Gemini returned no embedding');
  return values;
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
