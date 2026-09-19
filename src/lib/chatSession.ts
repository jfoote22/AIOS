export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string }
export interface ChatOptions { api: string; body?: Record<string, unknown>; onError?: (error: Error) => void }
export interface ChatSnapshot { messages: ChatMessage[]; input: string; isLoading: boolean; error?: Error }

// AIOS's deliberately small compatibility protocol: text, error, finish only.
// No SDK object patching, tool execution, or remote attachment downloads.
export async function readChatStream(response: Response, onText: (text: string) => void, signal: AbortSignal): Promise<void> {
  if (!response.ok) {
    // Bound even non-streaming error bodies; don't buffer an arbitrary response.
    const reader = response.body?.getReader();
    let raw = '';
    try {
      while (reader && raw.length < 8192) {
        const chunk = await reader.read();
        if (chunk.done) break;
        raw += new TextDecoder().decode(chunk.value).slice(0, 8192 - raw.length);
      }
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    let message = `Chat request failed (${response.status}).`;
    try { const parsed = JSON.parse(raw); if (typeof parsed.error === 'string') message = parsed.error.slice(0, 500); } catch { /* status fallback */ }
    throw new Error(message);
  }
  if (!response.body || response.headers.get('x-vercel-ai-data-stream') !== 'v1') throw new Error('Unsupported chat response. Update the desktop and client together.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', finished = false, total = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.length > 256 * 1024 || line[1] !== ':' || finished) throw new Error('Invalid chat stream frame.');
        let payload: unknown;
        try { payload = JSON.parse(line.slice(2)); } catch { throw new Error('Malformed chat stream.'); }
        if (line[0] === '0' && typeof payload === 'string') {
          total += payload.length;
          if (total > 2 * 1024 * 1024) throw new Error('Chat response exceeds the display limit.');
          onText(payload);
        } else if (line[0] === '3' && typeof payload === 'string') throw new Error(payload.slice(0, 500));
        else if (line[0] === 'd' && payload && typeof payload === 'object' && 'finishReason' in payload) {
          if (!['stop', 'length'].includes(String(payload.finishReason))) throw new Error('Chat did not finish successfully.');
          finished = true;
        } else throw new Error('Unsupported chat stream frame.');
      }
      if (buffer.length > 256 * 1024) throw new Error('Chat frame exceeds the size limit.');
      if (done) break;
    }
    if (buffer || !finished) throw new Error('Chat stream ended unexpectedly. Partial text has been kept.');
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ChatSession {
  private snapshot: ChatSnapshot;
  private listeners = new Set<() => void>();
  private request?: AbortController;
  private fetcher: typeof fetch;
  constructor(messages: ChatMessage[] = [], fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.fetcher = fetcher;
    this.snapshot = { messages, input: '', isLoading: false };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(patch: Partial<ChatSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  setInput = (input: string) => this.update({ input });
  stop = () => {
    const request = this.request;
    this.request = undefined;
    request?.abort();
    if (this.snapshot.isLoading) this.update({ isLoading: false });
  };
  setMessages = (messages: ChatMessage[]) => { this.stop(); this.update({ messages, error: undefined }); };
  async append(message: { role: 'user'; content: string; id?: string }, options: ChatOptions): Promise<void> {
    if (this.request || !message.content.trim()) return;
    const request = new AbortController(); this.request = request;
    const messages = [...this.snapshot.messages, { ...message, id: message.id || crypto.randomUUID() }];
    const assistant: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '' };
    this.update({ messages, isLoading: true, error: undefined });
    try {
      const response = await this.fetcher(options.api, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: request.signal,
        body: JSON.stringify({ ...options.body, messages }),
      });
      await readChatStream(response, text => {
        if (this.request !== request) return;
        assistant.content += text;
        this.update({ messages: [...messages, { ...assistant }] });
      }, request.signal);
    } catch (value) {
      if (this.request === request && !request.signal.aborted) {
        const error = value instanceof Error ? value : new Error('Chat failed.');
        this.update({ error });
        options.onError?.(error);
      }
    } finally {
      if (this.request === request) { this.request = undefined; this.update({ isLoading: false }); }
    }
  }
}

// Scope cache to one mounted DeepDives owner, not a global cross-document cache.
// Nested thread panels remount during layout changes; their streams must survive.
export class ChatSessions {
  private sessions = new Map<string, ChatSession>();
  get(id: string, messages: ChatMessage[] = []) {
    if (!this.sessions.has(id)) this.sessions.set(id, new ChatSession(messages));
    return this.sessions.get(id)!;
  }
  remove(id: string) { this.sessions.get(id)?.stop(); this.sessions.delete(id); }
  stopAll() { for (const session of this.sessions.values()) session.stop(); }
  clear() {
    // Preserve main's identity: loadState restores it through an existing hook.
    const main = this.sessions.get('main');
    this.stopAll(); this.sessions.clear();
    if (main) { main.setMessages([]); this.sessions.set('main', main); }
  }
}
