// HTTP client for the AIOS desktop mobile-gateway.
//
// All requests carry the bearer token. The gateway exposes:
//   • /api/mobile/*            curated read + write routes (this client's helpers)
//   • /api/proxy/<rest>        reverse proxy to the loopback api-server, so the
//                              heavy AI routes (chat, vision/OCR, drafting) run
//                              on the desktop with its own keys.

export interface Creds {
  url: string; // e.g. http://192.168.1.50:8766  (no trailing slash)
  token: string;
}

let creds: Creds | null = null;

export function setCreds(c: Creds | null) {
  creds = c ? { url: c.url.replace(/\/+$/, ''), token: c.token } : null;
}
export function getCreds(): Creds | null {
  return creds;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  if (!creds) throw new Error('Not paired with an AIOS desktop.');
  return { Authorization: `Bearer ${creds.token}`, ...(extra || {}) };
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function parse(res: Response) {
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && body.error) || (typeof body === 'string' && body) || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return body;
}

// ── generic verbs (against an explicit base, used by pairing too) ────────────

export async function rawPing(url: string, token: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/mobile/ping`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    return await parse(res);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('Could not reach the desktop (timed out). Check the URL and that both devices share a network.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function get(path: string) {
  const res = await fetch(`${creds!.url}${path}`, { headers: authHeaders() });
  return parse(res);
}
export async function post(path: string, body?: any) {
  const res = await fetch(`${creds!.url}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: body == null ? undefined : JSON.stringify(body),
  });
  return parse(res);
}
export async function del(path: string) {
  const res = await fetch(`${creds!.url}${path}`, { method: 'DELETE', headers: authHeaders() });
  return parse(res);
}

// ── curated mobile routes ────────────────────────────────────────────────────

export interface SnippetSummary {
  id: string;
  title: string;
  summary?: string;
  category?: string;
  source?: string;
  tags?: string[];
  timestamp?: number;
  status?: string;
  hasImage?: boolean;
  subImageCount?: number;
  extractedText?: string;
}

export interface ThreadSummary {
  id: string;
  title: string;
  timestamp: number;
  selectedModel?: string;
  messageCount?: number;
}

export const Brain = {
  list: (search = '', limit = 50, offset = 0): Promise<{ total: number; items: SnippetSummary[] }> =>
    get(`/api/mobile/snippets?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}`),
  get: (id: string): Promise<any> => get(`/api/mobile/snippets/${id}`),
  create: (item: any): Promise<{ ok: boolean; id: string }> => post('/api/mobile/snippets', item),
  remove: (id: string): Promise<{ ok: boolean }> => del(`/api/mobile/snippets/${id}`),
  ingest: (content: string, opts: { title?: string; tags?: string[]; source?: string } = {}) =>
    post('/api/mobile/ingest', { content, ...opts }),
};

export const Dives = {
  list: (): Promise<{ items: ThreadSummary[] }> => get('/api/mobile/threads'),
  get: (id: string): Promise<{ thread: any; messages: any[] }> => get(`/api/mobile/threads/${id}`),
};

export const Build = {
  agents: (): Promise<{ items: any[] }> => get('/api/mobile/agents'),
  skills: (): Promise<{ items: any[] }> => get('/api/mobile/skills'),
  createAgent: (a: { name: string; description?: string; systemPrompt?: string; allowedTools?: string[] }) =>
    post('/api/mobile/agents', a),
  createSkill: (s: { name: string; description?: string; instructions?: string }) =>
    post('/api/mobile/skills', s),
  removeAgent: (id: string) => del(`/api/mobile/agents/${id}`),
  removeSkill: (id: string) => del(`/api/mobile/skills/${id}`),
  // Drafting runs through the desktop api-server via the proxy.
  draftAgent: (field: string, payload: any) => post('/api/proxy/agents/draft', { field, ...payload }),
  draftSkill: (field: string, payload: any) => post('/api/proxy/skills/draft', { field, ...payload }),
};

