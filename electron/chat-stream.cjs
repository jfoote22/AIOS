const { once } = require('node:events');
const frame = (code, value) => `${code}:${JSON.stringify(value)}\n`;
function validateChatMessages(messages) {
  const invalid = () => Object.assign(new Error('Chat requires 1–500 text-only user/assistant messages ending with a user message.'), { status: 400 });
  if (!Array.isArray(messages) || !messages.length || messages.length > 500) throw invalid();
  let bytes = 0;
  const clean = messages.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.experimental_attachments?.length || message.parts || message.toolInvocations) throw invalid();
    bytes += Buffer.byteLength(message.content);
    if (bytes > 2 * 1024 * 1024) throw Object.assign(new Error('Chat context exceeds 2 MiB. Start a new conversation.'), { status: 413 });
    return { role: message.role, content: message.content };
  });
  if (clean.at(-1).role !== 'user' || !clean.at(-1).content.trim()) throw invalid();
  return clean;
}

// Keep the existing text/error/finish wire protocol for desktop, mobile, and
// CLI routes while using current provider SDKs. No UI/tool/file parts accepted.
function createChatStreamHandler({ buildModel, loadAi, withContext, appendSteer, defaultSystem, timeoutMs = 120000 }) {
  return async (req, res) => {
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    let timer;
    const write = async (code, value) => {
      if (controller.signal.aborted || res.destroyed || res.writableEnded) throw new Error('Stream closed.');
      if (!res.write(frame(code, value))) await once(res, 'drain', { signal: controller.signal });
    };
    try {
      const { messages, showReasoning = false, mode = 'auto', persona = 'normal', variant, context } = req.body || {};
      const clean = validateChatMessages(messages);
      if (context !== undefined && (typeof context !== 'string' || Buffer.byteLength(context) > 512 * 1024)) throw Object.assign(new Error('Invalid or oversized background context.'), { status: 400 });
      const { ai, createOpenAI, createAnthropic } = await loadAi();
      const { model, system, steer } = buildModel({ showReasoning, mode, persona, variant, createOpenAI, createAnthropic });
      if (controller.signal.aborted) return;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('x-vercel-ai-data-stream', 'v1');
      res.setHeader('Cache-Control', 'no-store');
      res.flushHeaders();
      timer = setTimeout(() => {
        if (!res.destroyed && !res.writableEnded) res.end(frame('3', 'Chat timed out. Please try again.'));
        controller.abort();
      }, timeoutMs);
      const result = ai.streamText({
        model, messages: appendSteer(clean, steer), system: withContext(system ?? defaultSystem, context),
        maxOutputTokens: 4000, tools: {}, activeTools: [], maxRetries: 0,
        streamRetries: 0, abortSignal: controller.signal, onError: () => {},
      });
      let finish, size = 0;
      for await (const event of result.fullStream) {
        if (event.type === 'error' || event.type === 'abort') throw new Error('Provider stream failed.');
        if (event.type === 'text-delta') {
          size += Buffer.byteLength(event.text);
          if (size > 2 * 1024 * 1024) throw new Error('Provider output exceeds limits.');
          // Bound each frame independently for the renderer parser.
          for (let i = 0; i < event.text.length; i += 16000) await write('0', event.text.slice(i, i + 16000));
        } else if (event.type === 'finish') finish = event;
      }
      if (!finish || !['stop', 'length'].includes(finish.finishReason)) throw new Error('Provider did not complete a text response.');
      await write('d', {
        finishReason: finish.finishReason,
        usage: { promptTokens: finish.totalUsage?.inputTokens || 0, completionTokens: finish.totalUsage?.outputTokens || 0 },
      });
      res.end();
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        // Never expose raw upstream bodies/headers (which may contain secrets).
        const message = error.status ? error.message : 'Chat provider failed. Check the configured model and credentials, then retry.';
        if (!res.headersSent) res.status(error.status || 502).json({ error: message });
        else res.end(frame('3', message));
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      res.off('close', disconnected);
    }
  };
}
module.exports = { createChatStreamHandler, validateChatMessages };
