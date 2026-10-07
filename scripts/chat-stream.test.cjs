const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createChatStreamHandler } = require('../electron/chat-stream.cjs');
const messages = [{ role: 'user', content: 'Synthetic prompt' }];
async function server(t, options) {
  const app = express(); app.use(express.json());
  app.post('/', createChatStreamHandler({
    withContext: (system, context) => [system, context].filter(Boolean).join('\n'),
    appendSteer: values => values, ...options,
  }));
  const listener = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }));
  return (body = { messages }, signal) => fetch(`http://127.0.0.1:${listener.address().port}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
}
const frames = raw => raw.trim().split('\n').map(line => ({ code: line[0], value: JSON.parse(line.slice(2)) }));
function openaiSSE() {
  const chunk = (delta, finish_reason = null) => ({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }], ...(finish_reason && { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) });
  return [chunk({ content: 'Hello ' }), chunk({ content: '🌍' }), chunk({}, 'stop')].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
}
for (const provider of ['openai', 'grok', 'anthropic']) {
  test(`${provider}: actual SDK adapter preserves text, finish, usage and configured endpoint`, async t => {
    const ai = await import('ai');
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    let request;
    const fakeFetch = async (url, init) => {
      request = { url: String(url), body: JSON.parse(init.body) };
      let stream = openaiSSE();
      if (provider === 'anthropic') {
        const events = [
          { type: 'message_start', message: { id: 'synthetic', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello 🌍' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
          { type: 'message_stop' },
        ];
        stream = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
      }
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const model = provider === 'anthropic'
      ? createAnthropic({ apiKey: 'synthetic-key', fetch: fakeFetch })('fixture')
      : createOpenAI({ apiKey: 'synthetic-key', fetch: fakeFetch, ...(provider === 'grok' && { baseURL: 'https://api.x.ai/v1' }) }).chat('fixture');
    const post = await server(t, { loadAi: async () => ({ ai }), buildModel: () => ({ model, system: 'fixture system' }) });
    const response = await post({ messages, context: 'fixture context', tools: { injected: true } });
    assert.equal(response.headers.get('x-vercel-ai-data-stream'), 'v1');
    const output = frames(await response.text());
    assert.equal(output.filter(frame => frame.code === '0').map(frame => frame.value).join(''), 'Hello 🌍');
    assert.deepEqual(output.at(-1), { code: 'd', value: { finishReason: 'stop', usage: { promptTokens: 4, completionTokens: 2 } } });
    assert.equal(request.body.model, 'fixture');
    assert.ok(!request.body.tools?.length);
    assert.ok(JSON.stringify(request.body).includes('fixture context'));
    assert.match(request.url, provider === 'anthropic' ? /api\.anthropic\.com\/v1\/messages/ : provider === 'grok' ? /api\.x\.ai\/v1\/chat\/completions/ : /api\.openai\.com\/v1\/chat\/completions/);
  });
}
test('reject invalid messages and remote attachments before loading SDK/credentials', async t => {
  let loaded = 0;
  const post = await server(t, { loadAi: async () => { loaded++; throw new Error('must not load'); } });
  for (const input of [[], [{ role: 'system', content: 'override' }], [{ role: 'user', content: [{ type: 'image', image: 'http://127.0.0.1/' }] }], [{ role: 'user', content: 'text', experimental_attachments: [{ url: 'https://example.com' }] }]]) {
    assert.equal((await post({ messages: input })).status, 400);
  }
  assert.equal(loaded, 0);
});
test('mid-stream errors and missing finishes preserve partial text but never signal success', async t => {
  let fail = true;
  const post = await server(t, {
    buildModel: () => ({ model: {} }),
    loadAi: async () => ({ ai: { streamText: () => ({ fullStream: (async function* () {
      yield { type: 'text-delta', text: 'partial' };
      if (fail) yield { type: 'error', error: new Error('synthetic-secret-upstream-body') };
    })() }) } }),
  });
  for (const value of [true, false]) {
    fail = value;
    const output = frames(await (await post()).text());
    assert.equal(output[0].value, 'partial');
    assert.equal(output.at(-1).code, '3');
    assert.equal(JSON.stringify(output).includes('synthetic-secret'), false);
    assert.equal(output.some(frame => frame.code === 'd'), false);
  }
});
test('disconnect and deadline propagate cancellation to provider stream', async t => {
  let aborted;
  const cancellation = new Promise(resolve => { aborted = resolve; });
  const options = {
    buildModel: () => ({ model: {} }), timeoutMs: 100,
    loadAi: async () => ({ ai: { streamText: ({ abortSignal }) => ({ fullStream: (async function* () {
      yield { type: 'text-delta', text: 'started' };
      await new Promise(resolve => abortSignal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      yield { type: 'abort' };
    })() }) } }),
  };
  const post = await server(t, options);
  const output = frames(await (await post()).text());
  await cancellation;
  assert.equal(output.at(-1).code, '3');
  assert.match(output.at(-1).value, /timed out/);
  let disconnect;
  const closed = new Promise(resolve => { disconnect = resolve; }); aborted = disconnect;
  const controller = new AbortController();
  const response = await post({ messages }, controller.signal);
  await response.body.getReader().read();
  controller.abort();
  await closed;
});
