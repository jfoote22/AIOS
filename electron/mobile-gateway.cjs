// LAN/remote-facing gateway for the AIOS mobile (Android) companion app.
//
// Why a SEPARATE server from api-server.cjs: that one is bound loopback-only
// (127.0.0.1, random port) on purpose — it hosts privileged routes (the user's
// Anthropic key, agent execution, terminal). This gateway is the controlled
// front door we expose to other devices: it binds 0.0.0.0 on a fixed port, is
// OFF by default, every request must carry the shared bearer token, and it only
// surfaces a curated subset of capability:
//
//   • read APIs over the SQLite store (snippets / threads / agents / skills)
//   • a markdown ingest route (phone notes -> Second Brain neurons)
//   • a reverse proxy to the loopback api-server for the heavy AI routes
//     (chat, vision/OCR, deep research, agent + skill drafting) — so the phone
//     never needs the desktop's API keys; the desktop does the work
//   • an SSE + POST terminal bridge over node-pty (a real shell on the desktop)
//
// Pair a phone by giving it this machine's reachable address (LAN IP, or a
// Tailscale/VPN IP for remote use) + the bearer token. The Settings UI renders
// both as a QR code.

const express = require('express');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const sqliteStore = require('./sqlite-store.cjs');
const { getProviderKey, setProviderKey } = require('./keystore.cjs');

const DEFAULT_PORT = 8766;

let pty = null;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (e) {
  ptyLoadError = e;
  pty = null;
}

let server = null;
let currentPort = null;
let apiPort = null; // loopback api-server port, for the reverse proxy
let getWC = null;   // () => renderer webContents, for change notifications

// Tell the renderer a snippet was written so its Second Brain reloads and runs
// the enrichment pass (embedding / pending-memory). Reuses the 'memory:ingested'
// channel the Hermes ingest already drives, so SecondBrainTab picks it up.
function notifyRenderer(payload) {
  try {
    const wc = getWC && getWC();
    if (wc && !wc.isDestroyed()) wc.send('memory:ingested', payload);
  } catch {}
}

// ── token + config (persisted in the encrypted key store) ────────────────────

function getToken() {
  return getProviderKey('mobile_gateway_token') || '';
}
function ensureToken() {
  let token = getToken();
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    setProviderKey('mobile_gateway_token', token);
  }
  return token;
}
function regenerateToken() {
  const token = crypto.randomBytes(24).toString('hex');
  setProviderKey('mobile_gateway_token', token);
  return token;
}
function configuredPort() {
  const raw = Number(getProviderKey('mobile_gateway_port'));
  return Number.isFinite(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_PORT;
}
function isEnabled() {
  return getProviderKey('mobile_gateway_enabled') === '1';
}

// First non-internal IPv4 — what the UI shows / encodes in the pairing QR.
function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni && ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '0.0.0.0';
}

// ── auth ─────────────────────────────────────────────────────────────────────

function tokenFromReq(req) {
  const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (header) return header;
  // EventSource (SSE) can't set headers in the browser/RN — allow a query token.
  if (req.query && typeof req.query.token === 'string') return req.query.token.trim();
  return '';
}

function requireToken(req, res, next) {
  const token = getToken();
  if (!token || tokenFromReq(req) !== token) {
    return res.status(401).json({ error: 'Invalid or missing bearer token.' });
  }
  next();
}

// ── terminal sessions (gateway-owned, separate from the desktop UI ptys) ──────
// id -> { pty, cwd, shell, buffer: string[], subscribers: Set<res>, exited }

const termSessions = new Map();
const TERM_RING = 400; // lines/chunks of scrollback kept for SSE (re)connect

