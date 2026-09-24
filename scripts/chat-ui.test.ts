// H02 — real React interaction tests for the chat hook.
//
// The existing chat-session tests exercise the store directly. These mount the
// hook through ChatSessionProvider in a real DOM with react-dom/client, which is
// the only way to prove the parts that depend on React itself: that a streaming
// thread survives the panel unmount/remount a layout or fullscreen change
// causes, that useSyncExternalStore actually re-renders on stream deltas, and
// that the submit guard blocks a double send.
//
// No JSX (Node's type stripping does not transform it) and no new dependencies —
// jsdom, react and react-dom are already in the tree. Transports are synthetic;
// nothing contacts a provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as any;
// Node 22 defines `navigator` as a getter-only global, so plain assignment
// throws — define these rather than assigning.
for (const [name, value] of [
  ['window', dom.window],
  ['document', dom.window.document],
  ['navigator', dom.window.navigator],
  ['HTMLElement', dom.window.HTMLElement],
  ['Element', dom.window.Element],
  ['Node', dom.window.Node],
] as const) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement, useState, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ChatSessionProvider, useChat, useChatSessions } = await import('../src/lib/useChat.ts');

const FINISH = 'd:{"finishReason":"stop","usage":{"promptTokens":1,"completionTokens":1}}\n';
const HEADERS = { 'x-vercel-ai-data-stream': 'v1' };

/** A response whose body is pushed by the test, so streams can be held open. */
function controllable() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    response: new Response(body, { headers: HEADERS }),
    push: (text: string) => controller!.enqueue(encoder.encode(`0:${JSON.stringify(text)}\n`)),
    finish: () => { controller!.enqueue(encoder.encode(FINISH)); controller!.close(); },
  };
}

/** Install a fetch that hands each call the next queued controllable response. */
function installFetch() {
  const pending: ReturnType<typeof controllable>[] = [];
  const calls: { api: string; body: any }[] = [];
  g.fetch = async (api: string, init: any) => {
    calls.push({ api, body: JSON.parse(init.body) });
    const next = controllable();
    pending.push(next);
    // End the body on abort, as a real transport does once the reader cancels.
    if (init.signal) init.signal.addEventListener('abort', () => next.finish());
    return next.response;
  };
  return { pending, calls };
}

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

function mount(element: any) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root, text: () => container.textContent || '' };
}

/** A thread panel: renders its own messages and exposes its hook to the test. */
function Panel({ id, sink }: { id: string; sink: (api: any) => void }) {
  const chat = useChat({ id, api: `/api/${id}/chat`, body: { provider: id } });
  sink(chat);
  return createElement(
    'div',
    { 'data-thread': id },
    ...chat.messages.map((m: any) => createElement('p', { key: m.id }, `${m.role}:${m.content}`)),
    createElement('span', { 'data-loading': String(chat.isLoading) }),
  );
}

test('a streaming thread survives a panel remount, as a layout change causes', async () => {
  const { pending } = installFetch();
  let chat: any;
  // A wrapper that can unmount just the panel while the provider stays mounted —
  // exactly what a fullscreen/layout toggle does to a nested thread.
  let setShown: (v: boolean) => void = () => {};
  function Wrapper() {
    const [shown, set] = useState(true);
    setShown = set;
    return createElement(
      ChatSessionProvider,
      null,
      shown ? createElement(Panel, { id: 'thread-a', sink: (c: any) => { chat = c; } }) : null,
    );
  }
  const view = mount(createElement(Wrapper, null));

  await act(async () => { chat.append({ role: 'user', content: 'hello' }); });
  await flush();
  act(() => { pending[0].push('parti'); });
  await flush();
  assert.match(view.text(), /assistant:parti/, 'delta should render before the remount');

  // Unmount the panel mid-stream, push more, then bring it back.
  await act(async () => { setShown(false); });
  await flush();
  act(() => { pending[0].push('al text'); pending[0].finish(); });
  await flush();
  await act(async () => { setShown(true); });
  await flush();

  assert.match(view.text(), /user:hello/, 'restored panel must still show the prompt');
  assert.match(
    view.text(), /assistant:partial text/,
    'text streamed while unmounted must not be lost — the session outlives the component',
  );
  assert.equal(chat.isLoading, false, 'the finished stream must settle');
});

test('two threads stream at once without leaking into each other', async () => {
  const { pending, calls } = installFetch();
  const chats: Record<string, any> = {};
  const view = mount(createElement(
    ChatSessionProvider,
    null,
    createElement(Panel, { id: 'left', sink: (c: any) => { chats.left = c; } }),
    createElement(Panel, { id: 'right', sink: (c: any) => { chats.right = c; } }),
  ));

  await act(async () => { chats.left.append({ role: 'user', content: 'LQ' }); });
  await act(async () => { chats.right.append({ role: 'user', content: 'RQ' }); });
  await flush();

  // Interleave the two streams; each must land only in its own panel.
  act(() => { pending[0].push('LEFT-'); pending[1].push('RIGHT-'); });
  await flush();
  act(() => { pending[1].push('two'); pending[0].push('one'); });
  await flush();
  act(() => { pending[0].finish(); pending[1].finish(); });
  await flush();

  assert.deepEqual(
    chats.left.messages.map((m: any) => `${m.role}:${m.content}`),
    ['user:LQ', 'assistant:LEFT-one'],
  );
  assert.deepEqual(
    chats.right.messages.map((m: any) => `${m.role}:${m.content}`),
    ['user:RQ', 'assistant:RIGHT-two'],
  );
  assert.equal(view.text().includes('LEFT-two'), false, 'no cross-thread contamination');
  assert.equal(view.text().includes('RIGHT-one'), false, 'no cross-thread contamination');

  // Each thread must address its own endpoint and carry its own provider body.
  assert.deepEqual(calls.map(c => c.api), ['/api/left/chat', '/api/right/chat']);
  assert.deepEqual(calls.map(c => c.body.provider), ['left', 'right']);
});

