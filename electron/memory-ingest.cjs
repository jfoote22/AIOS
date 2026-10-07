// LAN-facing webhook that turns external markdown (e.g. Hermes task output on
// the Mac) into Second Brain neurons.
//
// Why a SEPARATE server from api-server.cjs: that one is bound loopback-only
// (127.0.0.1, random port) on purpose — it hosts privileged routes (the user's
// Anthropic key, agent execution, terminal). This module is the ONLY thing we
// expose to the LAN: it binds 0.0.0.0 on a fixed port, serves exactly one route,
// is off by default, and every request must carry the shared bearer token.
//
// It stores a single RAW neuron in the 'analyzing' state and stops there.
// Categorization, chunking, and embedding happen later in the renderer
// (src/lib/memory.ts) because the Gemini key only exists in the renderer.

const express = require('express');
const crypto = require('node:crypto');
const os = require('node:os');
const sqliteStore = require('./sqlite-store.cjs');
const { getProviderKey, setProviderKey } = require('./keystore.cjs');
const { bearerToken, tokensEqual } = require('./http-security.cjs');

const DEFAULT_PORT = 8765;

let server = null;
let currentPort = null;
let notify = () => {};
// Why the last start() failed, surfaced through status() so the Hermes settings
// tab can show it. Without this a failed bind was invisible: the app looked
// healthy while silently serving nothing.
let lastError = null;

// ── token + config (persisted in the encrypted key store) ────────────────────

function getToken() {
  return getProviderKey('memory_ingest_token') || '';
}

/** Return the token, generating + persisting one on first use. */
function ensureToken() {
  let token = getToken();
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    setProviderKey('memory_ingest_token', token);
  }
  return token;
}

function regenerateToken() {
  const token = crypto.randomBytes(24).toString('hex');
  setProviderKey('memory_ingest_token', token);
  return token;
}

function configuredPort() {
  const raw = Number(getProviderKey('memory_ingest_port'));
  return Number.isFinite(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_PORT;
}

function isEnabled() {
  return getProviderKey('memory_ingest_enabled') === '1';
}

// Pick the first non-internal IPv4 so the UI can show a reachable URL to paste
// into a Hermes job. Falls back to the bind address if none is found.
function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni && ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '0.0.0.0';
}

// ── markdown → raw neuron ────────────────────────────────────────────────────

function firstH1(md) {
  const m = /^#\s+(.+)$/m.exec(md || '');
  return m ? m[1].trim() : '';
}

function buildApp() {
  const app = express();
  app.use('/api/memory/ingest', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!tokensEqual(bearerToken(req), getToken())) {
      return res.status(401).json({ error: 'Invalid or missing bearer token.' });
    }
    next();
  });
  app.use(express.json({ limit: '25mb' }));
  app.use(express.text({ type: ['text/markdown', 'text/plain'], limit: '25mb' }));

  app.post('/api/memory/ingest', (req, res) => {
    // Accept either JSON { content, title?, ... } or a raw markdown/plain body.
    let body = req.body;
    if (typeof body === 'string') body = { content: body };
    body = body && typeof body === 'object' ? body : {};

    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) {
      return res.status(400).json({ error: 'A non-empty `content` (markdown) field is required.' });
    }

    const ts = Date.now();
    const id = `hermes-${ts}-${crypto.randomBytes(3).toString('hex')}`;
    const title =
      (typeof body.title === 'string' && body.title.trim()) ||
      firstH1(content) ||
      (typeof body.jobName === 'string' && body.jobName.trim()) ||
      'Hermes note';

    // A CapturedItem in the 'analyzing' state. The extra memory* fields ride
    // inside the JSON blob (sqlite-store only promotes id/timestamp/category/
    // originThreadId to columns) and tell the renderer this needs enrichment.
    const item = {
      id,
      image: '',
      timestamp: ts,
      tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string') : [],
      title: String(title).slice(0, 200),
      summary: '',
      source: (typeof body.source === 'string' && body.source.trim()) || 'Hermes',
      category: (typeof body.category === 'string' && body.category.trim()) || 'Hermes',
      entities: [],
      subImages: [],
      extractedText: content,
      status: 'analyzing',
      memoryPending: true,
      memorySource: 'hermes',
      ...(typeof body.jobName === 'string' && body.jobName.trim()
        ? { memoryJobName: body.jobName.trim() }
        : {}),
    };

    try {
      sqliteStore.call('putSnippet', [item]);
    } catch (e) {
      return res.status(500).json({ error: `Failed to store note: ${e?.message || e}` });
    }

    try { notify({ id }); } catch {}
    res.json({ ok: true, id });
  });

  return app;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Start the listener on the configured port. `getWebContents` is called lazily
 * on each ingest so a reload/recreate of the window still receives events.
 * Resolves to { port, token, address }; rejects on bind error (e.g. port busy).
 */
function start({ getWebContents } = {}) {
  if (server) return Promise.resolve({ port: currentPort, token: ensureToken(), address: lanAddress() });
  ensureToken();
  notify = (payload) => {
    try {
      const wc = getWebContents && getWebContents();
      if (wc && !wc.isDestroyed()) wc.send('memory:ingested', payload);
    } catch {}
  };
  const port = configuredPort();

  // A previous AIOS process that hasn't fully exited still owns the port for a
  // few seconds (and Windows leaves it in TIME_WAIT), so a single attempt at
  // startup loses a race it would win a moment later. Retry with backoff before
  // giving up — EADDRINUSE here means external notes silently stop arriving.
  const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

  const attempt = (tryIndex) => new Promise((resolve, reject) => {
    const srv = buildApp().listen(port, '0.0.0.0', () => {
      srv.removeAllListeners('error');
      server = srv;
      currentPort = port;
      lastError = null;
      console.log(`[memory-ingest] listening on http://0.0.0.0:${port} (LAN ${lanAddress()}:${port})`);
      resolve({ port, token: getToken(), address: lanAddress() });
    });
    srv.once('error', (err) => {
      const retriable = err && (err.code === 'EADDRINUSE' || err.code === 'EACCES');
      const delay = RETRY_DELAYS_MS[tryIndex];
      if (retriable && delay != null) {
        console.warn(`[memory-ingest] port ${port} busy (${err.code}); retrying in ${delay}ms`);
        setTimeout(() => attempt(tryIndex + 1).then(resolve, reject), delay);
        return;
      }
      lastError =
        err?.code === 'EADDRINUSE'
          ? `Port ${port} is already in use — another AIOS instance or app is holding it.`
          : `Could not start the ingest listener: ${err?.message || err}`;
      console.error('[memory-ingest] failed to bind:', lastError);
      reject(err);
    });
  });

  return attempt(0);
}

function stop() {
  if (server) {
    // close() alone only stops NEW connections; it then waits for open ones to
    // end. Ingest clients use HTTP keep-alive, so an idle socket can hold the
    // port well past stop() returning — and the Hermes settings toggle restarts
    // with stop() immediately followed by start(). Dropping live connections is
    // what actually frees the port for the rebind.
    try { server.close(); } catch {}
    try { server.closeAllConnections?.(); } catch {}
    server = null;
    currentPort = null;
  }
}

function status() {
  return {
    enabled: isEnabled(),
    running: !!server,
    port: currentPort || configuredPort(),
    address: lanAddress(),
    hasToken: !!getToken(),
    token: getToken(),
    lastError: !server ? lastError : null,
  };
}

module.exports = {
  start, stop, status,
  ensureToken, regenerateToken,
  isEnabled, configuredPort, lanAddress,
  DEFAULT_PORT,
};