// ── vision / OCR ─────────────────────────────────────────────────────────────
// Uses the gateway's Gemini OCR route (gemini-2.5-flash), matching the desktop
// snipping vault — NOT the OpenAI vision route. imageDataUrl must be a full data
// URL: data:image/png;base64,....
export async function analyzeImage(imageDataUrl: string): Promise<{
  title: string; summary: string; category: string; source: string;
  tags: string[]; entities: any[]; extractedText: string;
}> {
  return post('/api/mobile/ocr', { imageDataUrl });
}

// ── chat streaming (Vercel AI data-stream over chunked HTTP) ─────────────────
// We use XHR because RN's fetch doesn't expose a readable stream. We parse the
// `0:"..."` text-delta lines emitted by the desktop's pipeDataStreamToResponse.

export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string }

// Models the user can pick. The gateway routes each to the correct desktop
// endpoint based on your stored auth mode (subscription vs API key), so all of
// these work regardless of how you authenticate that provider.
export const MODELS = [
  { key: 'claude', label: 'Claude Opus', variant: 'opus' },
  { key: 'anthropic', label: 'Claude Sonnet', variant: 'sonnet' },
  { key: 'openai', label: 'GPT', variant: undefined },
  { key: 'grok', label: 'Grok', variant: undefined },
  { key: 'gemini', label: 'Gemini', variant: undefined },
] as const;
export type ModelKey = (typeof MODELS)[number]['key'];
export function variantForModel(key: string): string | undefined {
  return MODELS.find((m) => m.key === key)?.variant;
}

// Grok personas (the desktop "mode") — only meaningful when model === 'grok'.
export const GROK_MODES = [
  { key: 'normal', label: 'Normal' },
  { key: 'precise', label: 'Precise' },
  { key: 'fun', label: 'Fun' },
  { key: 'creative', label: 'Creative' },
  { key: 'caveman', label: 'Caveman' },
] as const;

export function streamChat(
  model: string,
  messages: ChatMessage[],
  handlers: {
    onDelta: (text: string) => void;
    onDone: () => void;
    onError: (err: string) => void;
  },
  opts: { mode?: string; context?: string } = {},
): () => void {
  if (!creds) { handlers.onError('Not paired.'); return () => {}; }
  const xhr = new XMLHttpRequest();
  let seen = 0;

  const flush = (chunk: string) => {
    // The data stream is newline-delimited frames: `<type>:<json>\n`.
    const lines = chunk.split('\n');
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const type = line.slice(0, i);
      const rest = line.slice(i + 1);
      if (!rest) continue;
      try {
        if (type === '0') {
          // text delta — a JSON-encoded string
          handlers.onDelta(JSON.parse(rest));
        } else if (type === '3') {
          handlers.onError(typeof rest === 'string' ? JSON.parse(rest) : 'stream error');
        }
        // other frame types (tool calls, finish, usage) are ignored for chat.
      } catch {
        // partial line at the boundary — ignore; it'll arrive complete next tick
      }
    }
  };

  xhr.open('POST', `${creds.url}/api/mobile/chat`);
  xhr.setRequestHeader('Authorization', `Bearer ${creds.token}`);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = () => {
    if (xhr.readyState >= 3) {
      const full = xhr.responseText || '';
      const fresh = full.slice(seen);
      // Only flush up to the last complete newline to avoid splitting a frame.
      const cut = fresh.lastIndexOf('\n');
      if (cut >= 0) {
        flush(fresh.slice(0, cut + 1));
        seen += cut + 1;
      }
    }
    if (xhr.readyState === 4) {
      // flush any trailing partial frame
      const tail = (xhr.responseText || '').slice(seen);
      if (tail) flush(tail + '\n');
      if (xhr.status >= 400) handlers.onError(`HTTP ${xhr.status}${errorHint(xhr)}`);
      else handlers.onDone();
    }
  };
  xhr.onerror = () => handlers.onError('Network error.');
  xhr.send(JSON.stringify({
    model,
    messages,
    mode: opts.mode,
    variant: variantForModel(model),
    context: opts.context,
  }));

  return () => { try { xhr.abort(); } catch {} };
}

// Surface the server's error message (the api-server returns { error } JSON on
// 4xx/5xx) so the user sees "no key configured" etc. instead of a bare 500.
function errorHint(xhr: XMLHttpRequest): string {
  try {
    const body = JSON.parse(xhr.responseText || '{}');
    if (body?.error) return ` — ${body.error}`;
  } catch {}
  return '';
}

