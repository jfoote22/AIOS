// Local Express server that emulates DeepDive's Next.js API routes.
// Bound to 127.0.0.1 on a random port; only the main window can reach it.
// API keys are pulled per-request from the encrypted key store.

const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const cors = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
};

const { getProviderKey } = require('./keystore.cjs');
const { getModelId } = require('./modelstore.cjs');

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
      const { messages, showReasoning = false, mode = 'normal', variant } = req.body || {};
      const { ai, createOpenAI, createAnthropic } = await loadAi();
      const { model, system } = buildModel({ showReasoning, mode, variant, createOpenAI, createAnthropic });
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

  // --- OpenAI chat (model ID configurable via Models tab) ---
  app.post('/api/openai/chat', streamHandler(
    ({ createOpenAI }) => {
      const key = getProviderKey('openai');
      if (!key) throw new Error('OpenAI key not configured. Add it in Models tab.');
      const client = createOpenAI({ apiKey: key });
      return { model: client(getModelId('openai')), system: 'You are a helpful AI assistant' };
    }
  ));

  // --- Anthropic chat (model IDs for Opus/Sonnet variants configurable via Models tab) ---
  app.post('/api/anthropic/chat', streamHandler(
    ({ variant, createAnthropic }) => {
      const key = getProviderKey('anthropic');
      if (!key) throw new Error('Anthropic key not configured. Add it in Models tab.');
      const client = createAnthropic({ apiKey: key });
      const slot = variant === 'sonnet' ? 'anthropic' : 'claude';
      return { model: client(getModelId(slot)), system: 'You are a helpful AI assistant. You provide thoughtful, accurate, and engaging responses.' };
    }
  ));

  // --- Grok chat (X.AI, OpenAI-compatible; model ID configurable via Models tab) ---
  app.post('/api/grok/chat', streamHandler(
    ({ showReasoning, mode, createOpenAI }) => {
      const key = getProviderKey('grok');
      if (!key) throw new Error('Grok (xAI) key not configured. Add it in Models tab.');
      const client = createOpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: key });
      return { model: client(getModelId('grok')), system: buildGrokSystemPrompt({ showReasoning, mode }) };
    }
  ));

  // --- Claude Agent SDK chat (uses local `claude` CLI subscription auth, not API key) ---
  // Requires Claude Code installed and logged in: `claude /login`.
  // The renderer routes here when the user picks "Claude subscription" auth in Models tab.
  //
  // We emit the Vercel AI data-stream protocol manually so we don't pull in
  // @ai-sdk/ui-utils (which transitively depends on zod-to-json-schema):
  //   `0:<json-string>\n` = text delta
  //   `d:<json-object>\n` = finish_message
  //   `3:<json-string>\n` = error
  const streamPart = (type, value) => {
    const code = { text: '0', finish_message: 'd', error: '3' }[type];
    return `${code}:${JSON.stringify(value)}\n`;
  };

  // Pull the first balanced JSON object out of a string, tolerating leading
  // commentary, markdown fences, or trailing prose. Returns null on failure.
  const extractJsonObject = (text) => {
    if (typeof text !== 'string' || !text.length) return null;
    const start = text.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try { return JSON.parse(candidate); }
          catch { return null; }
        }
      }
    }
    return null;
  };

  app.post('/api/claude-agent/chat', async (req, res) => {
    try {
      const { messages = [], variant } = req.body || {};
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user') {
        return res.status(400).json({ error: 'Last message must be from user.' });
      }

      // The Agent SDK takes a single prompt; encode prior turns inline so it
      // has conversational context. (We disable tools so it behaves like chat.)
      const history = messages.slice(0, -1).map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
      ).join('\n\n');
      const prompt = history ? `${history}\n\nUser: ${last.content}` : last.content;

      const slot = variant === 'sonnet' ? 'anthropic' : 'claude';
      const modelId = getModelId(slot);

      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('x-vercel-ai-data-stream', 'v1');
      res.setHeader('Cache-Control', 'no-cache');

      const stream = query({
        prompt,
        options: {
          model: modelId,
          systemPrompt: 'You are a helpful AI assistant. Respond conversationally and concisely.',
          allowedTools: [],
          permissionMode: 'bypassPermissions',
        },
      });

      // The SDK emits each assistant message with the full accumulated text so far.
      // Track previously-sent length to convert to deltas for the AI data stream.
      let prevLen = 0;
      for await (const msg of stream) {
        if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
          let full = '';
          for (const block of msg.message.content) {
            if (block && block.type === 'text' && typeof block.text === 'string') {
              full += block.text;
            }
          }
          if (full.length > prevLen) {
            res.write(streamPart('text', full.slice(prevLen)));
            prevLen = full.length;
          }
        } else if (msg.type === 'result') {
          break;
        }
      }

      res.write(streamPart('finish_message', {
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
      }));
      res.end();
    } catch (err) {
      console.error('Claude Agent SDK error:', err);
      const message = err?.message || 'Claude Agent SDK request failed.';
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      } else {
        try { res.write(streamPart('error', message)); } catch {}
        res.end();
      }
    }
  });

  // --- Kanban task planner (Claude) ---
  // Takes a high-level goal, returns a list of modular subtasks. Reuses the
  // user's existing Anthropic auth: subscription (Agent SDK) or API key
  // (@ai-sdk/anthropic). Returns parsed JSON, never streams.
  app.post('/api/kanban/plan', async (req, res) => {
    try {
      const { goal, context, desiredCount, authMode } = req.body || {};
      if (!goal || typeof goal !== 'string' || !goal.trim()) {
        return res.status(400).json({ error: 'Missing or empty `goal`.' });
      }
      const target = Math.max(2, Math.min(20, Number(desiredCount) || 7));

      const systemPrompt = [
        'You are a kanban planning assistant. Given a high-level goal, decompose it into modular, independently actionable subtasks suitable for cards on a kanban board.',
        'Each subtask must be concrete, has a clear "done" state, and is small enough to complete in one focused work session.',
        'Avoid generic filler ("plan", "review"). Prefer specific, verb-first titles ("Wire OAuth callback to /api/auth/callback").',
        `Aim for roughly ${target} tasks. Order them so earlier tasks unblock later ones.`,
        '',
        'Return ONLY a JSON object matching this schema, with no surrounding prose or markdown fences:',
        '{ "tasks": [ { "title": string, "description": string, "estimate"?: string, "tag"?: string } ] }',
        'estimate is a short free-text size hint like "30 min", "small", "1 day".',
        'tag is a single lowercase token grouping related tasks (e.g. "backend", "ui", "docs").',
      ].join('\n');

      const userPrompt = context
        ? `GOAL:\n${goal.trim()}\n\nADDITIONAL CONTEXT:\n${context}`
        : `GOAL:\n${goal.trim()}`;

      let raw = '';

      if (authMode === 'subscription') {
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const modelId = getModelId('claude') || getModelId('anthropic');
        const stream = query({
          prompt: `${systemPrompt}\n\n${userPrompt}`,
          options: {
            model: modelId,
            systemPrompt,
            allowedTools: [],
            permissionMode: 'bypassPermissions',
          },
        });
        for await (const msg of stream) {
          if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
            for (const block of msg.message.content) {
              if (block && block.type === 'text' && typeof block.text === 'string') raw += block.text;
            }
          } else if (msg.type === 'result') break;
        }
      } else {
        // API key path via @anthropic-ai/sdk
        const key = getProviderKey('anthropic');
        if (!key) {
          return res.status(400).json({ error: 'Anthropic key not configured. Add it in Models tab, or switch to subscription auth.' });
        }
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: key });
        const modelId = getModelId('claude') || getModelId('anthropic') || 'claude-opus-4-7';
        const response = await client.messages.create({
          model: modelId,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        });
        for (const block of response.content || []) {
          if (block.type === 'text') raw += block.text;
        }
      }

      // Extract the first JSON object in the response — Claude sometimes wraps
      // it in fences or commentary even when told not to.
      const parsed = extractJsonObject(raw);
      if (!parsed || !Array.isArray(parsed.tasks)) {
        return res.status(502).json({ error: 'Planner returned no parsable task list.', raw: raw.slice(0, 800) });
      }
      const tasks = parsed.tasks
        .filter(t => t && typeof t === 'object' && typeof t.title === 'string' && t.title.trim())
        .map(t => ({
          title: String(t.title).trim(),
          description: typeof t.description === 'string' ? t.description.trim() : '',
          estimate: typeof t.estimate === 'string' ? t.estimate.trim() : undefined,
          tag: typeof t.tag === 'string' ? t.tag.trim().toLowerCase() : undefined,
        }));

      res.json({ tasks });
    } catch (err) {
      console.error('Kanban planner error:', err);
      const message = err?.message || 'Kanban planner failed.';
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  });

  // --- Agent definitions: write/delete .claude/agents/<slug>.md ---
  // Persists a Claude Code subagent file inside the agent's working directory
  // so the same agent works when invoked from the bare `claude` CLI too.
  app.post('/api/agents/write-md', async (req, res) => {
    try {
      const { slug, workingDir, markdown } = req.body || {};
      if (!slug || !workingDir || typeof markdown !== 'string') {
        return res.status(400).json({ error: 'Missing slug, workingDir, or markdown.' });
      }
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Slug must be lowercase alphanumeric + dashes.' });
      }
      const safeSlug = slug.slice(0, 60);
      const dir = path.resolve(workingDir, '.claude', 'agents');
      const file = path.join(dir, `${safeSlug}.md`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, markdown, 'utf8');
      res.json({ path: file });
    } catch (err) {
      console.error('write-md error:', err);
      res.status(500).json({ error: err?.message || 'Failed to write agent file.' });
    }
  });

  app.post('/api/agents/delete-md', async (req, res) => {
    try {
      const { slug, workingDir } = req.body || {};
      if (!slug || !workingDir) return res.status(400).json({ error: 'Missing slug or workingDir.' });
      if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Bad slug.' });
      const file = path.resolve(workingDir, '.claude', 'agents', `${slug.slice(0, 60)}.md`);
      try { await fs.unlink(file); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
      res.json({ ok: true });
    } catch (err) {
      console.error('delete-md error:', err);
      res.status(500).json({ error: err?.message || 'Failed to delete agent file.' });
    }
  });

  // --- Agent Builder: per-field AI assist ---
  // Asks Claude to fill or refine a single agent field given the rest of the
  // partial agent as context. Returns plain text (or JSON-stringified array
  // for the tools field).
  app.post('/api/agents/draft', async (req, res) => {
    try {
      const { field, currentValue = '', hint = '', agent = {}, authMode } = req.body || {};
      if (!field) return res.status(400).json({ error: 'Missing `field`.' });

      const sysParts = [
        'You are an expert at defining specialized Claude agents (subagents).',
        'You are filling in a single field of an agent definition based on the existing partial config.',
        'Return ONLY the new field value, no commentary, no markdown fences.',
      ];

      let fieldGuidance = '';
      if (field === 'description') {
        fieldGuidance = 'Return a 1-sentence description (under 140 chars) of what this agent does and when to use it. No trailing period needed.';
      } else if (field === 'systemPrompt') {
        fieldGuidance = 'Return a focused system prompt (50–250 words). Make the role explicit, list responsibilities, and end with concrete output expectations. Plain prose, no markdown headings.';
      } else if (field === 'tools') {
        fieldGuidance = 'Return ONLY a JSON array of tool names this agent needs (subset of: Read, Glob, Grep, Edit, Write, Bash, WebFetch, WebSearch). Be conservative — only include tools genuinely needed for the role. Example: ["Read","Glob","Grep"]';
      } else if (field === 'all') {
        fieldGuidance = 'Return a JSON object: { "description": "...", "systemPrompt": "...", "tools": ["..."] }. Same constraints as the individual fields.';
      } else {
        return res.status(400).json({ error: `Unknown field "${field}".` });
      }
      sysParts.push(fieldGuidance);

      const ctxLines = [
        `Agent name: ${agent.name || '(unnamed)'}`,
        agent.description ? `Description: ${agent.description}` : '',
        agent.systemPrompt ? `System prompt so far: ${agent.systemPrompt}` : '',
        Array.isArray(agent.allowedTools) && agent.allowedTools.length ? `Allowed tools so far: ${agent.allowedTools.join(', ')}` : '',
        agent.workingDir ? `Working dir: ${agent.workingDir}` : '',
        currentValue ? `Current value of this field:\n${currentValue}` : '',
        hint ? `User hint: ${hint}` : '',
      ].filter(Boolean);
      const userPrompt = `Context:\n${ctxLines.join('\n')}\n\nProvide the new value for "${field}" now.`;

      let raw = '';
      if (authMode === 'subscription') {
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const modelId = getModelId('claude') || getModelId('anthropic');
        const stream = query({
          prompt: userPrompt,
          options: {
            model: modelId,
            systemPrompt: sysParts.join('\n'),
            allowedTools: [],
            permissionMode: 'bypassPermissions',
          },
        });
        for await (const msg of stream) {
          if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
            for (const block of msg.message.content) {
              if (block && block.type === 'text' && typeof block.text === 'string') raw += block.text;
            }
          } else if (msg.type === 'result') break;
        }
      } else {
        const key = getProviderKey('anthropic');
        if (!key) return res.status(400).json({ error: 'Anthropic key not configured. Add it in Models tab, or switch to subscription auth.' });
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: key });
        const modelId = getModelId('claude') || getModelId('anthropic') || 'claude-opus-4-7';
        const response = await client.messages.create({
          model: modelId,
          max_tokens: 1024,
          system: sysParts.join('\n'),
          messages: [{ role: 'user', content: userPrompt }],
        });
        for (const block of response.content || []) {
          if (block.type === 'text') raw += block.text;
        }
      }

      const value = raw.trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
      res.json({ field, value });
    } catch (err) {
      console.error('agent draft error:', err);
      if (!res.headersSent) res.status(500).json({ error: err?.message || 'Agent draft failed.' });
    }
  });

  // --- OpenAI Codex SDK chat (uses local `codex` CLI ChatGPT-subscription auth) ---
  // Requires Codex CLI installed and signed in: `codex login` (Plus/Pro/Business).
  // The renderer routes here when the user picks "ChatGPT subscription" auth in Models tab.
  app.post('/api/codex-agent/chat', async (req, res) => {
    try {
      const { messages = [] } = req.body || {};
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user') {
        return res.status(400).json({ error: 'Last message must be from user.' });
      }

      const history = messages.slice(0, -1).map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
      ).join('\n\n');
      const prompt = history ? `${history}\n\nUser: ${last.content}` : last.content;

      // Codex with a ChatGPT-account login picks the model based on your plan
      // and rejects most explicit model IDs (the `openai` modelstore slot is
      // intended for the Chat Completions API, not Codex). Omit `model` so
      // Codex auto-selects. To override, set `AIOS_CODEX_MODEL` in the env.
      const codexModelOverride = (process.env.AIOS_CODEX_MODEL || '').trim();

      const { Codex } = await import('@openai/codex-sdk');
      const codex = new Codex();
      const thread = codex.startThread({
        ...(codexModelOverride ? { model: codexModelOverride } : {}),
        // Lock it down so Codex behaves like chat, not a coding agent:
        sandboxMode: 'read-only',
        skipGitRepoCheck: true,
        networkAccessEnabled: false,
        webSearchEnabled: false,
        approvalPolicy: 'never',
      });

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('x-vercel-ai-data-stream', 'v1');
      res.setHeader('Cache-Control', 'no-cache');

      const streamed = await thread.runStreamed(prompt);

      // Codex emits agent_message items whose `text` accumulates over events.
      // Track prev length per item id to emit only the new delta to the client.
      const itemSent = new Map();

      for await (const event of streamed.events) {
        if (event.type === 'item.updated' || event.type === 'item.completed') {
          const item = event.item;
          if (item && item.type === 'agent_message' && typeof item.text === 'string') {
            const prev = itemSent.get(item.id) || 0;
            if (item.text.length > prev) {
              res.write(streamPart('text', item.text.slice(prev)));
              itemSent.set(item.id, item.text.length);
            }
          }
        } else if (event.type === 'turn.completed') {
          break;
        } else if (event.type === 'turn.failed') {
          throw new Error(event.error?.message || 'Codex turn failed.');
        } else if (event.type === 'error') {
          throw new Error(event.message || 'Codex stream error.');
        }
      }

      res.write(streamPart('finish_message', {
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
      }));
      res.end();
    } catch (err) {
      console.error('Codex SDK error:', err);
      const message = err?.message || 'Codex SDK request failed.';
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      } else {
        try { res.write(streamPart('error', message)); } catch {}
        res.end();
      }
    }
  });

  // --- Deepgram key fetch (renderer needs the key to talk to Deepgram directly) ---
  app.get('/api/deepgram', (_req, res) => {
    res.json({ key: getProviderKey('deepgram') || '' });
  });

  // --- Vision OCR / snippet analysis (currently OpenAI; matches Gemini analyzeSnip shape) ---
  app.post('/api/vision/analyze-snip', async (req, res) => {
    try {
      const { imageDataUrl, provider } = req.body || {};
      if (!imageDataUrl || typeof imageDataUrl !== 'string') {
        return res.status(400).json({ error: 'imageDataUrl is required' });
      }
      if (provider && provider !== 'openai') {
        return res.status(400).json({ error: `Vision provider "${provider}" is not yet wired. Use 'openai' or analyze via Gemini directly.` });
      }
      const key = getProviderKey('openai');
      if (!key) return res.status(400).json({ error: 'OpenAI key not configured. Add it in the Models tab.' });

      const modelId = getModelId('openai');
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: key });

      const prompt = `You are the AI curator for "AIOS Vault" — a personal knowledge capture tool. The user has just captured this screenshot. Analyze it and return ONLY valid JSON in exactly this shape (no markdown, no code fences):
{
  "title": "5-10 word descriptive title for this capture",
  "summary": "A concise paragraph (2-4 sentences) describing what is in the image and what it appears to be doing or showing",
  "category": "One short category name like Houdini, Travel, Finance, Development, Design, Reference, Personal, General",
  "source": "Best guess of source app/website based on visible UI cues (Chrome, VS Code, Houdini, YouTube, Slack, etc.)",
  "tags": ["3-8 lowercase keyword tags"],
  "entities": [{ "type": "link|number|address|info", "label": "Short label", "value": "literal extracted value" }],
  "extractedText": "All readable text in the image, transcribed verbatim. Empty string if no text."
}
Be specific and faithful to what is actually visible. Do not invent details. If the image is mostly empty or unreadable, say so honestly in the summary. Respond with ONLY the JSON object.`;

      const completion = await client.chat.completions.create({
        model: modelId,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        }],
      });

      let text = completion.choices?.[0]?.message?.content || '';
      // Strip any stray markdown fences and isolate the outermost JSON object.
      text = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) text = text.substring(start, end + 1);

      const parsed = JSON.parse(text);
      const allowed = new Set(['link', 'number', 'address', 'info']);
      parsed.entities = (parsed.entities || []).map(e => ({ ...e, type: allowed.has(e?.type) ? e.type : 'info' }));
      parsed.tags = Array.isArray(parsed.tags) ? parsed.tags : [];
      parsed.extractedText = parsed.extractedText || '';

      res.json(parsed);
    } catch (e) {
      console.error('Vision OCR error:', e);
      res.status(500).json({ error: e?.message || 'Vision analysis failed' });
    }
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
