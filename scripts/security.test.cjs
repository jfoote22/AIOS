const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { localApiGuard, localAuthHeaders, bearerToken, tokensEqual, mobileProxyAllowed } = require('../electron/http-security.cjs');
const { noToolsPolicy, executionPolicy, agentEnvironment, assertAgentResult } = require('../electron/agent-policy.cjs');
const { generationInput, registerGeminiGeneration } = require('../electron/gemini-generation.cjs');
const { isPublicAddress, resolvePublicUrl, createPublicFetcher } = require('../electron/public-fetch.cjs');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}

test('loopback guard rejects unauthenticated requests before parsing JSON', async () => {
  const app = express();
  let touched = 0;
  app.use(localApiGuard(), express.json());
  app.all('/api/private', (_req, res) => { touched++; res.json({ ok: true }); });
  await withServer(app, async base => {
    for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
      const response = await fetch(`${base}/api/private`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{broken' });
      assert.equal(response.status, 401);
    }
    assert.equal(touched, 0);
    const ok = await fetch(`${base}/api/private`, { headers: localAuthHeaders() });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(touched, 1);
  });
});

test('loopback Host and Origin checks, preflight, and query credentials', async () => {
  const app = express();
  app.use(localApiGuard());
  app.get('/api/private', (_req, res) => res.json({ ok: true }));
  await withServer(app, async base => {
    for (const headers of [
      { Host: 'attacker.example' }, { Origin: 'https://attacker.example' },
      { Origin: 'http://localhost:3000' }, { Origin: 'file://' },
    ]) {
      const status = await new Promise((resolve, reject) => {
        const req = http.get(`${base}/api/private`, { headers: { ...localAuthHeaders(), ...headers } }, res => {
          res.resume(); resolve(res.statusCode);
        });
        req.on('error', reject);
      });
      assert.equal(status, 403, JSON.stringify(headers));
    }
    const preflight = await fetch(`${base}/api/private`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
    assert.equal((await fetch(`${base}/api/private?token=${localAuthHeaders().Authorization.slice(7)}`)).status, 401);
  });
});

test('bearer parser ignores query tokens and uses exact credentials', () => {
  assert.equal(bearerToken({ headers: {}, query: { token: 'secret' } }), '');
  assert.equal(bearerToken({ headers: { authorization: 'Bearer valid' } }), 'valid');
  assert.equal(tokensEqual('', ''), false);
  assert.equal(tokensEqual('valid', 'valid'), true);
  assert.equal(tokensEqual('valid ', 'valid'), false);
});

test('mobile proxy admits only explicit method/path pairs', () => {
  assert.equal(mobileProxyAllowed('POST', 'agents/draft'), true);
  assert.equal(mobileProxyAllowed('POST', 'research/find-links'), true);
  for (const path of ['agents/run', 'agents/write-md', 'deepgram', 'hermes/config', 'project/load', 'agents/draft/../run', '%61gents/draft', 'agents/draft/', 'research/deep/cancel']) {
    assert.equal(mobileProxyAllowed('POST', path), false, path);
  }
  assert.equal(mobileProxyAllowed('GET', 'agents/draft'), false);
});

test('chat and drafting have no tools, inherited settings, or MCP servers', async () => {
  const policy = noToolsPolicy();
  assert.deepEqual(policy.tools, []);
  assert.deepEqual(policy.settingSources, []);
  assert.deepEqual(policy.mcpServers, {});
  assert.equal(policy.permissionMode, 'dontAsk');
  assert.equal((await policy.canUseTool('Bash', {})).behavior, 'deny');
});

test('tool hooks deny by default, approve exactly once, and reject canceled runs', async () => {
  assert.throws(() => executionPolicy({ tools: ['*'] }), /Unsupported/);
  assert.throws(() => executionPolicy({ tools: ['Agent'] }), /Unsupported/);
  const controller = new AbortController();
  let approvals = 0;
  const policy = executionPolicy({ tools: ['Bash'], signal: controller.signal,
    approve: async request => { approvals++; return request.input.command === 'approved'; } });
  const hook = policy.hooks.PreToolUse[0].hooks[0];
  const decision = async (tool, command) => (await hook({ tool_name: tool, tool_input: { command } }, '', {})).hookSpecificOutput.permissionDecision;
  assert.equal(await decision('Bash', 'unapproved'), 'deny');
  assert.equal(await decision('Bash', 'approved'), 'allow');
  assert.equal(await decision('Write', 'approved'), 'deny');
  controller.abort();
  assert.equal(await decision('Bash', 'approved'), 'deny');
  assert.equal(approvals, 2);
  assert.equal((await policy.canUseTool()).behavior, 'deny');
  const unconfigured = executionPolicy({ tools: ['Bash'] });
  assert.equal((await unconfigured.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash' })).hookSpecificOutput.permissionDecision, 'deny');
});

test('concurrent agent credentials do not mutate process environment', () => {
  const before = { ...process.env };
  assert.equal(agentEnvironment('first').ANTHROPIC_API_KEY, 'first');
  assert.equal(agentEnvironment('second').ANTHROPIC_API_KEY, 'second');
  assert.equal(agentEnvironment().ANTHROPIC_API_KEY, undefined);
  assert.equal(agentEnvironment('first').CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual({ ...process.env }, before);
});

test('SDK failure results cannot be reported as successful runs', () => {
  assert.doesNotThrow(() => assertAgentResult({ subtype: 'success', is_error: false }));
  assert.throws(() => assertAgentResult({ subtype: 'error_max_turns', is_error: true }), /did not complete/);
  assert.throws(() => assertAgentResult({ subtype: 'error_during_execution' }), /did not complete/);
});

test('Gemini boundary strips arbitrary SDK options and rejects remote file references', () => {
  const input = generationInput({ model: 'untrusted', contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    config: { tools: [{ googleSearch: {} }], httpOptions: { baseUrl: 'http://attacker.example' }, responseMimeType: 'application/json' } });
  assert.equal(input.model, 'gemini-2.5-flash');
  assert.equal(input.config.tools, undefined);
  assert.equal(input.config.httpOptions, undefined);
  assert.throws(() => generationInput({ contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'http://localhost' } }] }] }), /inline/);
  assert.throws(() => generationInput({ contents: [] }), /messages/);
});