// ── research: links / videos (proxy to api-server) ──────────────────────────

export interface ResearchItem {
  title?: string;
  url?: string;
  snippet?: string;
  description?: string;
  channel?: string;
  source?: string;
  [k: string]: any;
}
export interface ResearchResult { intro?: string; items: ResearchItem[] }

export const Research = {
  links: (context: string): Promise<ResearchResult> =>
    post('/api/proxy/research/find-links', { context }),
  videos: (context: string): Promise<ResearchResult> =>
    post('/api/proxy/research/find-videos', { context }),
};

// Autonomous Deep Research over a chunked NDJSON stream. Emits live status and
// the report as it's written (report-delta), then the final report + sources.
export function streamDeepResearch(
  query: string,
  handlers: {
    onStatus: (message: string) => void;
    onReportDelta: (text: string) => void;
    onDone: (report: string, sourceCount: number) => void;
    onError: (err: string) => void;
  },
): () => void {
  if (!creds) { handlers.onError('Not paired.'); return () => {}; }
  const xhr = new XMLHttpRequest();
  let seen = 0;

  const handleEvent = (evt: any) => {
    switch (evt?.type) {
      case 'status':
      case 'note':
        if (evt.message) handlers.onStatus(evt.message);
        break;
      case 'plan':
        handlers.onStatus(`Planning ${Array.isArray(evt.questions) ? evt.questions.length : ''} research questions…`);
        break;
      case 'source':
        if (evt.source?.title) handlers.onStatus(`Read: ${evt.source.title}`);
        break;
      case 'report-delta':
        if (evt.delta) handlers.onReportDelta(evt.delta);
        break;
      case 'report':
        // Final report text (also arrives via deltas); ignore to avoid dupes.
        break;
      case 'done':
        handlers.onDone('', Number(evt.sources) || 0);
        break;
      case 'result':
        handlers.onDone(evt.result?.report || '', Array.isArray(evt.result?.sources) ? evt.result.sources.length : 0);
        break;
      case 'error':
        handlers.onError(evt.error || 'Deep research failed.');
        break;
      case 'canceled':
        handlers.onError('Canceled.');
        break;
    }
  };

  const flush = (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { handleEvent(JSON.parse(t)); } catch { /* partial line */ }
    }
  };

  xhr.open('POST', `${creds.url}/api/mobile/deep`);
  xhr.setRequestHeader('Authorization', `Bearer ${creds.token}`);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = () => {
    if (xhr.readyState >= 3) {
      const full = xhr.responseText || '';
      const fresh = full.slice(seen);
      const cut = fresh.lastIndexOf('\n');
      if (cut >= 0) { flush(fresh.slice(0, cut + 1)); seen += cut + 1; }
    }
    if (xhr.readyState === 4) {
      const tail = (xhr.responseText || '').slice(seen);
      if (tail.trim()) flush(tail + '\n');
      if (xhr.status >= 400) handlers.onError(`HTTP ${xhr.status}`);
    }
  };
  xhr.onerror = () => handlers.onError('Network error.');
  xhr.send(JSON.stringify({ query, totalWords: 1200 }));

  return () => { try { xhr.abort(); } catch {} };
}

// ── terminal control (SSE handled separately in TerminalScreen) ──────────────
export const Term = {
  list: (): Promise<{ available: boolean; items: any[] }> => get('/api/mobile/term'),
  spawn: (opts: { cols?: number; rows?: number; cwd?: string; shell?: string } = {}) =>
    post('/api/mobile/term/spawn', opts),
  input: (id: string, data: string) => post(`/api/mobile/term/${id}/input`, { data }),
  resize: (id: string, cols: number, rows: number) => post(`/api/mobile/term/${id}/resize`, { cols, rows }),
  kill: (id: string) => post(`/api/mobile/term/${id}/kill`),
  streamUrl: (id: string) => `${creds!.url}/api/mobile/term/${id}/stream?token=${encodeURIComponent(creds!.token)}`,
};