function termGenId() {
  return `mterm-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function termSpawn(opts = {}) {
  if (!pty) throw new Error(`node-pty unavailable: ${ptyLoadError?.message || 'native module failed to load'}`);
  const isWindows = process.platform === 'win32';
  const shell = opts.shell || (isWindows ? process.env.COMSPEC || 'powershell.exe' : process.env.SHELL || '/bin/bash');
  const cols = Number.isFinite(opts.cols) ? opts.cols : 80;
  const rows = Number.isFinite(opts.rows) ? opts.rows : 24;
  const cwd = (typeof opts.cwd === 'string' && opts.cwd) || process.env.HOME || process.env.USERPROFILE || process.cwd();
  const env = { ...process.env, TERM: 'xterm-256color' };
  const p = pty.spawn(shell, Array.isArray(opts.args) ? opts.args : [], {
    name: 'xterm-256color', cols, rows, cwd, env,
    ...(isWindows ? { useConptyDll: true } : {}),
  });
  const id = termGenId();
  const session = { pty: p, cwd, shell, buffer: [], subscribers: new Set(), exited: false };
  termSessions.set(id, session);

  p.onData((data) => {
    session.buffer.push(data);
    if (session.buffer.length > TERM_RING) session.buffer.splice(0, session.buffer.length - TERM_RING);
    for (const res of session.subscribers) writeSse(res, 'data', data);
  });
  p.onExit(({ exitCode, signal }) => {
    session.exited = true;
    for (const res of session.subscribers) {
      writeSse(res, 'exit', JSON.stringify({ exitCode, signal }));
      try { res.end(); } catch {}
    }
    session.subscribers.clear();
    // Keep the session object briefly so a late poller sees `exited`, then drop.
    setTimeout(() => termSessions.delete(id), 30000);
  });
  return { id, shell, cwd };
}

function writeSse(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    // Split on newlines so multi-line chunks stay valid SSE.
    for (const line of String(data).split('\n')) res.write(`data: ${line}\n`);
    res.write('\n');
  } catch {}
}

// ── reverse proxy to the loopback api-server ─────────────────────────────────
// /api/proxy/<rest>  ->  http://127.0.0.1:<apiPort>/api/<rest>
// Streams transparently (handles the Vercel AI data-stream / SSE responses).

function proxyToApi(req, res) {
  if (!apiPort) return res.status(503).json({ error: 'API server not available.' });
  const rest = req.params[0] || '';
  const upstreamPath = `/api/${rest}`;
  const headers = { ...req.headers };
  delete headers.authorization; // don't forward our bearer to the loopback server
  delete headers.host;
  delete headers['content-length']; // re-derived from the piped body
  const upstream = http.request(
    { host: '127.0.0.1', port: apiPort, method: req.method, path: upstreamPath, headers },
    (up) => {
      res.status(up.statusCode || 502);
      for (const [k, v] of Object.entries(up.headers)) {
        if (k.toLowerCase() === 'transfer-encoding') continue;
        res.setHeader(k, v);
      }
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: `Upstream error: ${err?.message || err}` });
    else try { res.end(); } catch {}
  });
  // Forward the (already-parsed?) body. We mount the proxy BEFORE express.json,
  // so req is still a raw stream here — just pipe it.
  req.pipe(upstream);
}

// Resolve a provider's auth mode the same way the renderer does (stored in the
// meta table by src/lib/authMode.ts). Determines whether to use the API-key
// route or the subscription (local CLI) route for chat.
function authModeFor(provider) {
  const map = {
    openai: 'openai-auth-mode',
    anthropic: 'anthropic-auth-mode',
    grok: 'grok-auth-mode',
    gemini: 'gemini-auth-mode',
  };
  let v = null;
  try { v = sqliteStore.call('getMeta', [map[provider]]); } catch {}
  if (v === 'subscription') return 'subscription';
  if (v === 'api') return 'api';
  return provider === 'gemini' ? 'subscription' : 'api'; // matches authMode.ts defaults
}

// Pick the api-server chat endpoint for a model + its auth mode — mirrors
// ThreadedChat.getApiEndpoint on the desktop.
function chatEndpointFor(model) {
  switch (model) {
    case 'openai':
      return authModeFor('openai') === 'subscription' ? '/api/codex-agent/chat' : '/api/openai/chat';
    case 'grok':
      return authModeFor('grok') === 'subscription' ? '/api/grok-agent/chat' : '/api/grok/chat';
    case 'gemini':
      return authModeFor('gemini') === 'subscription' ? '/api/gemini-agent/chat' : '/api/gemini/chat';
    case 'anthropic':
    case 'claude':
    default:
      return authModeFor('anthropic') === 'subscription' ? '/api/claude-agent/chat' : '/api/anthropic/chat';
  }
}

// Forward a JSON body to a loopback api-server endpoint and stream the response
// back (handles the chat data-stream + deep-research NDJSON).
function forwardJson(res, path, bodyObj) {
  if (!apiPort) return res.status(503).json({ error: 'API server not available.' });
  const payload = JSON.stringify(bodyObj);
  const upstream = http.request(
    {
      host: '127.0.0.1', port: apiPort, method: 'POST', path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    },
    (up) => {
      res.status(up.statusCode || 502);
      for (const [k, v] of Object.entries(up.headers)) {
        if (k.toLowerCase() === 'transfer-encoding') continue;
        res.setHeader(k, v);
      }
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: `Upstream error: ${err?.message || err}` });
    else try { res.end(); } catch {}
  });
  upstream.end(payload);
}

// ── data shaping helpers ─────────────────────────────────────────────────────

// Strip the heavy base64 image fields for list payloads; keep a flag so the
// client knows it can fetch the full item.
function snippetSummary(s) {
  const { image, subImages, embedding, ...rest } = s || {};
  return {
    ...rest,
    hasImage: !!image,
    subImageCount: Array.isArray(subImages) ? subImages.length : 0,
  };
}

function matchesSearch(s, q) {
  if (!q) return true;
  const hay = [
    s.title, s.summary, s.extractedText, s.category, s.source,
    Array.isArray(s.tags) ? s.tags.join(' ') : '',
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ── app ──────────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // Unauthenticated connectivity probe (no secrets) — lets the app confirm it
  // can reach the host before validating the token.
  app.get('/api/mobile/health', (_req, res) => res.json({ ok: true, name: 'AIOS' }));

  // The reverse proxy must see the RAW request body, so mount it BEFORE the JSON
  // parser. Auth still applies.
  app.all('/api/proxy/*', requireToken, proxyToApi);

  // Everything past here is JSON.
  app.use(express.json({ limit: '30mb' }));
  app.use(express.text({ type: ['text/markdown', 'text/plain'], limit: '30mb' }));

  // Authenticated handshake — confirms the token is valid + reports capability.
  app.get('/api/mobile/ping', requireToken, (_req, res) => {
    res.json({
      ok: true,
      name: 'AIOS',
      version: process.env.AIOS_VERSION || '',
      hasApi: !!apiPort,
      hasTerminal: !!pty,
      platform: process.platform,
    });
  });

  // ── Second Brain: snippets ──────────────────────────────────────────────
  app.get('/api/mobile/snippets', requireToken, (req, res) => {
    try {
      const q = typeof req.query.search === 'string' ? req.query.search : '';
      const limit = clampInt(req.query.limit, 50, 1, 500);
      const offset = clampInt(req.query.offset, 0, 0, 1e6);
      const all = sqliteStore.call('getAllSnippets', []); // already timestamp DESC
      const filtered = all.filter((s) => matchesSearch(s, q));
      res.json({
        total: filtered.length,
        items: filtered.slice(offset, offset + limit).map(snippetSummary),
      });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/mobile/snippets/:id', requireToken, (req, res) => {
    try {
      const all = sqliteStore.call('getAllSnippets', []);
      const item = all.find((s) => s.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'Not found.' });
      res.json(item);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Create a snippet from the phone (e.g. the result of a screenshot + OCR via
  // the vision proxy, or a manual note). Accepts a partial CapturedItem.
  app.post('/api/mobile/snippets', requireToken, (req, res) => {
    try {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const ts = Date.now();
      const item = {
        id: b.id || `mobile-${ts}-${crypto.randomBytes(3).toString('hex')}`,
        image: typeof b.image === 'string' ? b.image : '',
        timestamp: Number.isFinite(b.timestamp) ? b.timestamp : ts,
        tags: Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === 'string') : [],
        title: (typeof b.title === 'string' && b.title.trim()) || 'Mobile capture',
        summary: typeof b.summary === 'string' ? b.summary : '',
        source: (typeof b.source === 'string' && b.source.trim()) || 'Mobile',
        category: (typeof b.category === 'string' && b.category.trim()) || 'Mobile',
        entities: Array.isArray(b.entities) ? b.entities : [],
        subImages: Array.isArray(b.subImages) ? b.subImages : [],
        extractedText: typeof b.extractedText === 'string' ? b.extractedText : '',
        // Route through the desktop's enrichment pipeline so it gets an embedding
        // (graph + semantic search). preAnalyzed=true means "just embed, don't
        // re-derive metadata" — the mobile OCR already produced good fields.
        status: 'analyzing',
        memoryPending: true,
        memorySource: 'mobile',
        preAnalyzed: true,
      };
      sqliteStore.call('putSnippet', [item]);
      notifyRenderer({ id: item.id });
      res.json({ ok: true, id: item.id });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.delete('/api/mobile/snippets/:id', requireToken, (req, res) => {
    try {
      sqliteStore.call('removeSnippet', [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ── OCR a capture with Gemini (matches the desktop snipping vault) ───────
  // The shared /api/vision/analyze-snip route uses OpenAI; the desktop's own
  // snipping uses Gemini 2.5 Flash. We mirror the desktop here so mobile OCR is
  // consistent (and doesn't depend on the OpenAI model slot).
  app.post('/api/mobile/ocr', requireToken, async (req, res) => {
    try {
      const imageDataUrl = req.body && typeof req.body.imageDataUrl === 'string' ? req.body.imageDataUrl : '';
      const m = /^data:([^;]+);base64,(.*)$/.exec(imageDataUrl);
      if (!m) return res.status(400).json({ error: 'imageDataUrl (a data:...;base64 URL) is required.' });

      const key = getProviderKey('gemini');
      if (!key) return res.status(400).json({ error: 'Gemini key not configured on the desktop (Models tab).' });

      const { GoogleGenAI, Type } = await import('@google/genai');
      const client = new GoogleGenAI({ apiKey: key });

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          summary: { type: Type.STRING },
          category: { type: Type.STRING },
          source: { type: Type.STRING },
          tags: { type: Type.ARRAY, items: { type: Type.STRING } },
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
          extractedText: { type: Type.STRING },
        },
        required: ['title', 'summary', 'category', 'source', 'tags', 'entities', 'extractedText'],
      };

      const result = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: m[1], data: m[2] } },
            { text: `You are the AI curator for "AIOS Vault" — a personal knowledge capture tool. The user has just captured this screenshot. Analyze it and return structured metadata so it can be filed and searched later.\n\nBe specific and faithful to what is actually visible. Do not invent details. If the image is mostly empty or unreadable, say so honestly in the summary.` },
          ],
        }],
        config: { responseMimeType: 'application/json', responseSchema },
      });

      const text = result.text;
      if (!text) return res.status(502).json({ error: 'Gemini returned no content.' });
      const parsed = JSON.parse(text);
      const allowed = new Set(['link', 'number', 'address', 'info']);
      parsed.entities = (parsed.entities || []).map((e) => ({ ...e, type: allowed.has(e?.type) ? e.type : 'info' }));
      parsed.tags = Array.isArray(parsed.tags) ? parsed.tags : [];
      parsed.extractedText = parsed.extractedText || '';
      res.json(parsed);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ── Chat router (auth-aware): picks the right upstream per model ─────────
  // Body: { model, messages, mode?, variant?, context? }. Streams back the
  // Vercel AI data-stream the api-server produces.
  app.post('/api/mobile/chat', requireToken, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const model = typeof b.model === 'string' ? b.model : 'claude';
    const messages = Array.isArray(b.messages) ? b.messages : [];
    if (!messages.length) return res.status(400).json({ error: 'messages are required.' });
    forwardJson(res, chatEndpointFor(model), {
      messages,
      mode: typeof b.mode === 'string' ? b.mode : 'normal',          // Grok persona
      variant: typeof b.variant === 'string' ? b.variant : undefined, // claude opus/sonnet
      context: typeof b.context === 'string' ? b.context : undefined,
      showReasoning: false,
    });
  });

  // Deep Research with the anthropic auth mode injected (the report synthesis
  // needs Claude — subscription users would otherwise get a key error).
  app.post('/api/mobile/deep', requireToken, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const query = typeof b.query === 'string' ? b.query : '';
    if (!query.trim()) return res.status(400).json({ error: 'query is required.' });
    forwardJson(res, '/api/research/deep', {
      query,
      totalWords: Number.isFinite(b.totalWords) ? b.totalWords : 1200,
      authMode: authModeFor('anthropic'),
    });
  });

  // ── DeepDives: threads + messages ───────────────────────────────────────
  app.get('/api/mobile/threads', requireToken, (_req, res) => {
    try {
      const threads = sqliteStore.call('getAllThreads', []);
      const items = threads
        .map((t) => ({
          id: t.id,
          timestamp: t.timestamp || 0,
          title: t.title || t.name || 'Untitled DeepDive',
          selectedModel: t.selectedModel || '',
          messageCount: Array.isArray(t.mainMessages) ? t.mainMessages.length : undefined,
        }))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/mobile/threads/:id', requireToken, (req, res) => {
    try {
      const threads = sqliteStore.call('getAllThreads', []);
      const thread = threads.find((t) => t.id === req.params.id);
      if (!thread) return res.status(404).json({ error: 'Not found.' });
      const messages = sqliteStore.call('getMessagesForThread', [req.params.id]);
      res.json({ thread, messages });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ── Agents + Skills (read + create + delete) ────────────────────────────
  app.get('/api/mobile/agents', requireToken, (_req, res) => {
    try { res.json({ items: sqliteStore.call('getAllAgents', []) }); }
    catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.get('/api/mobile/skills', requireToken, (_req, res) => {
    try { res.json({ items: sqliteStore.call('getAllSkills', []) }); }
    catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Slugify a name the same way the desktop builders do.
  const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

  app.post('/api/mobile/agents', requireToken, (req, res) => {
    try {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const name = (typeof b.name === 'string' && b.name.trim()) || 'New agent';
      const slug = slugify(b.slug || name) || `agent-${crypto.randomBytes(3).toString('hex')}`;
      const now = Date.now();
      const item = {
        id: b.id || `agent-${now}-${crypto.randomBytes(3).toString('hex')}`,
        slug, name,
        description: typeof b.description === 'string' ? b.description : '',
        systemPrompt: typeof b.systemPrompt === 'string' ? b.systemPrompt : '',
        allowedTools: Array.isArray(b.allowedTools) ? b.allowedTools : ['Read', 'Grep', 'Glob'],
        model: typeof b.model === 'string' ? b.model : 'inherit',
        updatedAt: now,
        createdVia: 'mobile',
      };
      sqliteStore.call('putAgent', [item]);
      res.json({ ok: true, id: item.id, slug });
    } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.delete('/api/mobile/agents/:id', requireToken, (req, res) => {
    try { sqliteStore.call('removeAgent', [req.params.id]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post('/api/mobile/skills', requireToken, (req, res) => {
    try {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const name = (typeof b.name === 'string' && b.name.trim()) || 'New skill';
      const slug = slugify(b.slug || name) || `skill-${crypto.randomBytes(3).toString('hex')}`;
      const now = Date.now();
      const item = {
        id: b.id || `skill-${now}-${crypto.randomBytes(3).toString('hex')}`,
        slug, name,
        description: typeof b.description === 'string' ? b.description : '',
        instructions: typeof b.instructions === 'string' ? b.instructions : '',
        allowedTools: Array.isArray(b.allowedTools) ? b.allowedTools : [],
        updatedAt: now,
        createdVia: 'mobile',
      };
      sqliteStore.call('putSkill', [item]);
      res.json({ ok: true, id: item.id, slug });
    } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.delete('/api/mobile/skills/:id', requireToken, (req, res) => {
    try { sqliteStore.call('removeSkill', [req.params.id]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ── Markdown ingest -> Second Brain neuron (mirrors memory-ingest) ───────
  app.post('/api/mobile/ingest', requireToken, (req, res) => {
    let body = req.body;
    if (typeof body === 'string') body = { content: body };
    body = body && typeof body === 'object' ? body : {};
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) return res.status(400).json({ error: 'A non-empty `content` field is required.' });
    const ts = Date.now();
    const id = `mobile-${ts}-${crypto.randomBytes(3).toString('hex')}`;
    const h1 = /^#\s+(.+)$/m.exec(content);
    const title = (typeof body.title === 'string' && body.title.trim()) || (h1 && h1[1].trim()) || 'Mobile note';
    const item = {
      id, image: '', timestamp: ts,
      tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string') : [],
      title: String(title).slice(0, 200),
      summary: '',
      source: (typeof body.source === 'string' && body.source.trim()) || 'Mobile',
      category: (typeof body.category === 'string' && body.category.trim()) || 'Mobile',
      entities: [], subImages: [], extractedText: content,
      status: 'analyzing', memoryPending: true, memorySource: 'mobile',
    };
    try {
      sqliteStore.call('putSnippet', [item]);
      notifyRenderer({ id });
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ error: `Failed to store note: ${e?.message || e}` });
    }
  });

  // ── Terminal bridge (SSE for output, POST for control) ──────────────────
  app.get('/api/mobile/term', requireToken, (_req, res) => {
    const items = Array.from(termSessions.entries()).map(([id, s]) => ({
      id, cwd: s.cwd, shell: s.shell, exited: s.exited,
    }));
    res.json({ available: !!pty, items });
  });

  app.post('/api/mobile/term/spawn', requireToken, (req, res) => {
    try { res.json(termSpawn(req.body || {})); }
    catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/mobile/term/:id/stream', requireToken, (req, res) => {
    const session = termSessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'No such terminal session.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    // Replay scrollback so a (re)connecting client sees current screen state.
    if (session.buffer.length) writeSse(res, 'data', session.buffer.join(''));
    if (session.exited) { writeSse(res, 'exit', JSON.stringify({ exitCode: 0 })); return res.end(); }
    session.subscribers.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(ka); session.subscribers.delete(res); });
  });

  app.post('/api/mobile/term/:id/input', requireToken, (req, res) => {
    const session = termSessions.get(req.params.id);
    if (!session || session.exited) return res.status(404).json({ error: 'No such terminal session.' });
    const data = req.body && typeof req.body.data === 'string' ? req.body.data : '';
    try { session.pty.write(data); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post('/api/mobile/term/:id/resize', requireToken, (req, res) => {
    const session = termSessions.get(req.params.id);
    if (!session || session.exited) return res.status(404).json({ error: 'No such terminal session.' });
    const cols = clampInt(req.body?.cols, 80, 2, 500);
    const rows = clampInt(req.body?.rows, 24, 2, 300);
    try { session.pty.resize(cols, rows); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post('/api/mobile/term/:id/kill', requireToken, (req, res) => {
    const session = termSessions.get(req.params.id);
    if (!session) return res.json({ ok: true });
    try { session.pty.kill(); } catch {}
    res.json({ ok: true });
  });

  return app;
}

// ── lifecycle ──────────────────────────────────────────────────────────────

/**
 * Start the gateway. `opts.apiPort` is the loopback api-server port used by the
 * reverse proxy. Resolves to { port, token, address }; rejects on bind error.
 */
function start(opts = {}) {
  if (typeof opts.apiPort === 'number') apiPort = opts.apiPort;
  if (typeof opts.getWebContents === 'function') getWC = opts.getWebContents;
  if (server) return Promise.resolve({ port: currentPort, token: ensureToken(), address: lanAddress() });
  ensureToken();
  const port = configuredPort();
  return new Promise((resolve, reject) => {
    const app = buildApp();
    const srv = app.listen(port, '0.0.0.0', () => {
      server = srv;
      currentPort = port;
      console.log(`[mobile-gateway] listening on http://0.0.0.0:${port} (LAN ${lanAddress()}:${port})`);
      resolve({ port, token: getToken(), address: lanAddress() });
    });
    srv.on('error', (err) => {
      console.error('[mobile-gateway] failed to bind:', err?.message || err);
      reject(err);
    });
  });
}

function stop() {
  for (const [, s] of termSessions) { try { s.pty.kill(); } catch {} }
  termSessions.clear();
  if (server) {
    try { server.close(); } catch {}
    server = null;
    currentPort = null;
  }
}

function setApiPort(port) {
  if (typeof port === 'number') apiPort = port;
}

function status() {
  return {
    enabled: isEnabled(),
    running: !!server,
    port: currentPort || configuredPort(),
    address: lanAddress(),
    hasToken: !!getToken(),
    token: getToken(),
    hasTerminal: !!pty,
  };
}

module.exports = {
  start, stop, status, setApiPort,
  ensureToken, regenerateToken,
  isEnabled, configuredPort, lanAddress,
  DEFAULT_PORT,
};
