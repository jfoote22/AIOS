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
const extract = require('./extract.cjs');
const research = require('./research.cjs');

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

const VISION_EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.pdf': 'application/pdf',
};

const VISION_PROMPT =
  'Extract ALL readable text from this document/image verbatim. Preserve structure ' +
  '(headings, lists, and tables as markdown) where possible. If there is no text, ' +
  'briefly describe the visual content instead. Output only the extracted content — ' +
  'no preamble, no commentary.';

// Build a vision-based text extractor used for images and scanned PDFs.
// Prefers Gemini (handles images AND PDFs natively); falls back to OpenAI for
// images only. Returns null if no vision-capable provider is configured.
// This is the one extraction path that is NOT the user's chat model — images
// can't be read by every chat provider, so a fixed extractor is used.
async function buildVisionExtractor() {
  const geminiKey = getProviderKey('gemini');
  if (geminiKey) {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey: geminiKey });
    return async (buf, ext) => {
      const mimeType = VISION_EXT_MIME[ext] || 'application/octet-stream';
      const result = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: buf.toString('base64') } },
            { text: VISION_PROMPT },
          ],
        }],
      });
      return result.text || '';
    };
  }

  const openaiKey = getProviderKey('openai');
  if (openaiKey) {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: openaiKey });
    return async (buf, ext) => {
      const mimeType = VISION_EXT_MIME[ext];
      if (!mimeType || mimeType === 'application/pdf') {
        throw new Error('OpenAI vision fallback supports images only. Configure a Gemini key to read scanned PDFs.');
      }
      const dataUrl = `data:${mimeType};base64,${buf.toString('base64')}`;
      const completion = await client.chat.completions.create({
        model: getModelId('openai'),
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      });
      return completion.choices?.[0]?.message?.content || '';
    };
  }

  return null;
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
      const { goal, context, constraints, acceptance, questions, desiredCount, authMode } = req.body || {};
      if (!goal || typeof goal !== 'string' || !goal.trim()) {
        return res.status(400).json({ error: 'Missing or empty `goal`.' });
      }
      const target = Math.max(2, Math.min(20, Number(desiredCount) || 7));

      const systemPrompt = [
        'You are a senior delivery planner for an AI-assisted engineering kanban board. Given a planning brief, decompose it into connected, modular cards that build toward the same outcome.',
        'Each card must have a concise task name and a detailed, plan-oriented description that explains purpose, implementation direction, dependencies, and a clear done state.',
        'Cards should connect: earlier cards establish foundations, later cards integrate, polish, verify, or document. Avoid isolated chores unless they genuinely unblock the plan.',
        'Avoid generic filler ("plan", "review"). Prefer specific, verb-first titles ("Create persisted planning brief model", "Wire planner cards into backlog generation").',
        `Aim for roughly ${target} tasks. Order them so earlier tasks unblock later ones.`,
        '',
        'Return ONLY a JSON object matching this schema, with no surrounding prose or markdown fences:',
        '{ "tasks": [ { "title": string, "description": string, "estimate"?: string, "tag"?: string, "dependsOn"?: string[] } ] }',
        'description should be 3-6 sentences or concise bullets encoded as plain text. Include acceptance criteria when useful.',
        'estimate is a short free-text size hint like "30 min", "small", "1 day".',
        'tag is a single lowercase token grouping related tasks (e.g. "backend", "ui", "docs").',
        'dependsOn is an optional list of earlier task titles this card depends on.',
      ].join('\n');

      const userPrompt = [
        `GOAL:\n${goal.trim()}`,
        context ? `\nCONTEXT / CURRENT STATE:\n${context}` : '',
        constraints ? `\nCONSTRAINTS / NON-GOALS:\n${constraints}` : '',
        acceptance ? `\nDEFINITION OF DONE:\n${acceptance}` : '',
        questions ? `\nANSWERS / OPEN QUESTIONS:\n${questions}` : '',
      ].filter(Boolean).join('\n');

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
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean) : undefined,
        }));

      res.json({ tasks });
    } catch (err) {
      console.error('Kanban planner error:', err);
      const message = err?.message || 'Kanban planner failed.';
      if (!res.headersSent) res.status(500).json({ error: message });
    }
  });

  app.post('/api/kanban/plan-assist', async (req, res) => {
    try {
      const { goal = '', context = '', constraints = '', acceptance = '', questions = '', desiredCount, authMode } = req.body || {};
      if (!String(goal).trim() && !String(context).trim()) {
        return res.status(400).json({ error: 'Add at least a goal or context first.' });
      }

      const systemPrompt = [
        'You help turn a rough product or engineering idea into a useful planning brief before generating kanban cards.',
        'Improve what the user has entered. Keep the user intent intact; do not invent product requirements that conflict with the brief.',
        'Ask only high-leverage questions. If enough is known, include assumptions instead of blocking.',
        '',
        'Return ONLY a JSON object matching this schema, with no prose or markdown fences:',
        '{ "goal": string, "context": string, "constraints": string, "acceptance": string, "questions": string, "desiredCount"?: number }',
        'questions should be short numbered questions or explicit assumptions. Keep every field practical and ready to feed into a card planner.',
      ].join('\n');

      const userPrompt = [
        `Goal:\n${String(goal).trim() || '(blank)'}`,
        `Current state / notes:\n${String(context).trim() || '(blank)'}`,
        `Constraints / non-goals:\n${String(constraints).trim() || '(blank)'}`,
        `Definition of done:\n${String(acceptance).trim() || '(blank)'}`,
        `Questions / assumptions:\n${String(questions).trim() || '(blank)'}`,
        `Target card count: ${Number(desiredCount) || 7}`,
        '',
        'Refine this into a stronger planning brief now.',
      ].join('\n\n');

      let raw = '';
      if (authMode === 'subscription') {
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const modelId = getModelId('claude') || getModelId('anthropic');
        const stream = query({
          prompt: userPrompt,
          options: { model: modelId, systemPrompt, allowedTools: [], permissionMode: 'bypassPermissions' },
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
          max_tokens: 3072,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        });
        for (const block of response.content || []) {
          if (block.type === 'text') raw += block.text;
        }
      }

      const parsed = extractJsonObject(raw);
      if (!parsed) {
        return res.status(502).json({ error: 'Claude returned no parsable planning brief.', raw: raw.slice(0, 800) });
      }
      res.json({
        goal: typeof parsed.goal === 'string' ? parsed.goal.trim() : String(goal).trim(),
        context: typeof parsed.context === 'string' ? parsed.context.trim() : String(context).trim(),
        constraints: typeof parsed.constraints === 'string' ? parsed.constraints.trim() : String(constraints).trim(),
        acceptance: typeof parsed.acceptance === 'string' ? parsed.acceptance.trim() : String(acceptance).trim(),
        questions: typeof parsed.questions === 'string' ? parsed.questions.trim() : String(questions).trim(),
        desiredCount: Number.isFinite(Number(parsed.desiredCount)) ? Math.max(2, Math.min(20, Number(parsed.desiredCount))) : undefined,
      });
    } catch (err) {
      console.error('Kanban plan assist error:', err);
      if (!res.headersSent) res.status(500).json({ error: err?.message || 'Plan assist failed.' });
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

  // --- Agent runs: actually execute an agent against a card ---
  // Streams the Vercel AI data-stream protocol so the renderer can chunk text
  // into the card's transcript live. Tool calls and tool results are formatted
  // inline as plain text deltas (no separate stream channel) to keep the UI
  // simple. The Manager / per-card Cancel button hits /api/agents/run/cancel
  // which signals the AbortController held in `activeRuns`.

  const activeRuns = new Map(); // runId -> AbortController

  app.post('/api/agents/run', async (req, res) => {
    const { runId, card, agent, authMode } = req.body || {};
    if (!runId || !card || !agent) {
      return res.status(400).json({ error: 'Missing runId, card, or agent.' });
    }
    if (!agent.systemPrompt || !agent.systemPrompt.trim()) {
      return res.status(400).json({ error: 'Agent has no system prompt — fill it in the Agent Builder first.' });
    }

    const controller = new AbortController();
    activeRuns.set(runId, controller);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('x-vercel-ai-data-stream', 'v1');
    res.setHeader('Cache-Control', 'no-cache');

    const writeText = (text) => {
      if (!text || res.writableEnded) return;
      try { res.write(streamPart('text', text)); } catch {}
    };
    const writeError = (msg) => {
      if (res.writableEnded) return;
      try { res.write(streamPart('error', String(msg))); } catch {}
    };
    const writeFinish = (reason) => {
      if (res.writableEnded) return;
      try {
        res.write(streamPart('finish_message', {
          finishReason: reason,
          usage: { promptTokens: 0, completionTokens: 0 },
        }));
      } catch {}
    };

    const taskPrompt = [
      `# Task`,
      card.title,
      '',
      card.description ? `## Details\n${card.description}` : '',
      '',
      `When you're done, summarize what you did and stop.`,
    ].filter(Boolean).join('\n');

    try {
      // Both paths use the Claude Agent SDK so the agent gets real tool access.
      // API-key path also goes through Agent SDK (it picks up ANTHROPIC_API_KEY
      // from process env if no subscription is logged in).
      const prevEnvKey = process.env.ANTHROPIC_API_KEY;
      if (authMode !== 'subscription') {
        const key = getProviderKey('anthropic');
        if (!key) {
          activeRuns.delete(runId);
          if (!res.headersSent) return res.status(400).json({ error: 'No Anthropic API key configured. Add one in Models or switch to subscription auth.' });
          writeError('No Anthropic API key configured.');
          writeFinish('error');
          return res.end();
        }
        process.env.ANTHROPIC_API_KEY = key;
      }

      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const modelOverride = (agent.model && agent.model !== 'inherit') ? agent.model : (getModelId('claude') || getModelId('anthropic'));
      const allowed = Array.isArray(agent.allowedTools) ? agent.allowedTools : [];
      const cwd = (agent.workingDir && typeof agent.workingDir === 'string') ? agent.workingDir : undefined;

      writeText(`• Agent: ${agent.name || agent.slug}\n• Model: ${modelOverride || 'inherit'}\n• Tools: ${allowed.join(', ') || '(none)'}\n• Cwd: ${cwd || '(default)'}\n\n`);

      const stream = query({
        prompt: taskPrompt,
        options: {
          model: modelOverride,
          systemPrompt: agent.systemPrompt,
          allowedTools: allowed,
          permissionMode: 'bypassPermissions',
          cwd,
          abortController: controller,
        },
      });

      let assistantPrevLen = 0;
      for await (const msg of stream) {
        if (controller.signal.aborted) break;

        if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
          // Accumulate text blocks and emit deltas; also inline tool_use blocks.
          let full = '';
          for (const block of msg.message.content) {
            if (block && block.type === 'text' && typeof block.text === 'string') {
              full += block.text;
            } else if (block && block.type === 'tool_use') {
              const inputStr = (() => {
                try { return JSON.stringify(block.input).slice(0, 240); }
                catch { return ''; }
              })();
              full += `\n→ ${block.name}(${inputStr})\n`;
            }
          }
          if (full.length > assistantPrevLen) {
            writeText(full.slice(assistantPrevLen));
            assistantPrevLen = full.length;
          }
        } else if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
          // Tool results come back as user-role messages with tool_result blocks.
          for (const block of msg.message.content) {
            if (block && block.type === 'tool_result') {
              const text = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map(c => (c?.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
                  : '';
              const trimmed = text.length > 600 ? text.slice(0, 600) + '\n…(truncated)' : text;
              if (trimmed) writeText(`← ${trimmed}\n`);
            }
          }
          // Reset assistant counter so the next assistant message starts fresh
          assistantPrevLen = 0;
        } else if (msg.type === 'result') {
          break;
        }
      }

      if (authMode !== 'subscription') {
        if (prevEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevEnvKey;
      }

      writeFinish(controller.signal.aborted ? 'canceled' : 'stop');
      res.end();
    } catch (err) {
      console.error('agent run error:', err);
      const msg = err?.message || 'Agent run failed.';
      if (!res.headersSent) {
        res.status(500).json({ error: msg });
      } else {
        writeError(msg);
        writeFinish('error');
        res.end();
      }
    } finally {
      activeRuns.delete(runId);
    }
  });

  app.post('/api/agents/run/cancel', (req, res) => {
    const { runId } = req.body || {};
    const c = runId ? activeRuns.get(runId) : null;
    if (c) { try { c.abort(); } catch {} }
    res.json({ canceled: !!c });
  });

  // --- Review (Maestro self-approve OR a chosen reviewer agent grades a run) ---
  app.post('/api/agents/review', async (req, res) => {
    try {
      const { card, transcript, reviewer, authMode } = req.body || {};
      if (!card || typeof transcript !== 'string') {
        return res.status(400).json({ error: 'card and transcript are required.' });
      }

      const reviewerName = reviewer?.name || 'Maestro';
      const reviewerExtra = reviewer?.systemPrompt
        ? `\n\nReviewer character: ${reviewer.systemPrompt.slice(0, 1200)}`
        : '';

      const systemPrompt = [
        `You are ${reviewerName}, reviewing a finished agent run on a kanban card.`,
        'Decide whether the work meets the bar for "Done". Be fair but discerning — partial work, planning-only, or errors should NOT pass.',
        '',
        'Return ONLY a JSON object — no prose, no fences:',
        '{ "pass": boolean, "rationale": "one short sentence (<200 chars)" }',
        reviewerExtra,
      ].join('\n');

      const userPrompt = [
        `## Card`,
        `Title: ${card.title}`,
        card.description ? `Description: ${card.description}` : '',
        '',
        `## Agent transcript`,
        transcript.slice(0, 12000),
        '',
        'Verdict?',
      ].filter(Boolean).join('\n');

      let raw = '';
      if (authMode === 'subscription') {
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const modelId = getModelId('claude') || getModelId('anthropic');
        const stream = query({
          prompt: userPrompt,
          options: { model: modelId, systemPrompt, allowedTools: [], permissionMode: 'bypassPermissions' },
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
        if (!key) return res.status(400).json({ error: 'Anthropic key not configured.' });
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: key });
        const modelId = getModelId('claude') || getModelId('anthropic') || 'claude-opus-4-7';
        const response = await client.messages.create({
          model: modelId, max_tokens: 1024, system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        });
        for (const block of response.content || []) {
          if (block.type === 'text') raw += block.text;
        }
      }

      const parsed = extractJsonObject(raw);
      if (!parsed || typeof parsed.pass !== 'boolean') {
        return res.status(502).json({ error: 'Reviewer returned no parsable verdict.', raw: raw.slice(0, 800) });
      }
      res.json({
        pass: !!parsed.pass,
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '',
      });
    } catch (err) {
      console.error('review error:', err);
      if (!res.headersSent) res.status(500).json({ error: err?.message || 'Review failed.' });
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

  // --- DeepDive research: fetch & extract a web page as clean markdown ---
  // Model-agnostic: extraction happens here, and the renderer injects the
  // resulting text into the chat context before it reaches any model.
  app.post('/api/research/fetch-url', async (req, res) => {
    try {
      const { url } = req.body || {};
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url is required' });
      }
      const result = await extract.extractUrl(url.trim());
      res.json(result);
    } catch (e) {
      console.error('URL extraction error:', e);
      res.status(400).json({ error: e?.message || 'Failed to extract URL' });
    }
  });

  // --- DeepDive research: extract text from a local file ---
  app.post('/api/research/extract-file', async (req, res) => {
    try {
      const { filePath } = req.body || {};
      if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'filePath is required' });
      }
      // Vision extractor (Gemini/OpenAI) handles images and scanned PDFs;
      // null when no vision provider is configured (extractFile then errors
      // only for image/scanned inputs, not text-bearing files).
      const visionExtractor = await buildVisionExtractor().catch(() => null);
      const result = await extract.extractFile(filePath, visionExtractor);
      res.json(result);
    } catch (e) {
      console.error('File extraction error:', e);
      res.status(400).json({ error: e?.message || 'Failed to extract file' });
    }
  });

  // --- DeepDive research: real link search (Gemini grounding + verification) ---
  app.post('/api/research/find-links', async (req, res) => {
    try {
      const { context } = req.body || {};
      if (!context || typeof context !== 'string') {
        return res.status(400).json({ error: 'context is required' });
      }
      const result = await research.findLinks(context);
      res.json(result);
    } catch (e) {
      console.error('find-links error:', e);
      res.status(400).json({ error: e?.message || 'Failed to find links' });
    }
  });

  // --- DeepDive research: real YouTube video search (Data API, ranked) ---
  app.post('/api/research/find-videos', async (req, res) => {
    try {
      const { context } = req.body || {};
      if (!context || typeof context !== 'string') {
        return res.status(400).json({ error: 'context is required' });
      }
      const result = await research.findVideos(context);
      res.json(result);
    } catch (e) {
      console.error('find-videos error:', e);
      res.status(400).json({ error: e?.message || 'Failed to find videos' });
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
