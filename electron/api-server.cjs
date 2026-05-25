// Local Express server that emulates DeepDive's Next.js API routes.
// Bound to 127.0.0.1 on a random port; only the main window can reach it.
// API keys are pulled per-request from the encrypted key store.

const express = require('express');
const cors = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
};

const { getProviderKey } = require('./keystore.cjs');

// Dynamic imports for ESM-only ai SDK packages.
async function loadAi() {
  const ai = await import('ai');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  return { ai, createOpenAI, createAnthropic };
}

function streamHandler(buildModel, defaultSystem) {
  return async (req, res) => {
    try {
      const { messages, showReasoning = false, mode = 'normal' } = req.body || {};
      const { ai, createOpenAI, createAnthropic } = await loadAi();
      const { model, system } = buildModel({ showReasoning, mode, createOpenAI, createAnthropic });
      const result = await ai.streamText({
        model,
        messages: ai.convertToCoreMessages(messages),
        system: system ?? defaultSystem,
        maxTokens: 4000,
      });
      result.pipeDataStreamToResponse(res);
    } catch (err) {
      console.error('API stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || 'Stream failed' });
      } else {
        res.end();
      }
    }
  };
}

function buildGrokSystemPrompt({ showReasoning, mode }) {
  if (showReasoning) {
    return `You are Grok4, a witty and helpful AI assistant created by X.AI. When responding, you MUST show your complete thinking process using this exact format:

🤔 **THINKING:**
[Break down the problem step by step]
- First, I need to understand: [what you're analyzing]
- Let me consider: [key factors/information]
- I should think about: [relevant context or constraints]
- Alternative approaches: [other ways to think about this]
- My reasoning: [logical flow of your thinking]

💡 **ANSWER:**
[Your complete response based on the thinking above]

Always show your work like on grok.com's Think Mode. Be thorough in your reasoning process, even for simple questions.`;
  }
  switch (mode) {
    case 'fun':      return "You are Grok4, a maximally truth-seeking AI with a witty, humorous personality inspired by the Hitchhiker's Guide to the Galaxy. Respond with clever jokes, sarcasm, and fun insights while being helpful.";
    case 'creative': return 'You are Grok4, a creative and imaginative AI. Provide innovative, out-of-the-box ideas and responses while maintaining accuracy and helpfulness.';
    case 'precise':  return 'You are Grok4, a precise and factual AI. Provide concise, accurate information without unnecessary elaboration or humor.';
    default:         return 'You are Grok4, a witty and helpful AI assistant created by X.AI. You provide thoughtful, accurate, and engaging responses with a touch of humor when appropriate.';
  }
}

function start() {
  const app = express();
  app.use(cors);
  app.use(express.json({ limit: '20mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // --- OpenAI chat (gpt-4o) ---
  app.post('/api/openai/chat', streamHandler(
    ({ createOpenAI }) => {
      const key = getProviderKey('openai');
      if (!key) throw new Error('OpenAI key not configured. Add it in Models tab.');
      const client = createOpenAI({ apiKey: key });
      return { model: client('gpt-4o'), system: 'You are a helpful AI assistant' };
    }
  ));

  // --- Anthropic chat (claude-3-opus) ---
  app.post('/api/anthropic/chat', streamHandler(
    ({ createAnthropic }) => {
      const key = getProviderKey('anthropic');
      if (!key) throw new Error('Anthropic key not configured. Add it in Models tab.');
      const client = createAnthropic({ apiKey: key });
      return { model: client('claude-3-opus-20240229'), system: 'You are a helpful AI assistant. You provide thoughtful, accurate, and engaging responses.' };
    }
  ));

  // --- Grok chat (X.AI, OpenAI-compatible) ---
  app.post('/api/grok/chat', streamHandler(
    ({ showReasoning, mode, createOpenAI }) => {
      const key = getProviderKey('grok');
      if (!key) throw new Error('Grok (xAI) key not configured. Add it in Models tab.');
      const client = createOpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: key });
      return { model: client('grok-4'), system: buildGrokSystemPrompt({ showReasoning, mode }) };
    }
  ));

  // --- Deepgram key fetch (renderer needs the key to talk to Deepgram directly) ---
  app.get('/api/deepgram', (_req, res) => {
    res.json({ key: getProviderKey('deepgram') || '' });
  });

  // TODO Phase 3: /api/openai/transcribe, /api/grok/analyze-learning,
  // /api/replicate/claude, /api/replicate/generate-image

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`[api-server] listening on http://127.0.0.1:${port}`);
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

module.exports = { start };
