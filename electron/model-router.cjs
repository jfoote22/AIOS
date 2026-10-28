// One entry point for every AI task in AIOS. A feature asks for a task
// ("ocr", "vault-ask", ...); the router picks the model the user assigned to
// that task (or their default), and falls back to other connected models when
// that one fails. Shared by the desktop API server, the mobile gateway and the
// main-process services (snip OCR, Ask Second Brain, deep research).
//
// Connections:
//   claude   Anthropic — Claude Code login (Agent SDK) or API key
//   chatgpt  OpenAI    — ChatGPT login via Codex, or API key
//   grok     xAI       — Grok Build CLI login, or API key
//   gemini   Google    — Antigravity CLI login, or API key
//   hermes   Hermes Agent's OpenAI-compatible API server (Settings → Hermes)
//   <custom> any OpenAI-compatible endpoint the user added (Ollama, LM Studio,
//            OpenRouter, DeepSeek, Hugging Face, ...)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sqliteStore = require('./sqlite-store.cjs');
const routing = require('./model-routing.cjs');
const { getProviderKey } = require('./keystore.cjs');
const { getModelId } = require('./modelstore.cjs');
const { promptStream } = require('./agent-prompt.cjs');
const { noToolsPolicy, assertAgentResult } = require('./agent-policy.cjs');
const { loadClaudeSdk, codexOptions, codexExecutable } = require('./sdk-binaries.cjs');
const { resolveGrokBin, resolveGeminiBin } = require('./cli-bins.cjs');
const cliLogin = require('./cli-login.cjs');

// Order used when nothing is configured for a task (and for fallback).
const PRIORITY = ['claude', 'chatgpt', 'grok', 'gemini', 'hermes'];

const TASK_LABELS = {
  'vault-ask': 'Ask Second Brain',
  ocr: 'Reading screenshots',
  tagging: 'Filing and tagging notes',
  understanding: 'DeepDive topic maps',
  research: 'Deep research',
  drafting: 'Drafting',
  coding: 'Hermes → coding',
  general: 'Hermes → general work',
  planning: 'Hermes → organizing & planning',
};

// Same storage and defaults as src/lib/authMode.ts.
function authMode(provider) {
  let v = null;
  try { v = sqliteStore.call('getMeta', [`${provider}-auth-mode`]); } catch {}
  if (v === 'subscription' || v === 'api') return v;
  return provider === 'gemini' ? 'subscription' : 'api';
}

function binaryExists(p) {
  try { return path.isAbsolute(p) && fs.existsSync(p); } catch { return false; }
}

function shortError(e) {
  const raw = String(e?.message || e || 'failed');
  try { const j = JSON.parse(raw); return String(j?.error?.message || raw).slice(0, 300); } catch { return raw.slice(0, 300); }
}

// ── catalog ────────────────────────────────────────────────────────────────

function builtinConnections() {
  const claudeSub = authMode('anthropic') === 'subscription';
  const openaiSub = authMode('openai') === 'subscription';
  const grokSub = authMode('grok') === 'subscription';
  const geminiSub = authMode('gemini') === 'subscription';
  const hermesUrl = getProviderKey('hermes_base_url');
  const hermesKey = getProviderKey('hermes_api_key');
  const keyed = (id) => !!getProviderKey(id);
  return [
    {
      id: 'claude', label: 'Claude', kind: 'anthropic', auth: claudeSub ? 'subscription' : 'api',
      // The Agent SDK finds Claude Code itself; a missing login surfaces when it runs.
      available: claudeSub ? true : keyed('anthropic'),
      reason: claudeSub ? '' : 'Add an Anthropic key, or switch Claude to subscription (Claude Code login).',
      vision: true,
      models: [
        { id: getModelId('anthropic'), label: 'Sonnet' },
        { id: getModelId('claude'), label: 'Opus' },
        { id: getModelId('fable'), label: 'Fable' },
      ],
    },
    {
      id: 'chatgpt', label: 'ChatGPT', kind: 'openai', auth: openaiSub ? 'subscription' : 'api',
      available: openaiSub ? !!codexExecutable() : keyed('openai'),
      reason: openaiSub ? 'The Codex CLI that ships with AIOS is missing.' : 'Add an OpenAI key, or switch OpenAI to subscription (ChatGPT login via Codex).',
      vision: true,
      // Codex with a ChatGPT login chooses the model for the plan.
      models: openaiSub ? [{ id: '', label: 'Your ChatGPT plan' }] : [{ id: getModelId('openai'), label: getModelId('openai') }],
    },
    {
      id: 'grok', label: 'Grok', kind: grokSub ? 'grok-cli' : 'compat', auth: grokSub ? 'subscription' : 'api',
      available: grokSub ? binaryExists(resolveGrokBin()) : keyed('grok'),
      reason: grokSub ? 'Install Grok Build and run `grok login`.' : 'Add an xAI key, or switch Grok to subscription.',
      vision: !grokSub,
      baseUrl: 'https://api.x.ai/v1', keyId: 'grok',
      models: grokSub ? [{ id: '', label: 'Your Grok plan' }] : [{ id: getModelId('grok'), label: getModelId('grok') }],
    },
    {
      id: 'gemini', label: 'Gemini', kind: geminiSub ? 'agy-cli' : 'gemini', auth: geminiSub ? 'subscription' : 'api',
      available: geminiSub ? binaryExists(resolveGeminiBin()) : keyed('gemini'),
      reason: geminiSub ? 'Install the Antigravity CLI (agy) and sign in.' : 'Add a Gemini key, or switch Gemini to subscription.',
      vision: !geminiSub,
      models: geminiSub ? [{ id: '', label: 'Your Google plan' }] : [{ id: getModelId('gemini'), label: getModelId('gemini') }],
    },
    {
      id: 'hermes', label: 'Hermes', kind: 'compat', auth: 'url',
      available: !!(hermesUrl && hermesKey),
      reason: 'Set the Hermes API server URL and key in Settings → Hermes.',
      vision: false,
      baseUrl: (hermesUrl || '').replace(/\/+$/, ''), keyId: 'hermes_api_key',
      models: [{ id: getModelId('hermes'), label: getModelId('hermes') }],
    },
  ];
}