test('the submit guard blocks a double send while a request is in flight', async () => {
  const { pending, calls } = installFetch();
  let chat: any;
  mount(createElement(
    ChatSessionProvider, null,
    createElement(Panel, { id: 'guard', sink: (c: any) => { chat = c; } }),
  ));

  await act(async () => { chat.setInput('only once'); });
  // Two submits back to back — an impatient double-click, or Enter twice.
  await act(async () => { chat.handleSubmit(); chat.handleSubmit(); });
  await flush();
  assert.equal(calls.length, 1, 'a second submit while loading must not send again');

  // A further submit is still refused until the stream settles.
  await act(async () => { chat.setInput('during'); chat.handleSubmit(); });
  await flush();
  assert.equal(calls.length, 1, 'input during a stream must not start a second request');

  act(() => { pending[0].push('done'); pending[0].finish(); });
  await flush();
  assert.equal(chat.isLoading, false);

  // Once settled, sending works again.
  await act(async () => { chat.setInput('after'); chat.handleSubmit(); });
  await flush();
  assert.equal(calls.length, 2, 'sending must resume after the stream settles');
  assert.equal(chat.input, '', 'the box clears on send');
});

test('stopping mid-stream leaves the partial answer on screen and clears loading', async () => {
  // readChatStream cancels the reader on abort, so the transport genuinely
  // cannot deliver more through that stream — the store test covers the
  // stale-response guard. What only React can show is that stopping is
  // reflected in what the user sees: the partial answer stays, the spinner goes.
  const { pending } = installFetch();
  let chat: any;
  const view = mount(createElement(
    ChatSessionProvider, null,
    createElement(Panel, { id: 'stopper', sink: (c: any) => { chat = c; } }),
  ));

  await act(async () => { chat.append({ role: 'user', content: 'q' }); });
  await flush();
  act(() => { pending[0].push('half an ans'); });
  await flush();
  assert.equal(chat.isLoading, true, 'still streaming before stop');
  assert.match(view.text(), /assistant:half an ans/);

  await act(async () => { chat.stop(); });
  await flush();

  assert.equal(chat.isLoading, false, 'stop must clear loading in the rendered snapshot');
  assert.match(view.text(), /user:q/, 'the prompt stays');
  assert.match(view.text(), /assistant:half an ans/, 'the partial answer is not discarded');
  const assistant = chat.messages.find((m: any) => m.role === 'assistant');
  assert.equal(assistant.content, 'half an ans');

  // The thread is usable again immediately after stopping.
  await act(async () => { chat.setInput('next'); chat.handleSubmit(); });
  await flush();
  assert.equal(chat.isLoading, true, 'a new send works right after a stop');
});

test('an unmounted thread keeps its messages, so saving a collapsed row is not lossy', async () => {
  // The save path used to read messages through a ref that ThreadPanel deletes
  // on unmount, falling back to `threads[].messages` — which nothing ever
  // populates. Collapsing a row or putting another thread fullscreen unmounts
  // panels, so any thread not visibly on screen was saved EMPTY and came back
  // needing to be re-run. Saving now reads the session registry, which outlives
  // the component.
  const { pending } = installFetch();
  const chats: Record<string, any> = {};
  let sessions: any;
  let showSecond: (v: boolean) => void = () => {};

  function Harness() {
    const [shown, set] = useState(true);
    showSecond = set;
    return createElement(
      ChatSessionProvider,
      null,
      createElement(Probe, null),
      createElement(Panel, { id: 'kept', sink: (c: any) => { chats.kept = c; } }),
      shown ? createElement(Panel, { id: 'hidden', sink: (c: any) => { chats.hidden = c; } }) : null,
    );
  }
  // Reaches the same registry ThreadedChat reads when saving.
  function Probe() {
    sessions = useChatSessions();
    return null;
  }

  mount(createElement(Harness, null));

  await act(async () => { chats.kept.append({ role: 'user', content: 'Q1' }); });
  await act(async () => { chats.hidden.append({ role: 'user', content: 'Q2' }); });
  await flush();
  act(() => { pending[0].push('first answer'); pending[1].push('second answer'); });
  await flush();
  act(() => { pending[0].finish(); pending[1].finish(); });
  await flush();

  // Collapse the row / go fullscreen elsewhere: the second panel unmounts.
  await act(async () => { showSecond(false); });
  await flush();

  const kept = sessions.peek('kept')?.getSnapshot().messages ?? [];
  const hidden = sessions.peek('hidden')?.getSnapshot().messages ?? [];
  assert.deepEqual(kept.map((m: any) => m.content), ['Q1', 'first answer']);
  assert.deepEqual(
    hidden.map((m: any) => m.content), ['Q2', 'second answer'],
    'an unmounted thread must still yield its messages, or saving loses it',
  );

  // peek must not fabricate a session for a thread that was never opened —
  // an empty snapshot would overwrite messages restored from disk.
  assert.equal(sessions.peek('never-opened'), undefined);
});
