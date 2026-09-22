// H03 — memory-ingest regression under real Electron.
//
// Covers the failure that silently stopped external notes arriving: the
// listener binds one fixed port once at startup, and when something already
// held it the error went to a console no packaged build shows. AIOS looked
// healthy while refusing every delivery.
//
// Uses an isolated temporary profile, synthetic snippets, and a port chosen at
// runtime — never 8765 — so it cannot disturb a running AIOS or touch the
// owner's database. No cloud requests, no paid provider use.
const { app } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-ingest-smoke-')));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
const timeout = setTimeout(() => { console.error('Ingest smoke timed out.'); app.exit(1); }, 90000);

/** Reserve a free port by binding :0, then releasing it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function occupy(port) {
  return new Promise((resolve, reject) => {
    const squatter = http.createServer((_req, res) => res.end('squatter'));
    squatter.once('error', reject);
    squatter.listen(port, '0.0.0.0', () => resolve(squatter));
  });
}

const close = (server) => new Promise((resolve) => {
  server.close(resolve);
  if (server.closeAllConnections) server.closeAllConnections();
});

app.whenReady().then(async () => {
  const store = require('../electron/sqlite-store.cjs');
  store.init(path.join(profile, 'test.db'));

  const keystore = require('../electron/keystore.cjs');
  const ingest = require('../electron/memory-ingest.cjs');

  // Never the real 8765 — a developer's AIOS is usually holding it.
  const port = await freePort();
  keystore.setProviderKey('memory_ingest_port', String(port));
  assert.equal(ingest.configuredPort(), port, 'configured port must be honored');
  assert.notEqual(port, ingest.DEFAULT_PORT, 'test must not use the production port');

  const token = ingest.ensureToken();
  assert.ok(token && token.length >= 32, 'a token must be generated on first use');

  // ── 1. a held port is reported, not swallowed ─────────────────────────────
  const squatter = await occupy(port);
  let bindError = null;
  const startedAt = Date.now();
  await ingest.start({ getWebContents: () => null }).catch((e) => { bindError = e; });
  const elapsed = Date.now() - startedAt;

  assert.ok(bindError, 'start() must reject when the port is held');
  assert.equal(bindError.code, 'EADDRINUSE');
  assert.ok(elapsed >= 1500, `must retry before giving up (gave up in ${elapsed}ms)`);

  const failed = ingest.status();
  assert.equal(failed.running, false);
  assert.ok(failed.lastError, 'a bind failure must be visible via status().lastError');
  assert.match(failed.lastError, new RegExp(String(port)), 'the message must name the port');
  assert.match(failed.lastError, /already in use/i);

  // ── 2. freeing the port lets it recover ───────────────────────────────────
  await close(squatter);
  const started = await ingest.start({ getWebContents: () => null });
  assert.equal(started.port, port);
  const live = ingest.status();
  assert.equal(live.running, true, 'must bind once the port is free');
  assert.equal(live.lastError, null, 'a successful bind must clear the previous error');

  const base = `http://127.0.0.1:${port}/api/memory/ingest`;
  // Connection: close keeps the client from pooling a socket across the
  // stop()/start() boundary in step 8 — a pooled socket would be destroyed by
  // the restart and surface as a client-side ECONNRESET, masking the result.
  const post = (body, headers) => fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  // ── 3. the documented auth contract — Authorization ONLY ──────────────────
  // docs/MEMORY-INGEST.md promises no X-token fallback. A client sending the
  // token anywhere else must be rejected, not quietly accepted.
  for (const headers of [
    {},
    { Authorization: 'Bearer wrong-token' },
    { Authorization: 'wrong-scheme ' + token },
    { 'X-Token': token },
    { 'X-Auth-Token': token },
  ]) {
    const res = await post({ content: '# Nope' }, headers);
    assert.equal(res.status, 401, `must reject ${JSON.stringify(headers)}`);
  }

  const auth = { Authorization: `Bearer ${token}` };

  // ── 4. malformed payloads are rejected, not stored ────────────────────────
  for (const body of [{}, { content: '' }, { content: '   \n\t ' }]) {
    assert.equal((await post(body, auth)).status, 400, 'empty content must be rejected');
  }
  assert.equal(store.call('getAllSnippets').length, 0, 'no rejected request may be stored');

  // ── 5. an accepted note lands pending, shaped for the renderer ────────────
  const accepted = await post({ content: '# Synthetic Note\n\nBody.', jobName: 'h03' }, auth);
  assert.equal(accepted.status, 200);
  const { ok, id } = await accepted.json();
  assert.equal(ok, true);

  const stored = store.call('getAllSnippets').find((s) => s.id === id);
  assert.ok(stored, 'the note must be persisted');
  assert.equal(stored.status, 'analyzing', 'must await renderer enrichment');
  assert.equal(stored.memoryPending, true, 'must be pending or no sweep collects it');
  assert.equal(stored.memorySource, 'hermes');
  assert.equal(stored.title, 'Synthetic Note', 'title falls back to the first H1');
  assert.equal(stored.memoryJobName, 'h03');
  assert.equal(stored.extractedText, '# Synthetic Note\n\nBody.');
  assert.equal(stored.memoryRetryCount, undefined, 'a fresh note carries no retry state');

  // ── 6. a raw markdown body is accepted too ────────────────────────────────
  const raw = await fetch(base, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'text/markdown' },
    body: '# Raw Body\n\nDelivered as text/markdown.',
  });
  assert.equal(raw.status, 200);
  assert.equal(store.call('getAllSnippets').length, 2);

  // ── 7. deliveries never collide ───────────────────────────────────────────
  // Ids are minted per request, so a client that retries after a timeout
  // creates a second note rather than overwriting the first. Pin the behavior
  // so a future change to id minting cannot silently start clobbering.
  const a = await (await post({ content: '# Same' }, auth)).json();
  const b = await (await post({ content: '# Same' }, auth)).json();
  assert.notEqual(a.id, b.id, 'identical payloads must not share an id');
  assert.equal(store.call('getAllSnippets').length, 4);

  // ── 8. restart recovery — the quit/relaunch path ──────────────────────────
  ingest.stop();
  assert.equal(ingest.status().running, false);
  await ingest.start({ getWebContents: () => null });
  assert.equal(ingest.status().running, true, 'must rebind after a stop');
  assert.equal((await post({ content: '# After restart' }, auth)).status, 200);
  assert.equal(store.call('getAllSnippets').length, 5);

  // ── 9. token rotation invalidates the old token ───────────────────────────
  const rotated = ingest.regenerateToken();
  assert.notEqual(rotated, token);
  assert.equal((await post({ content: '# Stale' }, auth)).status, 401, 'old token must stop working');
  assert.equal(
    (await post({ content: '# Fresh' }, { Authorization: `Bearer ${rotated}` })).status, 200,
  );

  ingest.stop();
  clearTimeout(timeout);
  console.log(
    'PASS: ingest bind retry + visible lastError, recovery after release, ' +
    'Authorization-only auth contract, payload rejection, pending-note shape, ' +
    'raw markdown, distinct ids per delivery, restart rebind, and token rotation.',
  );
  console.log(`Isolated test profile retained at ${profile}`);
  app.exit(0);
}).catch((error) => { console.error(error); clearTimeout(timeout); app.exit(1); });
