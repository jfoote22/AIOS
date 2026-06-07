// Local Express server that emulates DeepDive's Next.js API routes.
// Bound to 127.0.0.1 on a random port; only the main window can reach it.
// API keys are pulled per-request from the encrypted key store.

const express = require('express');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cors = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
};

const { getProviderKey, setProviderKey } = require('./keystore.cjs');
const { getModelId, setModelId } = require('./modelstore.cjs');
const extract = require('./extract.cjs');
const research = require('./research.cjs');
const deepResearch = require('./deep-research.cjs');

// Dynamic imports for ESM-only ai SDK packages.
async function loadAi() {
  const ai = await import('ai');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  return { ai, createOpenAI, createAnthropic };
}

// Fold optional caller-supplied background context (e.g. a Deep Research report
// a thread is following up on) into a base system prompt. Kept out of the
// visible chat — it rides along as system context so the model can answer
// questions about it.
function withContext(base, context) {
  const c = typeof context === 'string' ? context.trim() : '';
  return c ? `${base}\n\n${c}` : base;
}

function streamHandler(buildModel, defaultSystem) {
  return async (req, res) => {
    try {
      const { messages, showReasoning = false, mode = 'normal', variant, context } = req.body || {};
      const { ai, createOpenAI, createAnthropic } = await loadAi();
      const { model, system, steer } = buildModel({ showReasoning, mode, variant, createOpenAI, createAnthropic });
      const result = await ai.streamText({
        model,
        messages: ai.convertToCoreMessages(appendSteer(messages, steer)),
        system: withContext(system ?? defaultSystem, context),
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
  // Persona is chosen per-message and can change mid-conversation. The model
  // sees its own earlier replies in the history and tends to keep imitating
  // their style, so every persona ends with an explicit override clause that
  // tells it to ignore the tone/format of prior messages from THIS reply on.
  const OVERRIDE =
    ' IMPORTANT: This style governs your next reply and every reply after it. ' +
    'Ignore and override the tone, length, and formatting of any earlier ' +
    'messages in this conversation — even if your own previous answers used a ' +
    'completely different style. Switch fully to this style now.';

  switch (mode) {
    case 'fun':      return "You are Grok4 in Fun mode — a witty, irreverent AI inspired by the Hitchhiker's Guide to the Galaxy. Lean into clever jokes, playful sarcasm, and entertaining asides while still being genuinely helpful and accurate." + OVERRIDE;
    case 'creative': return 'You are Grok4 in Creative mode. Think laterally: offer imaginative, original, out-of-the-box ideas, vivid analogies, and unexpected angles, while keeping the underlying substance accurate and useful.' + OVERRIDE;
    case 'precise':  return 'You are Grok4 in Precise mode. Prioritize accuracy and clarity: give well-structured, detailed, factual answers in complete sentences. Be thorough and specific, define key terms, and avoid humor, hedging, and filler.' + OVERRIDE;
    case 'caveman':  return 'You are Grok4 in Caveman mode. Talk like primitive caveman: very short, blunt sentences. Few words. Drop "the", "a", "is", and filler. Grunt-style speech — but answer must still be correct, efficient, and effective. Example: "Code broke. Missing comma line 5. Add comma. Fixed. Good."' + OVERRIDE;
    default:         return 'You are Grok4, a helpful AI assistant by xAI. Write clear, well-structured responses in full sentences with a light touch of wit when it fits.' + OVERRIDE;
  }
}

// A short, recency-weighted style directive appended to ONLY the latest user
// message. The system prompt sets the persona, but when a conversation was
// started in one style (e.g. caveman) the model tends to keep imitating its own
// earlier replies. Putting the directive on the most recent turn — the highest-
// weighted position — reliably overrides that without touching the history.
function buildGrokSteer(mode) {
  switch (mode) {
    case 'fun':      return '[Answer THIS message in Fun mode: witty and playful with jokes — ignore the style of earlier replies.]';
    case 'creative': return '[Answer THIS message in Creative mode: imaginative and out-of-the-box — ignore the style of earlier replies.]';
    case 'precise':  return '[Answer THIS message in Precise mode: detailed, well-structured, factual, no filler — ignore the style of earlier replies.]';
    case 'caveman':  return '[Answer THIS message in Caveman mode: very short, blunt, primitive grunt-speech — ignore the style of earlier replies.]';
    default:         return '[Answer THIS message in Normal mode: clear, well-structured full sentences — ignore the style of earlier replies.]';
  }
}

// Return a copy of `messages` with `steer` appended to the most recent user
// message. Only mutates plain-string content; never persisted (the renderer
// keeps its own history and re-sends it each request).
function appendSteer(messages, steer) {
  if (!steer || !Array.isArray(messages) || messages.length === 0) return messages;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') { idx = i; break; }
  }
  if (idx === -1 || typeof messages[idx].content !== 'string') return messages;
  const copy = messages.slice();
  copy[idx] = { ...copy[idx], content: `${copy[idx].content}\n\n${steer}` };
  return copy;
}

// Resolve the `grok` CLI binary. The Electron process can have a stale PATH
// (the user often installs grok mid-session, which appends ~/.grok/bin to the
// *user* PATH only). So we check an explicit override, then the canonical
// install location, then fall back to the bare command for the OS to resolve.
let _grokBinCache;
function resolveGrokBin() {
  if (_grokBinCache !== undefined) return _grokBinCache;
  const override = (process.env.AIOS_GROK_BIN || '').trim();
  const candidates = [];
  if (override) candidates.push(override);
  const home = os.homedir();
  if (home) {
    candidates.push(path.join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'));
  }
  for (const c of candidates) {
    try { if (fsSync.existsSync(c)) { _grokBinCache = c; return c; } } catch {}
  }
  // Last resort: let the OS PATH-resolve it (works if grok is on PATH).
  _grokBinCache = process.platform === 'win32' ? 'grok.exe' : 'grok';
  return _grokBinCache;
}

// Resolve the `gemini` CLI binary (Google's open-source Gemini CLI, installed
// via `npm i -g @google/gemini-cli`). Same stale-PATH problem as grok: the npm
// global bin dir may not be on the Electron process PATH. Check an explicit
// override, then the canonical npm global location, then fall back to the bare
// command for the OS to resolve. On Windows the npm shim is a `.cmd`, so the
// agent route spawns it with shell:true.
let _geminiBinCache;
function resolveGeminiBin() {
  if (_geminiBinCache !== undefined) return _geminiBinCache;
  const override = (process.env.AIOS_GEMINI_BIN || '').trim();
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'gemini.cmd' : 'gemini';
  const candidates = [];
  if (override) candidates.push(override);
  const home = os.homedir();
  if (home && isWin) {
    candidates.push(path.join(home, 'AppData', 'Roaming', 'npm', exe));
  }
  for (const c of candidates) {
    try { if (fsSync.existsSync(c)) { _geminiBinCache = c; return c; } } catch {}
  }
  // Last resort: let the OS PATH-resolve it (works if gemini is on PATH).
  _geminiBinCache = exe;
  return _geminiBinCache;
}

// Kill a spawned CLI child ONLY on a genuine client disconnect. `req.on('close')`
// fires as soon as the request body is fully read (Node behavior), even though
// the connection is still open and we're mid-response — killing on that alone
// SIGTERMs the CLI almost instantly. So gate on the response socket actually
// being gone and us not having finished writing the response.
function killChildIfDisconnected(res, child) {
  const sock = res.socket;
  const reallyGone = !!sock && (sock.destroyed || sock.writable === false);
  if (!res.writableEnded && reallyGone && child && !child.killed) {
    try { child.kill(); } catch { /* already gone */ }
  }
}

function normalizeHermesBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function hermesRootUrl(baseUrl) {
  return normalizeHermesBaseUrl(baseUrl).replace(/\/v1$/i, '');
}

async function fetchHermes(pathname, options = {}) {
  const baseUrl = normalizeHermesBaseUrl(getProviderKey('hermes_base_url'));
  const apiKey = getProviderKey('hermes_api_key');
  if (!baseUrl) throw new Error('Hermes base URL is not configured.');
  if (!apiKey) throw new Error('Hermes API key is not configured.');

  // `/health` and the `/api/*` admin routes (jobs, sessions) live at the server
  // root, not under the OpenAI-compatible `/v1` prefix.
  const rootRelative = pathname.startsWith('/health') || pathname.startsWith('/api/');
  const root = rootRelative ? hermesRootUrl(baseUrl) : baseUrl;
  const response = await fetch(`${root}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { text }; }
  }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error || data?.message || text || response.statusText;
    throw new Error(`Hermes ${response.status}: ${detail}`);
  }
  return data;
}

function extractOpenAIText(completion) {
  const message = completion?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      return '';
    }).join('');
  }
  return '';
}

function extractJsonFromText(text) {
  if (typeof text !== 'string' || !text.length) return null;
  const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
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
        try { return JSON.parse(cleaned.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

// Hermes exposes a direct, deterministic cron REST API under `/api/jobs`.
// We call it straight rather than asking the chat model to drive the cronjob
// tool — routing prompts through an LLM was rewording them on every save/list.
//
//   GET    /api/jobs              -> { jobs: [...] }
//   GET    /api/jobs/{id}         -> { job: {...} }
//   POST   /api/jobs              -> { job: {...} }   (create)
//   PATCH  /api/jobs/{id}         -> { job: {...} }   (update)
//   DELETE /api/jobs/{id}         -> { ok: true }
//   POST   /api/jobs/{id}/pause | /resume | /run

// Translate Hermes's job object into the flat shape the AIOS UI expects.
function hermesJobToAios(job) {
  if (!job || typeof job !== 'object') return null;
  const sched = job.schedule;
  const schedule =
    typeof sched === 'string' ? sched
    : (sched && typeof sched === 'object' ? (sched.expr || sched.display || '') : '')
    || job.schedule_display || '';
  const repeat = job.repeat;
  const repeatTimes =
    repeat && typeof repeat === 'object' ? (repeat.times ?? null)
    : (typeof repeat === 'number' ? repeat : null);
  const runCount =
    repeat && typeof repeat === 'object' && typeof repeat.completed === 'number' ? repeat.completed
    : (typeof job.run_count === 'number' ? job.run_count : 0);
  let state = job.state || '';
  if (!state) state = job.enabled === false ? 'paused' : 'scheduled';
  return {
    id: job.id,
    name: job.name || '',
    prompt: job.prompt || '',
    schedule,
    skills: Array.isArray(job.skills) ? job.skills : [],
    deliver: job.deliver || '',
    repeat: repeatTimes,
    state,
    next_run: job.next_run_at || job.next_run || null,
    next_run_at: job.next_run_at || null,
    run_count: runCount,
    created_at: job.created_at || null,
    provider: job.provider ?? null,
    model: job.model ?? null,
    script: job.script ?? null,
    workdir: job.workdir ?? null,
    enabled: job.enabled !== false,
  };
}

// Build the request body for create (POST) / update (PATCH) from an AIOS draft.
// Only include fields that were actually provided so PATCH stays partial.
function aiosJobToHermesBody(job) {
  const body = {};
  if (typeof job.name === 'string') body.name = job.name;
  if (typeof job.prompt === 'string') body.prompt = job.prompt;
  if (typeof job.schedule === 'string' && job.schedule.trim()) body.schedule = job.schedule.trim();
  if (Array.isArray(job.skills)) body.skills = job.skills;
  if (typeof job.deliver === 'string' && job.deliver.trim()) body.deliver = job.deliver.trim();
  if (job.provider) body.provider = job.provider;
  if (job.model) body.model = job.model;
  if (job.script) body.script = job.script;
  if (job.workdir) body.workdir = job.workdir;
  const repeat = job.repeat === '' ? null : job.repeat;
  if (repeat !== null && repeat !== undefined && Number.isFinite(Number(repeat))) {
    body.repeat = Number(repeat);
  }
  return body;
}

function start() {
  const app = express();
  app.use(cors);
  app.use(express.json({ limit: '20mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/hermes/config', (_req, res) => {
    const baseUrl = normalizeHermesBaseUrl(getProviderKey('hermes_base_url'));
    const apiKey = getProviderKey('hermes_api_key');
    res.json({
      baseUrl,
      hasApiKey: !!apiKey,
      apiKeyPreview: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '',
      model: getModelId('hermes'),
    });
  });

  app.post('/api/hermes/config', (req, res) => {
    const { baseUrl, apiKey, model } = req.body || {};
    const nextBaseUrl = normalizeHermesBaseUrl(baseUrl);
    if (!nextBaseUrl) return res.status(400).json({ error: 'Hermes base URL is required.' });
    if (!/^https?:\/\//i.test(nextBaseUrl)) return res.status(400).json({ error: 'Hermes base URL must start with http:// or https://.' });
    setProviderKey('hermes_base_url', nextBaseUrl);
    if (typeof apiKey === 'string' && apiKey.trim()) setProviderKey('hermes_api_key', apiKey.trim());
    if (typeof model === 'string' && model.trim()) setModelId('hermes', model.trim());
    res.json({ ok: true, baseUrl: nextBaseUrl, hasApiKey: !!getProviderKey('hermes_api_key'), model: getModelId('hermes') });
  });

  app.get('/api/hermes/health', async (_req, res) => {
    try {
      res.json(await fetchHermes('/health/detailed'));
    } catch (err) {
      res.status(502).json({ error: err?.message || 'Hermes health check failed.' });
    }
  });

  app.get('/api/hermes/models', async (_req, res) => {
    try {
      res.json(await fetchHermes('/models'));
    } catch (err) {
      res.status(502).json({ error: err?.message || 'Hermes models check failed.' });
    }
  });

  app.get('/api/hermes/capabilities', async (_req, res) => {
    try {
      res.json(await fetchHermes('/capabilities'));
    } catch (err) {
      res.status(502).json({ error: err?.message || 'Hermes capabilities check failed.' });
    }
  });

  app.post('/api/hermes/chat', async (req, res) => {
    try {
      const { messages = [], model } = req.body || {};
      if (!Array.isArray(messages) || !messages.length) {
        return res.status(400).json({ error: 'messages must be a non-empty array.' });
      }
      const completion = await fetchHermes('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: model || getModelId('hermes'),
          messages,
          stream: false,
        }),
      });
      res.json({ content: extractOpenAIText(completion), raw: completion });
    } catch (err) {
      res.status(502).json({ error: err?.message || 'Hermes chat failed.' });
    }
  });

  app.get('/api/hermes/cron/jobs', async (_req, res) => {
    try {
      // include_disabled keeps paused jobs in the list so the UI can re-enable them.
      const data = await fetchHermes('/api/jobs?include_disabled=true', { method: 'GET' });
      const jobs = Array.isArray(data?.jobs) ? data.jobs.map(hermesJobToAios).filter(Boolean) : [];
      res.json({ jobs });
    } catch (err) {
      res.status(502).json({ error: err?.message || 'Failed to list Hermes cron jobs.' });
    }
  });

  app.post('/api/hermes/cron/jobs', async (req, res) => {
    try {
      const job = req.body || {};
      const id = typeof job.id === 'string' ? job.id.trim() : '';
      const body = aiosJobToHermesBody(job);
      const data = id
        ? await fetchHermes(`/api/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await fetchHermes('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
      res.json({ ok: true, job: hermesJobToAios(data?.job), message: id ? 'updated' : 'created' });
    } catch (err) {
      res.status(502).json({ error: err?.message || 'Failed to save Hermes cron job.' });
    }
  });

  app.post('/api/hermes/cron/jobs/:jobId/:action', async (req, res) => {
    try {
      const action = String(req.params.action || '').toLowerCase();
      if (!['pause', 'resume', 'run', 'remove'].includes(action)) {
        return res.status(400).json({ error: 'Unsupported cron action.' });
      }
      const jobId = String(req.params.jobId || '').trim();
      const path = `/api/jobs/${encodeURIComponent(jobId)}`;
      if (action === 'remove') {
        await fetchHermes(path, { method: 'DELETE' });
        return res.json({ ok: true, job: null, message: 'removed' });
      }
      const data = await fetchHermes(`${path}/${action}`, { method: 'POST' });
      res.json({ ok: true, job: hermesJobToAios(data?.job) || null, message: `${action} requested` });
    } catch (err) {
      res.status(502).json({ error: err?.message || 'Failed to update Hermes cron job.' });
    }
  });

  app.post('/api/hermes/cron/draft', async (req, res) => {
    try {
      const { field, currentValue = '', hint = '', job = {}, authMode } = req.body || {};
      if (!field) return res.status(400).json({ error: 'Missing `field`.' });

      const sysParts = [
        'You help draft Hermes cron jobs.',
        'Hermes cron jobs run a prompt on a schedule and may attach installed Hermes skill names.',
        'Hermes skills are Hermes-native skill folders, not Anthropic skills.',
        'Return ONLY the requested value. No markdown fences, no commentary.',
      ];

      if (field === 'name') {
        sysParts.push('Return a concise kebab-case or short title-style job name, under 60 characters.');
      } else if (field === 'prompt') {
        sysParts.push('Return a complete task prompt for the scheduled Hermes run. Be specific about inputs, output format, constraints, and what to report.');
      } else if (field === 'schedule') {
        sysParts.push('Return ONLY a five-field cron expression: minute hour day-of-month month day-of-week. Example: 0 9 * * * for daily at 9:00 AM.');
      } else if (field === 'skills') {
        sysParts.push('Return ONLY a JSON array of likely Hermes skill names. Use [] if no specific installed skill is clearly needed.');
      } else if (field === 'all') {
        sysParts.push('Return ONLY JSON: { "name": string, "prompt": string, "schedule": string, "skills": string[], "deliver": "local"|"origin" }. Schedule must be five-field cron.');
      } else {
        return res.status(400).json({ error: `Unknown field "${field}".` });
      }

      const ctxLines = [
        `Existing name: ${job.name || '(blank)'}`,
        `Existing schedule: ${job.schedule || '(blank)'}`,
        `Existing prompt: ${job.prompt || '(blank)'}`,
        Array.isArray(job.skills) && job.skills.length ? `Existing skills: ${job.skills.join(', ')}` : '',
        job.workdir ? `Working directory: ${job.workdir}` : '',
        job.script ? `Script: ${job.script}` : '',
        currentValue ? `Current value:\n${currentValue}` : '',
        hint ? `User hint: ${hint}` : '',
      ].filter(Boolean);
      const userPrompt = `Context:\n${ctxLines.join('\n')}\n\nDraft the value for "${field}" now.`;

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
        const modelId = getModelId('claude') || getModelId('anthropic') || 'claude-opus-4-8';
        const response = await client.messages.create({
          model: modelId,
          max_tokens: 1200,
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
      console.error('Hermes cron draft error:', err);
      if (!res.headersSent) res.status(500).json({ error: err?.message || 'Hermes cron draft failed.' });
    }
  });

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
      return { model: client(getModelId('grok')), system: buildGrokSystemPrompt({ showReasoning, mode }), steer: buildGrokSteer(mode) };
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
      const { messages = [], variant, context } = req.body || {};
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
          systemPrompt: withContext('You are a helpful AI assistant. Respond conversationally and concisely.', context),
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
        const modelId = getModelId('claude') || getModelId('anthropic') || 'claude-opus-4-8';
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
        const modelId = getModelId('claude') || getModelId('anthropic') || 'claude-opus-4-8';
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

  // --- Project save/load: <projectRoot>/.aios/project.json ---
  // A self-contained snapshot of a board (cards + layout), the agents it uses,
  // Maestro settings, and a light run-history summary. Lets you point the board
  // at a folder, build it out, save, then move on to the next project folder.
  app.post('/api/project/save', async (req, res) => {
    try {
      const { projectRoot, project } = req.body || {};
      if (!projectRoot || typeof projectRoot !== 'string') {
        return res.status(400).json({ error: 'Missing projectRoot.' });
      }
      if (!project || typeof project !== 'object') {
        return res.status(400).json({ error: 'Missing project payload.' });
      }
      const dir = path.resolve(projectRoot, '.aios');
      const file = path.join(dir, 'project.json');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(project, null, 2), 'utf8');
      res.json({ path: file });
    } catch (err) {
      console.error('project save error:', err);
      res.status(500).json({ error: err?.message || 'Failed to save project.' });
    }
  });

  app.post('/api/project/load', async (req, res) => {
    try {
      const { projectRoot } = req.body || {};
      if (!projectRoot || typeof projectRoot !== 'string') {
        return res.status(400).json({ error: 'Missing projectRoot.' });
      }
      const file = path.resolve(projectRoot, '.aios', 'project.json');
      let raw;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (e) {
        if (e?.code === 'ENOENT') return res.json({ exists: false });
        throw e;
      }
      let project;
      try {
        project = JSON.parse(raw);
      } catch {
        return res.status(422).json({ error: 'project.json is not valid JSON.' });
      }
      res.json({ exists: true, project, path: file });
    } catch (err) {
      console.error('project load error:', err);
      res.status(500).json({ error: err?.message || 'Failed to load project.' });
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
        const modelId = getModelId('claude') || getModelId('anthropic') || 'claude-opus-4-8';
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

  // --- Skills: write/delete .claude/skills/<name>/SKILL.md ---
  // Skills are a *folder* per skill (Claude Code skill format): a SKILL.md with
  // name/description frontmatter + instructions body, plus any supporting files
  // the author adds via the IDE editor. We only create/replace SKILL.md here;
  // supporting files are managed through the /api/fs/* endpoints below.
  app.post('/api/skills/write-md', async (req, res) => {
    try {
      const { slug, workingDir, markdown } = req.body || {};
      if (!slug || !workingDir || typeof markdown !== 'string') {
        return res.status(400).json({ error: 'Missing slug, workingDir, or markdown.' });
      }
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Slug must be lowercase alphanumeric + dashes.' });
      }
      const safeSlug = slug.slice(0, 60);
      const dir = path.resolve(workingDir, '.claude', 'skills', safeSlug);
      const file = path.join(dir, 'SKILL.md');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, markdown, 'utf8');
      res.json({ path: file, dir });
    } catch (err) {
      console.error('skill write-md error:', err);
      res.status(500).json({ error: err?.message || 'Failed to write skill file.' });
    }
  });

  app.post('/api/skills/delete-md', async (req, res) => {
    try {
      const { slug, workingDir } = req.body || {};
      if (!slug || !workingDir) return res.status(400).json({ error: 'Missing slug or workingDir.' });
      if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Bad slug.' });
      // Remove the whole skill folder (SKILL.md + any supporting files).
      const dir = path.resolve(workingDir, '.claude', 'skills', slug.slice(0, 60));
      try { await fs.rm(dir, { recursive: true, force: true }); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
      res.json({ ok: true });
    } catch (err) {
      console.error('skill delete-md error:', err);
      res.status(500).json({ error: err?.message || 'Failed to delete skill folder.' });
    }
  });

  // Per-field AI assist for the Skill Builder (mirrors /api/agents/draft).
  app.post('/api/skills/draft', async (req, res) => {
    try {
      const { field, currentValue = '', hint = '', skill = {}, authMode } = req.body || {};
      if (!field) return res.status(400).json({ error: 'Missing `field`.' });

      const sysParts = [
        'You are an expert at authoring Claude Code Skills (reusable SKILL.md capability packs).',
        'You are filling in a single field of a skill definition based on the existing partial config.',
        'Return ONLY the new field value, no commentary, no markdown fences.',
      ];

      let fieldGuidance = '';
      if (field === 'description') {
        fieldGuidance = 'Return a 1-sentence description (under 200 chars) stating what the skill does and, crucially, WHEN Claude should use it (trigger conditions). This is what Claude reads to decide whether to load the skill.';
      } else if (field === 'instructions') {
        fieldGuidance = 'Return the body of a SKILL.md (markdown is encouraged here): a focused set of instructions, steps, and guidance Claude should follow when the skill is active. Be concrete and procedural. No YAML frontmatter — just the body.';
      } else if (field === 'tools') {
        fieldGuidance = 'Return ONLY a JSON array of tool names this skill needs (subset of: Read, Glob, Grep, Edit, Write, Bash, WebFetch, WebSearch). Be conservative. Example: ["Read","Grep"]';
      } else if (field === 'all') {
        fieldGuidance = 'Return a JSON object: { "description": "...", "instructions": "...", "tools": ["..."] }. Same constraints as the individual fields.';
      } else {
        return res.status(400).json({ error: `Unknown field "${field}".` });
      }
      sysParts.push(fieldGuidance);

      const ctxLines = [
        `Skill name: ${skill.name || '(unnamed)'}`,
        skill.description ? `Description: ${skill.description}` : '',
        skill.instructions ? `Instructions so far: ${skill.instructions}` : '',
        Array.isArray(skill.allowedTools) && skill.allowedTools.length ? `Allowed tools so far: ${skill.allowedTools.join(', ')}` : '',
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
        const modelId = getModelId('claude') || getModelId('anthropic') || 'claude-opus-4-8';
        const response = await client.messages.create({
          model: modelId,
          max_tokens: 1536,
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
      console.error('skill draft error:', err);
      if (!res.headersSent) res.status(500).json({ error: err?.message || 'Skill draft failed.' });
    }
  });

  // --- IDE file ops: sandboxed read/write/list under a .claude/* folder ---
  // Powers the "Editor" mode of the Agent/Skill creators. Every op takes an
  // absolute `root` (the agent/skill folder) plus a `relPath` within it. To
  // keep this from becoming an arbitrary-filesystem API, `root` MUST contain a
  // `.claude` path segment, and the resolved target MUST stay inside `root`.
  const FS_MAX_ENTRIES = 2000;
  function resolveClaudeTarget(root, relPath = '') {
    if (!root || typeof root !== 'string') throw Object.assign(new Error('Missing root.'), { status: 400 });
    const normRoot = path.resolve(root);
    const segs = normRoot.split(/[\\/]+/);
    if (!segs.includes('.claude')) {
      throw Object.assign(new Error('root must live under a .claude folder.'), { status: 400 });
    }
    const target = path.resolve(normRoot, relPath || '');
    const rel = path.relative(normRoot, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw Object.assign(new Error('Path escapes the sandbox root.'), { status: 400 });
    }
    return { normRoot, target };
  }

  async function buildTree(absDir, relBase, budget) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (e) {
      if (e?.code === 'ENOENT') return [];
      throw e;
    }
    entries.sort((a, b) => {
      // dirs first, then files, each alphabetical
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const out = [];
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      if (budget.count >= FS_MAX_ENTRIES) break;
      budget.count++;
      const relPath = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        out.push({
          name: ent.name,
          path: relPath,
          type: 'dir',
          children: await buildTree(path.join(absDir, ent.name), relPath, budget),
        });
      } else if (ent.isFile()) {
        out.push({ name: ent.name, path: relPath, type: 'file' });
      }
    }
    return out;
  }

  app.post('/api/fs/tree', async (req, res) => {
    try {
      const { root } = req.body || {};
      const { normRoot } = resolveClaudeTarget(root);
      const budget = { count: 0 };
      const tree = await buildTree(normRoot, '', budget);
      res.json({ root: normRoot, tree, truncated: budget.count >= FS_MAX_ENTRIES });
    } catch (err) {
      res.status(err?.status || 500).json({ error: err?.message || 'Failed to read tree.' });
    }
  });

  app.post('/api/fs/read', async (req, res) => {
    try {
      const { root, relPath } = req.body || {};
      const { target } = resolveClaudeTarget(root, relPath);
      const stat = await fs.stat(target);
      if (!stat.isFile()) return res.status(400).json({ error: 'Not a file.' });
      if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'File too large to edit here (>2 MB).' });
      const buf = await fs.readFile(target);
      // Reject binary-ish content so Monaco doesn't choke on a blob.
      if (buf.includes(0)) return res.status(415).json({ error: 'Binary file — not editable.' });
      res.json({ content: buf.toString('utf8') });
    } catch (err) {
      if (err?.code === 'ENOENT') return res.status(404).json({ error: 'File not found.' });
      res.status(err?.status || 500).json({ error: err?.message || 'Failed to read file.' });
    }
  });

  app.post('/api/fs/write', async (req, res) => {
    try {
      const { root, relPath, content } = req.body || {};
      if (typeof content !== 'string') return res.status(400).json({ error: 'Missing content.' });
      const { target } = resolveClaudeTarget(root, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      res.json({ ok: true, path: target });
    } catch (err) {
      res.status(err?.status || 500).json({ error: err?.message || 'Failed to write file.' });
    }
  });

  app.post('/api/fs/create', async (req, res) => {
    try {
      const { root, relPath, kind = 'file' } = req.body || {};
      if (!relPath) return res.status(400).json({ error: 'Missing relPath.' });
      const { target } = resolveClaudeTarget(root, relPath);
      if (kind === 'dir') {
        await fs.mkdir(target, { recursive: true });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        // Don't clobber an existing file.
        const fh = await fs.open(target, 'wx').catch(e => { if (e?.code === 'EEXIST') return null; throw e; });
        if (!fh) return res.status(409).json({ error: 'A file with that name already exists.' });
        await fh.close();
      }
      res.json({ ok: true, path: target });
    } catch (err) {
      res.status(err?.status || 500).json({ error: err?.message || 'Failed to create entry.' });
    }
  });

  app.post('/api/fs/delete', async (req, res) => {
    try {
      const { root, relPath } = req.body || {};
      if (!relPath) return res.status(400).json({ error: 'Missing relPath.' });
      const { normRoot, target } = resolveClaudeTarget(root, relPath);
      if (target === normRoot) return res.status(400).json({ error: 'Refusing to delete the root folder here.' });
      await fs.rm(target, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(err?.status || 500).json({ error: err?.message || 'Failed to delete entry.' });
    }
  });

  app.post('/api/fs/rename', async (req, res) => {
    try {
      const { root, relPath, newRelPath } = req.body || {};
      if (!relPath || !newRelPath) return res.status(400).json({ error: 'Missing relPath or newRelPath.' });
      const { target: from } = resolveClaudeTarget(root, relPath);
      const { target: to } = resolveClaudeTarget(root, newRelPath);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      res.json({ ok: true, path: to });
    } catch (err) {
      res.status(err?.status || 500).json({ error: err?.message || 'Failed to rename entry.' });
    }
  });

  // --- Agent runs: actually execute an agent against a card ---
  // Streams the Vercel AI data-stream protocol so the renderer can chunk text
  // into the card's transcript live. Tool calls and tool results are formatted
  // inline as plain text deltas (no separate stream channel) to keep the UI
  // simple. The Manager / per-card Cancel button hits /api/agents/run/cancel
  // which signals the AbortController held in `activeRuns`.

  const activeRuns = new Map(); // runId -> AbortController
  const activeDeepRuns = new Map(); // deep-research runId -> AbortController

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

      writeText(`• Agent: ${agent.name || agent.slug}\n• Model: ${modelOverride || 'inherit'}\n• Tools: ${allowed.join(', ') || '(none)'}\n• Skills: all installed (~/.claude/skills + project)\n• Cwd: ${cwd || '(default)'}\n\n`);

      const stream = query({
        prompt: taskPrompt,
        options: {
          model: modelOverride,
          systemPrompt: agent.systemPrompt,
          allowedTools: allowed,
          // Make every installed skill discoverable + invocable by any board
          // agent. Per the Agent SDK, `skills: 'all'` is the single switch that
          // turns skills on — it also wires the Skill tool, so we don't add it
          // to each agent's allowedTools. settingSources loads ~/.claude (user)
          // and the project's .claude (skills, subagents, CLAUDE.md).
          skills: 'all',
          settingSources: ['user', 'project'],
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
        const modelId = getModelId('claude') || getModelId('anthropic') || 'claude-opus-4-8';
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
      const { messages = [], context } = req.body || {};
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

      // Codex has no separate system channel here, so prepend any background
      // context (e.g. a Deep Research report) ahead of the conversation.
      const ctxPrefix = typeof context === 'string' && context.trim() ? `${context.trim()}\n\n` : '';
      const streamed = await thread.runStreamed(`${ctxPrefix}${prompt}`);

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

  // --- Grok CLI agent chat (uses local `grok` CLI subscription auth, not API key) ---
  // Requires Grok Build installed and logged in: `grok login`.
  // The renderer routes here when the user picks "Grok subscription" auth in Models tab.
  //
  // We spawn the CLI headless (`grok --single … --output-format streaming-json`)
  // and translate its NDJSON event stream into the Vercel AI data-stream protocol:
  //   {"type":"thought","data":…} → reasoning tokens (surfaced only when showReasoning)
  //   {"type":"text","data":…}    → answer tokens
  //   {"type":"end",…}            → turn complete
  app.post('/api/grok-agent/chat', async (req, res) => {
    let child = null;
    try {
      const { messages = [], showReasoning = false, mode = 'normal', context } = req.body || {};
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user') {
        return res.status(400).json({ error: 'Last message must be from user.' });
      }

      const history = messages.slice(0, -1).map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
      ).join('\n\n');
      // Recency reinforcement so a mid-conversation persona switch overrides the
      // style of earlier replies (see appendSteer / buildGrokSteer).
      const steeredLast = `${last.content}\n\n${buildGrokSteer(mode)}`;
      const prompt = history ? `${history}\n\nUser: ${steeredLast}` : steeredLast;

      // Reasoning is delivered via real `thought` events, so the system prompt
      // never needs the inline THINKING/ANSWER scaffold — pass showReasoning:false.
      // Any background context (e.g. a Deep Research report) is folded in too.
      const systemPrompt = withContext(buildGrokSystemPrompt({ showReasoning: false, mode }), context);

      // Grok Build with a grok.com login auto-selects the model for the plan.
      // Override with AIOS_GROK_MODEL (e.g. `grok-composer-2.5-fast`) if desired.
      const grokModelOverride = (process.env.AIOS_GROK_MODEL || '').trim();

      const args = [
        '--single', prompt,
        '--output-format', 'streaming-json',
        '--permission-mode', 'dontAsk',   // never block headless on tool approval
        '--no-memory',
        '--no-subagents',
        '--disable-web-search',
        '--system-prompt-override', systemPrompt,
      ];
      if (grokModelOverride) args.push('--model', grokModelOverride);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('x-vercel-ai-data-stream', 'v1');
      res.setHeader('Cache-Control', 'no-cache');

      child = spawn(resolveGrokBin(), args, {
        cwd: os.tmpdir(),               // neutral dir — behave like chat, not a repo agent
        windowsHide: true,
        env: process.env,
      });

      // Abort the CLI only on a genuine client disconnect (see helper — guards
      // against Node firing req 'close' as soon as the request body is read).
      req.on('close', () => killChildIfDisconnected(res, child));
      res.on('close', () => killChildIfDisconnected(res, child));

      let buf = '';
      let sawAnswer = false;
      let emittedReasoningHeader = false;
      let stderr = '';

      const handleEvent = (evt) => {
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'text' && typeof evt.data === 'string') {
          if (showReasoning && emittedReasoningHeader && !sawAnswer) {
            res.write(streamPart('text', '\n\n💡 **ANSWER:**\n'));
          }
          sawAnswer = true;
          res.write(streamPart('text', evt.data));
        } else if (evt.type === 'thought' && typeof evt.data === 'string' && showReasoning) {
          if (!emittedReasoningHeader) {
            res.write(streamPart('text', '🤔 **THINKING:**\n'));
            emittedReasoningHeader = true;
          }
          res.write(streamPart('text', evt.data));
        } else if (evt.type === 'error') {
          throw new Error(evt.message || evt.data || 'Grok stream error.');
        }
        // 'end' and tool/other events need no client output.
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          try { handleEvent(evt); } catch (e) {
            try { res.write(streamPart('error', e?.message || 'Grok error.')); } catch {}
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      child.on('error', (err) => {
        const message = /ENOENT/.test(err?.code || err?.message || '')
          ? 'Grok CLI not found. Install Grok Build and ensure `grok` is available (or set AIOS_GROK_BIN).'
          : (err?.message || 'Failed to launch Grok CLI.');
        if (!res.headersSent) res.status(500).json({ error: message });
        else { try { res.write(streamPart('error', message)); } catch {} res.end(); }
      });

      child.on('close', (code) => {
        // Flush any trailing buffered line.
        const tail = buf.trim();
        if (tail) {
          try { handleEvent(JSON.parse(tail)); } catch {}
        }
        if (code !== 0 && !sawAnswer) {
          const message = stderr.trim() || `Grok CLI exited with code ${code}.`;
          try { res.write(streamPart('error', message)); } catch {}
        }
        res.write(streamPart('finish_message', {
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0 },
        }));
        res.end();
      });
    } catch (err) {
      console.error('Grok CLI error:', err);
      if (child && !child.killed) try { child.kill(); } catch {}
      const message = err?.message || 'Grok CLI request failed.';
      if (!res.headersSent) res.status(500).json({ error: message });
      else { try { res.write(streamPart('error', message)); } catch {} res.end(); }
    }
  });

  // --- Gemini chat (Google AI Studio API key; model ID configurable via Models tab) ---
  // The renderer routes here when the user picks "API key" auth for Gemini.
  // Streams via @google/genai's generateContentStream, translated into the
  // Vercel AI data-stream protocol (same streamPart codes as the CLI routes).
  app.post('/api/gemini/chat', async (req, res) => {
    try {
      const { messages = [], context } = req.body || {};
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user') {
        return res.status(400).json({ error: 'Last message must be from user.' });
      }

      const key = getProviderKey('gemini');
      if (!key) return res.status(400).json({ error: 'Gemini key not configured. Add it in Models tab, or switch to subscription auth.' });

      const { GoogleGenAI } = await import('@google/genai');
      const client = new GoogleGenAI({ apiKey: key });
      const modelId = getModelId('gemini') || 'gemini-flash-latest';

      // Gemini uses 'model' for assistant turns; everything else is 'user'.
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content ?? '') }],
      }));
      const systemInstruction = withContext(
        'You are a helpful AI assistant. Respond conversationally and concisely.',
        context,
      );

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('x-vercel-ai-data-stream', 'v1');
      res.setHeader('Cache-Control', 'no-cache');

      const stream = await client.models.generateContentStream({
        model: modelId,
        contents,
        config: { systemInstruction },
      });
      for await (const chunk of stream) {
        const t = chunk.text;
        if (t) res.write(streamPart('text', t));
      }
      res.write(streamPart('finish_message', {
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
      }));
      res.end();
    } catch (err) {
      console.error('Gemini chat error:', err);
      const message = err?.message || 'Gemini request failed.';
      if (!res.headersSent) res.status(500).json({ error: message });
      else { try { res.write(streamPart('error', message)); } catch {} res.end(); }
    }
  });

  // --- Gemini CLI agent chat (uses local `gemini` CLI Google-account auth, not API key) ---
  // Requires the Gemini CLI installed and signed in: `npm i -g @google/gemini-cli`
  // then run `gemini` once to complete the Google OAuth login (free tier, or a
  // paid Gemini Code Assist / AI plan for higher limits).
  // The renderer routes here when the user picks "subscription" auth for Gemini.
  //
  // Interface (per docs/cli/headless.md + cli-reference.md, verified against the
  // installed CLI):
  //   - `-p/--prompt` FORCES non-interactive mode (without it, piped stdin can
  //     fall back to interactive and hang). The -p text is appended to stdin.
  //   - `-o/--output-format stream-json` emits newline-delimited events:
  //       {type:"init",...} {type:"message",role:"user"|"assistant",content,delta}
  //       {type:"result",status,stats} {type:"error",...}
  //     We relay assistant message content as text deltas (like the grok path).
  //   - `--approval-mode yolo` + `--skip-trust` so a stray tool call / untrusted
  //     cwd never downgrades approval and blocks headless.
  //   - `-m/--model` only when AIOS_GEMINI_MODEL is set; otherwise the plan picks
  //     (the OAuth tier auto-routes to current Gemini 3.x flash). NOTE the OAuth
  //     tier rejects AI-Studio-only names like `gemini-flash-latest` (404), so we
  //     never pass the Models-tab id here — that id drives the API-key path only.
  // The conversation (arbitrary user content) rides on STDIN, never argv, so the
  // only argv tokens are fixed flags + a constant directive — safe to quote for
  // the Windows `gemini.cmd` shell shim.
  app.post('/api/gemini-agent/chat', async (req, res) => {
    let child = null;
    try {
      const { messages = [], context } = req.body || {};
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user') {
        return res.status(400).json({ error: 'Last message must be from user.' });
      }

      const history = messages.slice(0, -1).map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
      ).join('\n\n');
      const preamble = withContext(
        'You are a helpful AI assistant. Respond conversationally and concisely.',
        context,
      );
      const convo = history
        ? `${preamble}\n\n${history}\n\nUser: ${last.content}`
        : `${preamble}\n\nUser: ${last.content}`;
      // Fixed directive carried in -p (forces non-interactive). The actual
      // conversation is appended via stdin, so no user content enters argv.
      const DIRECTIVE = 'Respond as the assistant to the conversation provided.';

      const geminiModelOverride = (process.env.AIOS_GEMINI_MODEL || '').trim();
      const flags = ['-o', 'stream-json', '--approval-mode', 'yolo', '--skip-trust', '-p', DIRECTIVE];
      if (geminiModelOverride) flags.push('-m', geminiModelOverride);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('x-vercel-ai-data-stream', 'v1');
      res.setHeader('Cache-Control', 'no-cache');

      const bin = resolveGeminiBin();
      const baseOpts = { cwd: os.tmpdir(), windowsHide: true, env: process.env };
      if (process.platform === 'win32') {
        // shell:true is needed to run the gemini.cmd npm shim, but Node does NOT
        // quote args under shell:true — it just space-joins them. So build one
        // pre-quoted command line ourselves (only fixed tokens are present).
        const q = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
        const cmdline = [q(bin), ...flags.map(q)].join(' ');
        child = spawn(cmdline, { ...baseOpts, shell: true });
      } else {
        child = spawn(bin, flags, { ...baseOpts, shell: false });
      }

      // Abort the CLI ONLY on a genuine client disconnect. `req.on('close')`
      // fires as soon as the request body is fully read (Node behavior), even
      // though the connection is still open and we're mid-response — killing on
      // that alone SIGTERMs the CLI ~instantly. So gate on the response socket
      // actually being gone (and us not having finished writing).
      req.on('close', () => killChildIfDisconnected(res, child));
      res.on('close', () => killChildIfDisconnected(res, child));

      let buf = '';
      let sawAnswer = false;
      let stderr = '';
      let resultError = '';

      const handleEvent = (evt) => {
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'message' && evt.role === 'assistant' && typeof evt.content === 'string') {
          sawAnswer = true;
          res.write(streamPart('text', evt.content));
        } else if (evt.type === 'result' && evt.status && evt.status !== 'success') {
          resultError = (evt.error && (evt.error.message || evt.error)) || String(evt.status);
        } else if (evt.type === 'error') {
          resultError = evt.message || (evt.error && (evt.error.message || evt.error)) || 'Gemini stream error.';
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          try { handleEvent(evt); } catch {}
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      child.on('error', (err) => {
        const message = /ENOENT/.test(err?.code || err?.message || '')
          ? 'Gemini CLI not found. Install it with `npm i -g @google/gemini-cli`, run `gemini` once to sign in (or set AIOS_GEMINI_BIN).'
          : (err?.message || 'Failed to launch Gemini CLI.');
        if (!res.headersSent) res.status(500).json({ error: message });
        else { try { res.write(streamPart('error', message)); } catch {} res.end(); }
      });

      child.on('close', (code, signal) => {
        // Flush any trailing buffered line (no newline at EOF).
        const tail = buf.trim();
        if (tail) { try { handleEvent(JSON.parse(tail)); } catch {} }
        if (!sawAnswer) {
          const errJson = extractJsonObject(stderr);
          const msg = resultError
            || (errJson && errJson.error && (errJson.error.message || errJson.error))
            || stderr.trim()
            || `Gemini CLI exited with code ${code}${signal ? ` (signal ${signal})` : ''}.`;
          try { res.write(streamPart('error', msg)); } catch {}
        }
        res.write(streamPart('finish_message', {
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0 },
        }));
        res.end();
      });

      // Feed the conversation via stdin, then close it so the CLI starts generating.
      try { child.stdin.setDefaultEncoding('utf8'); child.stdin.write(convo); child.stdin.end(); } catch {}
    } catch (err) {
      console.error('Gemini CLI error:', err);
      if (child && !child.killed) try { child.kill(); } catch {}
      const message = err?.message || 'Gemini CLI request failed.';
      if (!res.headersSent) res.status(500).json({ error: message });
      else { try { res.write(streamPart('error', message)); } catch {} res.end(); }
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

  // --- Embeddings: Gemini text embeddings, batched ---
  // The key lives here in main (encrypted keystore), so embedding never depends
  // on the renderer's in-memory key — which a hot-reload or boot race can wipe
  // mid-job. Accepts { contents: string[] }, returns { embeddings: number[][] }.
  // Upstream rate-limit / error statuses are propagated so the renderer can
  // back off and retry.
  app.post('/api/embeddings', async (req, res) => {
    try {
      const { contents } = req.body || {};
      if (!Array.isArray(contents) || contents.length === 0) {
        return res.status(400).json({ error: 'contents (non-empty array of strings) is required' });
      }
      const key = getProviderKey('gemini');
      if (!key) return res.status(400).json({ error: 'Gemini key not configured. Add it in the Models tab.' });

      const { GoogleGenAI } = await import('@google/genai');
      const client = new GoogleGenAI({ apiKey: key });
      const result = await client.models.embedContent({
        model: 'gemini-embedding-001',
        contents,
      });
      const embeddings = (result.embeddings || []).map(e => e.values || []);
      res.json({ embeddings });
    } catch (e) {
      // Surface the upstream HTTP status (notably 429) so the client backs off.
      let status = Number(e?.status);
      if (!Number.isFinite(status)) {
        const m = String(e?.message || '').match(/"code"\s*:\s*(\d{3})|\b(429|500|503)\b/);
        status = m ? Number(m[1] || m[2]) : 500;
      }
      if (!(status >= 400 && status < 600)) status = 500;
      console.error('Embeddings error:', e?.message || e);
      res.status(status).json({ error: e?.message || 'Embedding failed' });
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

  // --- DeepDive Deep Research: autonomous plan → search → read → synthesize ---
  // Streams newline-delimited JSON events (NDJSON): the renderer reads them with
  // a stream reader to render live progress, per-source cards, and the report.
  // Gemini grounds search + summarizes sources; Claude synthesizes the report.
  app.post('/api/research/deep', async (req, res) => {
    const { runId, query, breadth, depth, perQuery, concurrency, totalWords, authMode } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    const id = (typeof runId === 'string' && runId) ? runId : `deep-${Date.now()}`;
    const controller = new AbortController();
    activeDeepRuns.set(id, controller);

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    const emit = (event) => {
      if (res.writableEnded) return;
      try { res.write(JSON.stringify(event) + '\n'); } catch { /* client gone */ }
    };

    // If the client disconnects, abort the in-flight research. Listen on the
    // RESPONSE stream — `req`'s 'close' fires as soon as express.json() finishes
    // reading the POST body (i.e. immediately), which would abort every run.
    // `res` 'close' fires only when the response connection actually ends, and
    // the writableEnded guard means our own res.end() never counts as a cancel.
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      emit({ type: 'run', runId: id });
      const result = await deepResearch.runDeepResearch({
        query: query.trim(),
        breadth, depth, perQuery, concurrency, totalWords,
        authMode,
        signal: controller.signal,
        onEvent: emit,
      });
      // Final consolidated payload the renderer persists on the thread.
      emit({ type: 'result', result });
    } catch (err) {
      if (err?.canceled || controller.signal.aborted) {
        emit({ type: 'canceled' });
      } else {
        console.error('deep research error:', err);
        emit({ type: 'error', error: err?.message || 'Deep research failed.' });
      }
    } finally {
      activeDeepRuns.delete(id);
      if (!res.writableEnded) res.end();
    }
  });

  app.post('/api/research/deep/cancel', (req, res) => {
    const { runId } = req.body || {};
    const c = runId ? activeDeepRuns.get(runId) : null;
    if (c) { try { c.abort(); } catch {} }
    res.json({ canceled: !!c });
  });

  // --- DeepDive Deep Research: adversarial claim verification ---
  // Judges each cited claim in a finished report against its source summary.
  app.post('/api/research/verify', async (req, res) => {
    try {
      const { query, report, sources, authMode } = req.body || {};
      if (!report || !Array.isArray(sources)) {
        return res.status(400).json({ error: 'report and sources are required' });
      }
      const result = await deepResearch.verifyReport({ query: query || '', report, sources, authMode });
      res.json(result);
    } catch (e) {
      console.error('verify error:', e);
      res.status(400).json({ error: e?.message || 'Verification failed' });
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
