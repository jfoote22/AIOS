// One-shot Claude generation (optionally with an image) for the main-process
// services that otherwise depend on Gemini: screenshot OCR and Ask Second
// Brain. Follows the Anthropic auth mode the desktop uses for chat —
// 'subscription' drives the logged-in Claude Code CLI through the Agent SDK
// (no API credits), 'api' uses the stored Anthropic key.
const { getProviderKey } = require('./keystore.cjs');
const { getModelId } = require('./modelstore.cjs');
const { promptStream } = require('./agent-prompt.cjs');
const { noToolsPolicy, assertAgentResult } = require('./agent-policy.cjs');
const { loadClaudeSdk } = require('./sdk-binaries.cjs');

// Sonnet slot: fast and vision-capable, and what the desktop maps 'sonnet' to.
const MODEL_SLOT = 'anthropic';

/**
 * @param {{ authMode: 'api' | 'subscription', system: string, text: string,
 *           image?: { mimeType: string, data: string } }} input  image.data is base64
 * @returns {Promise<string>} the full reply text
 */
async function claudeGenerate({ authMode, system, text, image }) {
  const modelId = getModelId(MODEL_SLOT);
  if (authMode === 'subscription') {
    const content = image
      ? [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } },
        { type: 'text', text },
      ]
      : text;
    const { query } = await loadClaudeSdk();
    let reply = '';
    for await (const msg of query({
      prompt: promptStream(content),
      options: { model: modelId, systemPrompt: system, ...noToolsPolicy() },
    })) {
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        const full = msg.message.content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
        if (full) reply = full;
      } else if (msg.type === 'result') {
        assertAgentResult(msg);
        break;
      }
    }
    if (!reply) throw new Error('Claude returned no content.');
    return reply;
  }

  const key = getProviderKey('anthropic');
  if (!key) throw new Error('No Anthropic key configured on the desktop (Models tab), and Claude is not in subscription mode.');
  const { generateText } = await import('ai');
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  const content = image
    ? [{ type: 'image', image: image.data, mediaType: image.mimeType }, { type: 'text', text }]
    : [{ type: 'text', text }];
  const { text: reply } = await generateText({
    model: createAnthropic({ apiKey: key })(modelId),
    system,
    messages: [{ role: 'user', content }],
    maxOutputTokens: 4096,
  });
  if (!reply) throw new Error('Claude returned no content.');
  return reply;
}

// Pull the first JSON object out of a model reply (tolerates code fences or
// a sentence before/after).
function parseJsonReply(reply) {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Claude did not return JSON.');
  return JSON.parse(reply.slice(start, end + 1));
}

module.exports = { claudeGenerate, parseJsonReply };
