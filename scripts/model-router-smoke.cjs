// Real Electron test for model routing (electron/model-router.cjs). A local
// fake OpenAI-compatible server stands in for Ollama/OpenRouter; no accounts,
// keys or network. Isolated temporary profile.
const { app } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-router-smoke-')));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
const timeout = setTimeout(() => { console.error('Model router smoke timed out.'); app.exit(1); }, 60000);

// Fake server: /v1/models, streaming /v1/chat/completions, /v1/embeddings.
// A model named "broken" fails; requests are recorded for assertions.
const seen = [];
let signedIn = false;
function fakeServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const json = body ? JSON.parse(body) : {};
        seen.push({ url: req.url, auth: req.headers.authorization, body: json });
        if (req.url === '/v1/models') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
        }
        if (req.url === '/v1/embeddings') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ data: json.input.map((_, i) => ({ index: i, embedding: [i, 1, 2] })) }));
        }
        if (req.url === '/v1/chat/completions') {
          if (json.model === 'broken') { res.statusCode = 500; return res.end('{"error":{"message":"model exploded"}}'); }
          if (json.model === 'needs-login' && !signedIn) { res.statusCode = 401; return res.end('{"error":{"message":"Not signed in"}}'); }
          const user = json.messages.find((m) => m.role === 'user');
          const hasImage = Array.isArray(user.content) && user.content.some((p) => p.type === 'image_url');
          const system = json.messages.find((m) => m.role === 'system')?.content || '';
          const reply = system.includes('JSON') ? '```json\n{"picks":[2,1]}\n```' : `hello from ${json.model}${hasImage ? ' with image' : ''}`;
          res.setHeader('Content-Type', 'text/event-stream');
          const chunk = (delta, finish = null) => `data: ${JSON.stringify({
            id: 'x', object: 'chat.completion.chunk', created: 0, model: json.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
          res.write(chunk({ role: 'assistant', content: reply.slice(0, 5) }));
          res.write(chunk({ content: reply.slice(5) }));
          res.write(chunk({}, 'stop'));
          return res.end('data: [DONE]\n\n');
        }
        res.statusCode = 404;
        res.end('{}');
      });
    }).listen(0, '127.0.0.1', () => resolve(server));
  });
}

app.whenReady().then(async () => {
  const store = require('../electron/sqlite-store.cjs');
  store.init(path.join(profile, 'test.db'));
  // Keep built-in connections out of the way: no keys, and Gemini on API
  // auth (its subscription CLI may be installed on the test machine).
  store.call('setMeta', ['gemini-auth-mode', 'api']);
  const routing = require('../electron/model-routing.cjs');
  const router = require('../electron/model-router.cjs');
  const { setProviderKey } = require('../electron/keystore.cjs');

  const server = await fakeServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  // Nothing connected: a clear, actionable error.
  await assert.rejects(router.generate({ task: 'tagging', prompt: 'hi' }), /needs a model\. Connect one in Settings → Models/);
  assert.equal(router.hasModelFor('tagging'), false);

  // Connection validation.
  assert.throws(() => routing.upsertConnection({ id: 'claude', baseUrl }), /built-in/);
  assert.throws(() => routing.upsertConnection({ id: 'x', baseUrl: 'file:///etc' }), /http/);

  // Detect models from /v1/models.
  assert.deepEqual(await router.detectModels({ baseUrl }), ['model-a', 'model-b']);

  routing.upsertConnection({ id: 'fake', label: 'Fake', baseUrl, models: ['model-a', 'broken'], vision: false });
  setProviderKey('conn:fake', 'sk-test');

  // One connection → every task uses it automatically, streamed.
  const deltas = [];
  const r1 = await router.generate({ task: 'vault-ask', system: 'be nice', prompt: 'hi', onDelta: (t) => deltas.push(t) });
  assert.equal(r1.text, 'hello from model-a');
  assert.equal(r1.model, 'fake:model-a');
  assert.ok(deltas.length >= 2, 'streamed in pieces');
  const chat = seen.filter((s) => s.url === '/v1/chat/completions').at(-1);
  assert.equal(chat.auth, 'Bearer sk-test');
  assert.equal(chat.body.messages[0].role, 'system');

  // JSON mode: hint added, fenced reply parsed.
  const r2 = await router.generate({ task: 'vault-ask', prompt: 'pick', json: true });
  assert.deepEqual(router.parseJsonReply(r2.text), { picks: [2, 1] });

  // A task routed to a failing model falls back to the default...
  routing.update({ default: 'fake:model-a', tasks: { tagging: 'fake:broken' } });
  const r3 = await router.generate({ task: 'tagging', prompt: 'hi' });
  assert.equal(r3.model, 'fake:model-a');
  // ...and with fallback off, the error names the model and the cause.
  routing.update({ default: 'fake:broken', fallback: false, tasks: { tagging: '' } });
  await assert.rejects(router.generate({ task: 'tagging', prompt: 'hi' }), /Fake \(broken\)/);
  routing.update({ default: 'fake:model-a', fallback: true });

  // Images need a vision-capable connection.
  const image = { mimeType: 'image/png', data: Buffer.from('png').toString('base64') };
  await assert.rejects(router.generate({ task: 'ocr', prompt: 'read', image }), /can read images/);
  routing.upsertConnection({ id: 'fake', label: 'Fake', baseUrl, models: ['model-a', 'broken'], vision: true });
  const r4 = await router.generate({ task: 'ocr', prompt: 'read', image });
  assert.equal(r4.text, 'hello from model-a with image');

  // Embeddings through the connection, in input order.
  routing.update({ embeddings: 'fake:model-a' });
  assert.deepEqual(await router.embed(['a', 'b']), [[0, 1, 2], [1, 1, 2]]);
  routing.update({ embeddings: 'local' });
  await assert.rejects(router.embed(['a']), /app window/);

  // Test button path.
  assert.equal(await router.testModel('fake:model-a'), 'hello from model-a');

  // Hermes bridge: MCP over the gateway, its own token, delegation by role.
  const gateway = require('../electron/mobile-gateway.cjs');
  const bridge = require('../electron/hermes-bridge.cjs');
  const token = bridge.ensureToken();
  routing.update({ tasks: { coding: 'fake:model-a' } });
  const gw = await new Promise((resolve) => { const l = gateway.buildApp().listen(0, '127.0.0.1', () => resolve(l)); });
  const mcp = `http://127.0.0.1:${gw.address().port}/mcp`;
  const rpc = (body, headers = {}) => fetch(mcp, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: 'Bearer wrong' })).status, 401);
  const gatewayToken = gateway.ensureToken();
  assert.notEqual(gatewayToken, token);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${gatewayToken}` })).status, 401, 'phone token is not a bridge token');
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes', version: '0' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /chief of staff/);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const tools = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['delegate', 'ask_model', 'list_models']);
  // tools/call streams back as SSE.
  const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delegate', arguments: { role: 'coding', task: 'write hello world' } } });
  assert.match(call.headers.get('content-type'), /text\/event-stream/);
  const sse = await call.text();
  const reply = JSON.parse(sse.split('\n').find((l) => l.startsWith('data: ')).slice(6));
  assert.equal(reply.id, 3);
  assert.match(reply.result.content[0].text, /hello from model-a[\s\S]*Fake \(model-a\) \(coding\)/);
  const codingCall = seen.filter((s) => s.url === '/v1/chat/completions').at(-1);
  assert.match(codingCall.body.messages[0].content, /coding specialist/);
  // Bad input comes back as a tool error Hermes can read, not a crash.
  const bad = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delegate', arguments: { role: 'cooking', task: 'x' } } }, { Accept: 'application/json' })).json();
  assert.equal(bad.result.isError, true);
  const listed = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_models', arguments: {} } }, { Accept: 'application/json' })).json();
  assert.match(listed.result.content[0].text, /coding: Fake \(model-a\)/);
  const asked = await (await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ask_model', arguments: { model: 'fake:model-a', task: 'hi' } } }, { Accept: 'application/json' })).json();
  assert.match(asked.result.content[0].text, /hello from model-a/);
  assert.equal((await fetch(mcp, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
  await new Promise((r) => { gw.close(r); gw.closeAllConnections(); });

  // Signed-out subscription CLI: sign-in opens, then the request retries
  // (last candidate) or moves on to the next model (more to try).
  const cliLogin = require('../electron/cli-login.cjs');
  let logins = 0;
  Object.assign(cliLogin, {
    hasFlow: (id) => id === 'grok',
    isSignedOut: async (_id, e) => /not signed in/i.test(String(e?.message || e)),
    ensureLogin: async () => { logins++; signedIn = true; return true; },
  });
  const grokLike = { ref: 'grok:needs-login', model: 'needs-login', label: 'Grok',
    conn: { id: 'grok', label: 'Grok', kind: 'compat', auth: 'subscription', baseUrl, keyId: 'none' } };
  assert.equal(await router.runCandidate(grokLike, { prompt: 'hi' }), 'hello from needs-login');
  assert.equal(logins, 1);
  signedIn = false;
  await assert.rejects(router.runCandidate(grokLike, { prompt: 'hi' }, { moreToTry: true }), /opened sign-in in your browser/);
  assert.equal(logins, 2);
  // Not a sign-in problem → plain failure, no sign-in.
  await assert.rejects(router.runCandidate({ ...grokLike, model: 'broken' }, { prompt: 'hi' }));
  assert.equal(logins, 2);

  // Removing a connection clears routing that pointed at it.
  routing.update({ tasks: { research: 'fake:model-a' }, embeddings: 'fake:model-a' });
  const after = routing.removeConnection('fake');
  assert.equal(after.default, '');
  assert.equal(after.tasks.research, undefined);
  assert.equal(after.embeddings, 'local');
  assert.equal(router.hasModelFor('tagging'), false);

  console.log('MODEL_ROUTER_SMOKE_PASSED');
  clearTimeout(timeout);
  server.close();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