test('Gemini route validates before accessing credentials or calling a provider', async () => {
  const app = express();
  app.use(express.json());
  let accesses = 0;
  registerGeminiGeneration(app, { getProviderKey: () => { accesses++; return ''; } });
  await withServer(app, async base => {
    const send = body => fetch(`${base}/api/gemini/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({})).status, 400);
    assert.equal(accesses, 0);
    const missing = await send({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /not configured/);
    assert.equal(accesses, 1);
  });
});

test('research blocks private/reserved IPs including normalized and mapped IPv6', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '0.0.0.0', '100.64.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '168.63.129.16', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fd00::1',
    '2002:7f00:1::', '2001:db8::1', '64:ff9b::7f00:1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://2130706433', 'http://0x7f000001', 'http://[::ffff:7f00:1]', 'file:///test', 'https://user:password@example.com', 'http://example.com:8080']) {
    await assert.rejects(resolvePublicUrl(url));
  }
  await assert.rejects(resolvePublicUrl('https://example.com', async () => [
    { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
  ]), /reserved/);
});

test('redirect to metadata is rejected before sending a second request', async () => {
  let calls = 0;
  const fetchPage = createPublicFetcher({ lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async target => {
      calls++;
      assert.equal(target.address, '8.8.8.8');
      return { status: 302, headers: new Headers({ location: 'http://169.254.169.254/latest' }), body: Buffer.alloc(0) };
    } });
  await assert.rejects(fetchPage('https://example.com'), /reserved/);
  assert.equal(calls, 1);
});

test('research uses approved DNS answer and revalidates each redirect', async () => {
  let resolutions = 0;
  let connections = 0;
  const fetchPage = createPublicFetcher({
    lookup: async () => [{ address: ++resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }],
    request: async target => {
      connections++;
      assert.equal(target.address, '8.8.8.8');
      return { status: 307, headers: new Headers({ location: '/next' }), body: Buffer.alloc(0) };
    },
  });
  await assert.rejects(fetchPage('https://example.com'), /reserved/);
  assert.equal(resolutions, 2);
  assert.equal(connections, 1);
});

test('research deadline includes DNS resolution and bounds redirect loops', async () => {
  const stalled = createPublicFetcher({ lookup: () => new Promise(() => {}) });
  await assert.rejects(stalled('https://example.com', { timeoutMs: 10 }), /timed out/);
  let calls = 0;
  const loop = createPublicFetcher({ lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => { calls++; return { status: 301, headers: new Headers({ location: '/loop' }) }; } });
  await assert.rejects(loop('https://example.com'), /Too many/);
  assert.equal(calls, 6);
});