function customConnections(store) {
  return store.connections.map((c) => ({
    id: c.id, label: c.label, kind: 'compat', auth: 'url', custom: true,
    available: c.models.length > 0,
    reason: 'Add at least one model name to this connection.',
    vision: c.vision,
    baseUrl: c.baseUrl, keyId: `conn:${c.id}`, hasKey: !!getProviderKey(`conn:${c.id}`),
    models: c.models.map((m) => ({ id: m, label: m })),
  }));
}

/** Every connection with availability and models, for Settings and resolution. */
function catalog(store = routing.read()) {
  return [...builtinConnections(), ...customConnections(store)];
}

function describe(conn, modelId) {
  const m = conn.models.find((x) => x.id === modelId);
  return m && m.label && m.label !== conn.label ? `${conn.label} (${m.label})` : conn.label;
}

// ── resolution ─────────────────────────────────────────────────────────────

/**
 * Ordered models to try for a task: its own choice, then the default, then
 * (when fallback is on, or nothing was chosen) every other connected model.
 */
function candidates(task, { vision = false } = {}) {
  const store = routing.read();
  const conns = catalog(store);
  const byId = new Map(conns.map((c) => [c.id, c]));
  const out = [];
  const skipped = [];
  const seen = new Set();
  const add = (ref, explicit) => {
    const { connection, model } = routing.splitRef(ref);
    const conn = byId.get(connection);
    if (!conn) { if (explicit) skipped.push(`${ref}: connection was removed`); return; }
    if (!conn.available) { if (explicit) skipped.push(`${conn.label}: ${conn.reason}`); return; }
    if (vision && !conn.vision) { if (explicit) skipped.push(`${conn.label}: can't read images`); return; }
    const modelId = model || conn.models[0]?.id || '';
    const key = `${conn.id}:${modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ref: key, conn, model: modelId, label: describe(conn, modelId) });
  };
  const chosen = [store.tasks[task], store.default].filter(Boolean);
  for (const ref of chosen) add(ref, true);
  if (!chosen.length || store.fallback) {
    const ordered = [...conns].sort((a, b) => rank(a) - rank(b));
    for (const c of ordered) add(`${c.id}:`, false);
  }
  return { list: out, skipped };
}

function rank(conn) {
  const i = PRIORITY.indexOf(conn.id);
  return i < 0 ? PRIORITY.length : i;
}

function noModelError(task, vision, skipped) {
  const what = TASK_LABELS[task] || task;
  const need = vision ? 'a model that can read images' : 'a model';
  const why = skipped.length ? ` (${skipped.join('; ')})` : '';
  return new Error(`${what} needs ${need}. Connect one in Settings → Models${why}.`);
}

// ── adapters ───────────────────────────────────────────────────────────────

const JSON_HINT = '\n\nReply with a single JSON object and nothing else — no prose, no code fences.';

async function runAnthropic(c, { system, prompt, image, onDelta, signal }) {
  if (c.conn.auth === 'subscription') {
    const content = image
      ? [{ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }, { type: 'text', text: prompt }]
      : prompt;
    const { query } = await loadClaudeSdk();
    let full = '';
    for await (const msg of query({
      prompt: promptStream(content),
      options: { model: c.model, systemPrompt: system, ...noToolsPolicy() },
    })) {
      if (signal?.aborted) throw new Error('Canceled.');
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        const f = msg.message.content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
        if (f.length > full.length && f.startsWith(full)) onDelta?.(f.slice(full.length));
        if (f) full = f;
      } else if (msg.type === 'result') {
        assertAgentResult(msg);
        break;
      }
    }
    return full;
  }
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  return runAiSdk(createAnthropic({ apiKey: getProviderKey('anthropic') })(c.model), { system, prompt, image, onDelta, signal });
}

let codexScratch = null;
function codexWorkdir() {
  // Codex runs as a read-only agent; give it an empty folder of its own.
  if (!codexScratch) {
    codexScratch = path.join(os.tmpdir(), 'aios-codex-router');
    fs.mkdirSync(codexScratch, { recursive: true });
  }
  return codexScratch;
}

async function runOpenAI(c, { system, prompt, image, schema, onDelta, signal, effort = 'low' }) {
  if (c.conn.auth === 'subscription') {
    const { Codex } = await import('@openai/codex-sdk');
    const thread = new Codex(codexOptions()).startThread({
      sandboxMode: 'read-only',
      workingDirectory: codexWorkdir(),
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchEnabled: false,
      approvalPolicy: 'never',
      modelReasoningEffort: effort,
    });
    // Codex takes images as files and has no system channel.
    let imageFile = null;
    const text = system ? `${system}\n\n${prompt}` : prompt;
    let input = text;
    if (image) {
      const ext = image.mimeType.split('/')[1] === 'jpeg' ? 'jpg' : image.mimeType.split('/')[1];
      imageFile = path.join(codexWorkdir(), `image-${process.pid}-${Date.now()}.${ext}`);
      fs.writeFileSync(imageFile, Buffer.from(image.data, 'base64'));
      input = [{ type: 'local_image', path: imageFile }, { type: 'text', text }];
    }
    try {
      const streamed = await thread.runStreamed(input, { outputSchema: schema, signal });
      const sent = new Map();
      let reply = '';
      for await (const event of streamed.events) {
        if (event.type === 'item.updated' || event.type === 'item.completed') {
          const item = event.item;
          if (item?.type === 'agent_message' && typeof item.text === 'string') {
            const prev = sent.get(item.id) || 0;
            if (item.text.length > prev) { onDelta?.(item.text.slice(prev)); sent.set(item.id, item.text.length); }
            reply = item.text;
          }
        } else if (event.type === 'turn.completed') {
          break;
        } else if (event.type === 'turn.failed') {
          throw new Error(event.error?.message || 'ChatGPT turn failed.');
        } else if (event.type === 'error') {
          throw new Error(event.message || 'ChatGPT stream error.');
        }
      }
      return reply;
    } finally {
      if (imageFile) fs.rm(imageFile, { force: true }, () => {});
    }
  }
  const { createOpenAI } = await import('@ai-sdk/openai');
  return runAiSdk(createOpenAI({ apiKey: getProviderKey('openai') }).chat(c.model), { system, prompt, image, onDelta, signal });
}

async function runCompat(c, { system, prompt, image, onDelta, signal }) {
  const { createOpenAI } = await import('@ai-sdk/openai');
  // Local servers (Ollama, LM Studio) accept any key; the SDK insists on one.
  const apiKey = getProviderKey(c.conn.keyId) || 'not-needed';
  const provider = createOpenAI({ baseURL: c.conn.baseUrl, apiKey, name: c.conn.id });
  return runAiSdk(provider.chat(c.model), { system, prompt, image, onDelta, signal });
}

async function runAiSdk(model, { system, prompt, image, onDelta, signal }) {
  const ai = await import('ai');
  const content = image
    ? [{ type: 'file', data: image.data, mediaType: image.mimeType }, { type: 'text', text: prompt }]
    : [{ type: 'text', text: prompt }];
  const result = ai.streamText({
    model, system: system || undefined, messages: [{ role: 'user', content }],
    maxOutputTokens: 8192, maxRetries: 1, abortSignal: signal, onError: () => {},
  });
  let full = '';
  for await (const event of result.fullStream) {
    if (event.type === 'error') throw event.error instanceof Error ? event.error : new Error(shortError(event.error));
    if (event.type === 'abort') throw new Error('Canceled.');
    if (event.type === 'text-delta') { full += event.text; onDelta?.(event.text); }
  }
  return full;
}

async function runGemini(c, { system, prompt, image, json, onDelta, signal }) {
  const { GoogleGenAI } = await import('@google/genai');
  const parts = image ? [{ inlineData: { mimeType: image.mimeType, data: image.data } }, { text: prompt }] : [{ text: prompt }];
  const config = { systemInstruction: system || undefined, abortSignal: signal };
  if (json) config.responseMimeType = 'application/json';
  const stream = await new GoogleGenAI({ apiKey: getProviderKey('gemini') }).models.generateContentStream({
    model: c.model, contents: [{ role: 'user', parts }], config,
  });
  let full = '';
  for await (const chunk of stream) {
    if (chunk.text) { full += chunk.text; onDelta?.(chunk.text); }
  }
  return full;
}

// One-shot run of a subscription CLI; resolves with stdout text.
function runCli(bin, args, { parse, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), windowsHide: true, env: process.env, shell: false });
    let out = '';
    let err = '';
    const onAbort = () => { try { child.kill(); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Canceled.'));
      let text;
      try { text = parse(out); } catch (e) { return reject(e); }
      if (code === 0 && text) resolve(text);
      else reject(new Error(err.trim().split('\n').pop() || `exited with code ${code}`));
    });
  });
}

async function runGrokCli(c, { system, prompt, onDelta, signal }) {
  const args = ['--single', prompt, '--output-format', 'streaming-json', '--permission-mode', 'dontAsk',
    '--no-memory', '--no-subagents', '--disable-web-search'];
  if (system) args.push('--system-prompt-override', system);
  const events = (out) => out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const text = await runCli(resolveGrokBin(), args, {
    signal,
    parse: (out) => {
      const list = events(out);
      const err = list.find((e) => e?.type === 'error');
      // e.g. "Not signed in" — surface Grok's own message, not a bare exit code.
      if (err) throw new Error(String(err.message || err.data || 'Grok failed.').split('\n')[0]);
      return list.filter((e) => e?.type === 'text' && typeof e.data === 'string').map((e) => e.data).join('');
    },
  });
  onDelta?.(text);
  return text;
}

async function runAgyCli(c, { system, prompt, onDelta, signal }) {
  const text = await runCli(resolveGeminiBin(), ['--print', system ? `${system}\n\n${prompt}` : prompt], {
    signal, parse: (out) => out.trim(),
  });
  onDelta?.(text);
  return text;
}

const ADAPTERS = {
  anthropic: runAnthropic,
  openai: runOpenAI,
  compat: runCompat,
  gemini: runGemini,
  'grok-cli': runGrokCli,
  'agy-cli': runAgyCli,
};

/**
 * Run one candidate. A subscription CLI that turns out to be signed out gets
 * its sign-in opened in the browser: with other models left to try the
 * request moves on (sign-in continues for next time); with none it waits for
 * the sign-in and retries once.
 */
async function runCandidate(c, input, { moreToTry = false } = {}) {
  try {
    return await ADAPTERS[c.conn.kind](c, input);
  } catch (e) {
    const { signal } = input;
    if (c.conn.auth !== 'subscription' || !cliLogin.hasFlow(c.conn.id) || signal?.aborted) throw e;
    if (!(await cliLogin.isSignedOut(c.conn.id, e))) throw e;
    const login = cliLogin.ensureLogin(c.conn.id);
    if (moreToTry) throw new Error('not signed in — opened sign-in in your browser');
    const signedIn = await Promise.race([
      login,
      new Promise((resolve) => signal?.addEventListener('abort', () => resolve(false), { once: true })),
    ]);
    if (signal?.aborted) throw new Error('Canceled.');
    if (!signedIn) throw new Error(`not signed in, and the ${c.conn.label} sign-in didn't finish`);
    return ADAPTERS[c.conn.kind](c, input);
  }
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Run one AI task on the best available model.
 * @param {{ task: string, system?: string, prompt: string,
 *           image?: { mimeType: string, data: string },  // data is base64
 *           json?: boolean, schema?: object,             // schema: JSON Schema, used natively by Codex
 *           effort?: string, onDelta?: (t: string) => void, signal?: AbortSignal }} input
 * @returns {Promise<{ text: string, model: string, label: string }>}
 */
async function generate(input) {
  const { task, image, json, signal, onDelta } = input;
  const { list, skipped } = candidates(task, { vision: !!image });
  if (!list.length) throw noModelError(task, !!image, skipped);
  const system = json ? `${input.system || ''}${JSON_HINT}`.trim() : (input.system || '');
  const errors = [...skipped];
  for (const [i, c] of list.entries()) {
    let streamed = false;
    try {
      const text = await runCandidate(c, {
        ...input, system,
        onDelta: onDelta && ((t) => { if (t) { streamed = true; onDelta(t); } }),
      }, { moreToTry: i < list.length - 1 });
      if (!text || !text.trim()) throw new Error('returned no content');
      return { text, model: c.ref, label: c.label };
    } catch (e) {
      // Once text has reached the caller, switching models would garble it.
      if (streamed || signal?.aborted) throw e;
      errors.push(`${c.label}: ${shortError(e)}`);
    }
  }
  throw new Error(`No model could finish ${TASK_LABELS[task] || task}. ${errors.join(' · ')}`);
}

/**
 * Run on one specific model ("grok", "claude:claude-opus-5", ...), with no
 * routing or fallback — for when the caller (Hermes) names the model itself.
 */
async function generateOn(ref, input) {
  const { connection, model } = routing.splitRef(ref);
  const conn = catalog().find((c) => c.id === connection);
  if (!conn) throw new Error(`Unknown model "${ref}". Call list_models to see what's connected.`);
  if (!conn.available) throw new Error(`${conn.label} isn't set up: ${conn.reason}`);
  const modelId = model || conn.models[0]?.id || '';
  const c = { ref: `${conn.id}:${modelId}`, conn, model: modelId, label: describe(conn, modelId) };
  const text = await runCandidate(c, { ...input, system: input.system || '' });
  if (!text || !text.trim()) throw new Error(`${c.label} returned no content.`);
  return { text, model: c.ref, label: c.label };
}

/** Pull the first JSON object out of a model reply (tolerates fences/prose). */
function parseJsonReply(reply) {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON.');
  return JSON.parse(reply.slice(start, end + 1));
}

/** Can this task run right now? (For UI gating; doesn't check logins.) */
function hasModelFor(task, { vision = false } = {}) {
  return candidates(task, { vision }).list.length > 0;
}

// ── embeddings (server-side providers; 'local' runs in the renderer) ───────

async function embed(contents) {
  const { embeddings } = routing.read();
  if (embeddings === 'local') throw Object.assign(new Error('Local embeddings run in the app window.'), { status: 400 });
  if (embeddings === 'gemini') {
    const key = getProviderKey('gemini');
    if (!key) throw Object.assign(new Error('Gemini key not configured. Add it in Settings → Models, or switch embeddings to Built-in.'), { status: 400 });
    const { GoogleGenAI } = await import('@google/genai');
    const result = await new GoogleGenAI({ apiKey: key }).models.embedContent({ model: 'gemini-embedding-001', contents });
    return (result.embeddings || []).map((e) => e.values || []);
  }
  const { connection, model } = routing.splitRef(embeddings);
  const conn = catalog().find((c) => c.id === connection);
  if (!conn || conn.kind !== 'compat' || !conn.baseUrl) {
    throw Object.assign(new Error('The embeddings connection is missing. Pick another in Settings → Models.'), { status: 400 });
  }
  const res = await fetch(`${conn.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getProviderKey(conn.keyId) || 'not-needed'}` },
    body: JSON.stringify({ model, input: contents }),
  });
  if (!res.ok) throw Object.assign(new Error(`${conn.label} embeddings failed (HTTP ${res.status}).`), { status: res.status });
  const data = await res.json();
  return (data.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ── settings helpers ───────────────────────────────────────────────────────

/** List model names a connection's /models endpoint reports. */
async function detectModels({ baseUrl, apiKey, id }) {
  const key = apiKey || (id ? getProviderKey(`conn:${id}`) : '') || '';
  const url = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Base URL must start with http:// or https://.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${url}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`The server answered HTTP ${res.status}.`);
    const data = await res.json();
    return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).slice(0, 200);
  } catch (e) {
    throw new Error(controller.signal.aborted ? 'No answer within 8 seconds — is the server running?' : shortError(e));
  } finally { clearTimeout(timer); }
}

/** Send a tiny prompt to one model ref; resolves with its reply. */
async function testModel(ref) {
  const { connection, model } = routing.splitRef(ref);
  const conn = catalog().find((c) => c.id === connection);
  if (!conn) throw new Error('Unknown connection.');
  if (!conn.available) throw new Error(conn.reason);
  const c = { ref, conn, model: model || conn.models[0]?.id || '', label: describe(conn, model) };
  const signal = AbortSignal.timeout(90000);
  const text = await runCandidate(c, { system: '', prompt: 'Reply with the single word: ready', signal });
  return text.trim().slice(0, 200);
}

module.exports = {
  generate, generateOn, runCandidate, parseJsonReply, hasModelFor, candidates, catalog, embed, detectModels, testModel,
  TASK_LABELS, shortError,
};
