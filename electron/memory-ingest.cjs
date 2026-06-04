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

const DEFAULT_PORT = 8765;

let server = null;
let currentPort = null;
let notify = () => {};

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
  app.use(express.json({ limit: '25mb' }));
  app.use(express.text({ type: ['text/markdown', 'text/plain'], limit: '25mb' }));

  app.post('/api/memory/ingest', (req, res) => {
    const token = getToken();
    const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token || provided !== token) {
      return res.status(401).json({ error: 'Invalid or missing bearer token.' });
    }

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
  return new Promise((resolve, reject) => {
    const app = buildApp();
    const srv = app.listen(port, '0.0.0.0', () => {
      server = srv;
      currentPort = port;
      console.log(`[memory-ingest] listening on http://0.0.0.0:${port} (LAN ${lanAddress()}:${port})`);
      resolve({ port, token: getToken(), address: lanAddress() });
    });
    srv.on('error', (err) => {
      console.error('[memory-ingest] failed to bind:', err?.message || err);
      reject(err);
    });
  });
}

function stop() {
  if (server) {
    try { server.close(); } catch {}
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
  };
}

module.exports = {
  start, stop, status,
  ensureToken, regenerateToken,
  isEnabled, configuredPort, lanAddress,
  DEFAULT_PORT,
};
