import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatSession, ChatSessions, readChatStream } from '../src/lib/chatSession.ts';
const finish = 'd:{"finishReason":"stop","usage":{"promptTokens":1,"completionTokens":1}}\n';
const wire = (text: string) => `0:${JSON.stringify(text)}\n${finish}`;
const response = (raw: string) => new Response(raw, { headers: { 'x-vercel-ai-data-stream': 'v1' } });
test('stream parser handles every UTF-8 byte boundary, escaped text and multiple frames', async () => {
  const bytes = new TextEncoder().encode(wire('🌍 café\n"quoted"'));
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  let text = '';
  await readChatStream(new Response(body, { headers: { 'x-vercel-ai-data-stream': 'v1' } }), delta => { text += delta; }, new AbortController().signal);
  assert.equal(text, '🌍 café\n"quoted"');
});
test('malformed, truncated, failed, oversized and unrecognized streams fail closed', async () => {
  for (const raw of ['0:"partial"\n', '0:"unfinished', '0:not-json\n', '9:{}\n', '3:"provider failure"\n', 'd:{"finishReason":"error"}\n', wire('done') + '0:"late"\n', '0:"' + 'a'.repeat(256 * 1024)]) {
    await assert.rejects(readChatStream(response(raw), () => {}, new AbortController().signal));
  }
  await assert.rejects(readChatStream(new Response('not a protocol'), () => {}, new AbortController().signal), /Unsupported/);
  await assert.rejects(readChatStream(new Response('{"error":"Missing fixture key"}', { status: 400 }), () => {}, new AbortController().signal), /Missing fixture key/);
});
test('sessions keep history and latest request options without crossing threads', async () => {
  const requests: any[] = [];
  const fetcher: typeof fetch = async (url, init) => { requests.push({ url, body: JSON.parse(String(init?.body)) }); return response(wire('answer')); };
  const one = new ChatSession([], fetcher), two = new ChatSession([], fetcher);
  await one.append({ role: 'user', content: 'first' }, { api: '/first', body: { mode: 'fun' } });
  await one.append({ role: 'user', content: 'second' }, { api: '/second', body: { mode: 'precise', context: 'research' } });
  await two.append({ role: 'user', content: 'separate' }, { api: '/third' });
  assert.equal(requests[1].url, '/second');
  assert.equal(requests[1].body.mode, 'precise');
  assert.equal(requests[1].body.messages.length, 3);
  assert.equal(requests[2].body.messages.length, 1);
  assert.equal(one.getSnapshot().messages.length, 4);
  assert.equal(one.getSnapshot().isLoading, false);
});
test('partial text is retained on error and errors clear on retry', async () => {
  let fail = true;
  const session = new ChatSession([], async () => response(fail ? '0:"partial"\n3:"fixture failure"\n' : wire('recovered')));
  await session.append({ role: 'user', content: 'first' }, { api: '/chat' });
  assert.equal(session.getSnapshot().messages.at(-1)?.content, 'partial');
  assert.match(session.getSnapshot().error!.message, /fixture failure/);
  fail = false;
  await session.append({ role: 'user', content: 'retry' }, { api: '/chat' });
  assert.equal(session.getSnapshot().error, undefined);
  assert.equal(session.getSnapshot().messages.at(-1)?.content, 'recovered');
});
test('stop/reset prevent late completion from resurrecting cleared messages', async () => {
  let deliver!: (response: Response) => void;
  let signal: AbortSignal | undefined | null;
  const session = new ChatSession([], async (_url, init) => { signal = init?.signal; return new Promise(resolve => { deliver = resolve; }); });
  const pending = session.append({ role: 'user', content: 'first' }, { api: '/chat' });
  await session.append({ role: 'user', content: 'duplicate' }, { api: '/chat' });
  assert.equal(session.getSnapshot().messages.length, 1);
  session.setMessages([]);
  assert.equal(signal?.aborted, true);
  deliver(response(wire('too late'))); await pending;
  assert.deepEqual(session.getSnapshot().messages, []);
  assert.equal(session.getSnapshot().error, undefined);
  assert.equal(session.getSnapshot().isLoading, false);
});
test('owner-scoped registry survives panel remounts, preserves main restore handle, and disposes threads', () => {
  const registry = new ChatSessions();
  const initial = [{ id: 'saved', role: 'assistant' as const, content: 'saved response' }];
  const panel = registry.get('thread-1', initial);
  assert.equal(registry.get('thread-1'), panel);
  assert.equal(new ChatSessions().get('thread-1').getSnapshot().messages.length, 0);
  const main = registry.get('main', initial);
  registry.clear();
  assert.equal(registry.get('main'), main);
  main.setMessages(initial);
  assert.equal(registry.get('main').getSnapshot().messages[0].content, 'saved response');
  assert.notEqual(registry.get('thread-1'), panel);
  registry.remove('thread-1');
  assert.equal(registry.get('thread-1').getSnapshot().messages.length, 0);
});
