// DeepDive research attachments: links and files the user adds as context.
// Extraction runs server-side (electron/extract.cjs via /api/research/*); the
// cleaned text is injected into the chat message before it reaches any model,
// so this is fully model-agnostic.

import { apiUrl } from './apiBase';

export type AttachmentKind = 'url' | 'file';
export type AttachmentStatus = 'extracting' | 'ready' | 'error';

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  /** Short display label (hostname/path or file name). */
  label: string;
  /** Original URL or file path. */
  source: string;
  status: AttachmentStatus;
  /** Extracted, cleaned text (present once status === 'ready'). */
  text?: string;
  /** Best-effort title from the page/document. */
  title?: string;
  charCount?: number;
  truncated?: boolean;
  error?: string;
  /** True once this attachment's text has been folded into the conversation. */
  injected?: boolean;
}

// Matches http(s) URLs in free text. Trailing punctuation is trimmed by callers.
const URL_REGEX = /\bhttps?:\/\/[^\s<>"')]+/gi;

export function detectUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) || [];
  const cleaned = matches.map(m => m.replace(/[.,;:!?]+$/, ''));
  return Array.from(new Set(cleaned));
}

export function newAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function fileLabel(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function hostLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return (u.hostname + path).replace(/\/$/, '').slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

// Fetch + extract a URL into a ready/errored attachment.
export async function fetchUrlAttachment(url: string): Promise<Attachment> {
  const id = newAttachmentId();
  const base: Attachment = { id, kind: 'url', label: hostLabel(url), source: url, status: 'extracting' };
  try {
    const res = await fetch(apiUrl('/api/research/fetch-url'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    if (!data.text || !data.text.trim()) {
      throw new Error('No readable content found — the page may require login or render entirely in JavaScript. Try copying the text directly into your message.');
    }
    return {
      ...base,
      status: 'ready',
      text: data.text || '',
      title: data.title || base.label,
      label: data.title ? data.title.slice(0, 60) : base.label,
      charCount: data.charCount ?? (data.text?.length || 0),
      truncated: !!data.truncated,
    };
  } catch (e: any) {
    return { ...base, status: 'error', error: e?.message || 'Extraction failed' };
  }
}

// Extract a local file into a ready/errored attachment.
export async function fetchFileAttachment(filePath: string): Promise<Attachment> {
  const id = newAttachmentId();
  const label = fileLabel(filePath);
  const base: Attachment = { id, kind: 'file', label, source: filePath, status: 'extracting' };
  try {
    const res = await fetch(apiUrl('/api/research/extract-file'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    if (!data.text || !data.text.trim()) {
      throw new Error('No readable text could be extracted from this file.');
    }
    return {
      ...base,
      status: 'ready',
      text: data.text || '',
      title: data.title || label,
      charCount: data.charCount ?? (data.text?.length || 0),
      truncated: !!data.truncated,
    };
  } catch (e: any) {
    return { ...base, status: 'error', error: e?.message || 'Extraction failed' };
  }
}

// ---------------------------------------------------------------------------
// Real link/video retrieval for the "Get Links" / "Get Videos" thread actions.
// ---------------------------------------------------------------------------

export interface LinkItem {
  title: string;
  url: string;
  source: string;
  reason?: string;
}

export interface VideoItem {
  title: string;
  url: string;
  videoId: string;
  channel: string;
  channelUrl?: string;
  publishedAt?: string;
  viewCount?: number;
  likeCount?: number;
  duration?: string;
  thumbnail?: string;
}

export interface ResearchResult<T> {
  intro: string;
  items: T[];
}

export async function findLinks(context: string): Promise<ResearchResult<LinkItem>> {
  const res = await fetch(apiUrl('/api/research/find-links'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return { intro: data.intro || '', items: Array.isArray(data.items) ? data.items : [] };
}

export async function findVideos(context: string): Promise<ResearchResult<VideoItem>> {
  const res = await fetch(apiUrl('/api/research/find-videos'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return { intro: data.intro || '', items: Array.isArray(data.items) ? data.items : [] };
}

// ---------------------------------------------------------------------------
// Deep Research: autonomous plan → search → read → synthesize, streamed as NDJSON.
// ---------------------------------------------------------------------------

export interface DeepSource {
  n: number;
  title: string;
  url: string;
  subQuestion: string;
  summary: string;
}

export interface Citation {
  n: number;
  title: string;
  url: string;
}

export interface ClaimVerdict {
  claim: string;
  citation: number | null;
  verdict: 'supported' | 'partial' | 'unsupported';
  note: string;
}

export interface VerifyResult {
  claims: ClaimVerdict[];
  tally?: Record<string, number>;
}

export interface DeepResearchConfig {
  breadth: number;
  depth: number;
  perQuery: number;
  concurrency: number;
  totalWords: number;
}

// One streamed event from /api/research/deep. Discriminated by `type`.
export type DeepEvent =
  | { type: 'run'; runId: string }
  | { type: 'status'; phase: string; message: string }
  | { type: 'plan'; query: string; questions: string[]; config: DeepResearchConfig }
  | { type: 'depth'; level: number; total: number; questions: string[] }
  | { type: 'source'; source: DeepSource }
  | { type: 'note'; message: string }
  | { type: 'report-delta'; delta: string }
  | { type: 'report'; report: string; citations: Citation[] }
  | { type: 'done'; sources: number }
  | { type: 'result'; result: DeepResearchData }
  | { type: 'canceled' }
  | { type: 'error'; error: string };

// The consolidated payload persisted on a deep-research thread.
export interface DeepResearchData {
  query: string;
  config: DeepResearchConfig;
  plan: string[];
  sources: DeepSource[];
  report: string;
  citations: Citation[];
}

export interface DeepResearchOptions {
  runId?: string;
  breadth?: number;
  depth?: number;
  perQuery?: number;
  concurrency?: number;
  totalWords?: number;
  authMode?: string;
  signal?: AbortSignal;
}

// Open the deep-research stream and invoke onEvent for each NDJSON event.
// Resolves when the stream ends. Throwing inside onEvent is swallowed so a
// single bad render can't tear down the whole stream.
export async function runDeepResearch(
  query: string,
  opts: DeepResearchOptions,
  onEvent: (e: DeepEvent) => void,
): Promise<void> {
  const res = await fetch(apiUrl('/api/research/deep'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      runId: opts.runId,
      breadth: opts.breadth,
      depth: opts.depth,
      perQuery: opts.perQuery,
      concurrency: opts.concurrency,
      totalWords: opts.totalWords,
      authMode: opts.authMode,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any)?.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dispatch = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: DeepEvent | null = null;
    try { event = JSON.parse(trimmed); } catch { return; }
    if (event) { try { onEvent(event); } catch (e) { console.error('deep event handler error:', e); } }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      dispatch(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) dispatch(buffer);
}

export async function cancelDeepResearch(runId: string): Promise<void> {
  try {
    await fetch(apiUrl('/api/research/deep/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    });
  } catch { /* best effort */ }
}

export async function verifyDeepReport(
  query: string,
  report: string,
  sources: DeepSource[],
  authMode?: string,
): Promise<VerifyResult> {
  const res = await fetch(apiUrl('/api/research/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, report, sources, authMode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error || `HTTP ${res.status}`);
  return { claims: Array.isArray(data.claims) ? data.claims : [], tally: data.tally };
}

// Compact number formatting for view/like counts (e.g. 1.2M, 45K).
export function formatCount(n?: number): string {
  if (!n || n < 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// Relative "time ago" for publish dates (e.g. "3 months ago").
export function timeAgo(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

// Build the context block that gets prepended to the user's message for
// attachments that are ready and not yet injected. Returns '' if there's
// nothing new to add.
export function buildSourcesBlock(attachments: Attachment[]): string {
  const fresh = attachments.filter(a => a.status === 'ready' && a.text && !a.injected);
  if (fresh.length === 0) return '';

  const blocks = fresh.map((a, i) => {
    const header = `### Source ${i + 1}: ${a.title || a.label}`;
    const meta = `(${a.kind === 'url' ? a.source : a.label})${a.truncated ? ' — truncated' : ''}`;
    return `${header}\n${meta}\n\n${a.text}`;
  });

  return [
    '<attached-research-sources>',
    'The following sources were attached by the user as research context. Use them to inform your answer; cite them as "Source N" when relevant.',
    '',
    blocks.join('\n\n---\n\n'),
    '</attached-research-sources>',
    '',
  ].join('\n');
}
