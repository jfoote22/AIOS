// Ask Second Brain without embeddings. ChatGPT reads a compact catalog of
// every snip and picks the relevant ones, then writes the grounded answer.
// ChatGPT runs through the Codex CLI's ChatGPT login when OpenAI is in
// subscription mode (no API credits), or the stored OpenAI key in 'api' mode.
// Claude, then Gemini, answer if ChatGPT cannot; if picking fails, a keyword
// match chooses the snips instead. Shared by the desktop api-server
// (/api/vault/*) and the mobile gateway (/api/mobile/ask).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqliteStore = require('./sqlite-store.cjs');
const { getProviderKey } = require('./keystore.cjs');
const { getModelId } = require('./modelstore.cjs');
const { codexOptions } = require('./sdk-binaries.cjs');
const { claudeGenerate, parseJsonReply } = require('./claude-generate.cjs');

const PICK_LIMIT = 8;
// Bounds the catalog prompt (~4 chars/token → ~60k tokens); newest snips win.
const CATALOG_MAX_CHARS = 240_000;
const SUMMARY_CHARS = 240;

const SYSTEM_INSTRUCTION = () => `You are the personal AI assistant for "AIOS Vault" — a private knowledge base of screenshots and notes the user has captured over time. Answer the user's question using ONLY the snips provided as context. If the answer is not in the context, say so honestly and suggest what they could capture or search for. When you reference information, cite which snip it came from like [Snip 2]. Keep answers concise and useful. Today's date is ${new Date().toLocaleDateString()}.`;

function authModeFor(provider) {
  let v = null;
  try { v = sqliteStore.call('getMeta', [`${provider}-auth-mode`]); } catch {}
  if (v === 'subscription' || v === 'api') return v;
  return provider === 'gemini' ? 'subscription' : 'api'; // matches authMode.ts defaults
}

// Codex runs as a read-only agent; give it an empty folder so it has nothing
// of the user's to read even if it decides to look around.
let scratchDir = null;
function codexWorkdir() {
  if (!scratchDir) {
    scratchDir = path.join(os.tmpdir(), 'aios-codex-vault');
    fs.mkdirSync(scratchDir, { recursive: true });
  }
  return scratchDir;
}

/**
 * One ChatGPT turn. Subscription mode uses the model in the user's Codex
 * config; 'api' mode uses the `openai` model slot. Low reasoning effort keeps
 * a question (pick + answer) near 15s through Codex without hurting answers.
 * @param {{ system: string, text: string, effort?: string, schema?: object,
 *           onDelta?: (t: string) => void, signal?: AbortSignal }} input
 */
async function chatgptGenerate({ system, text, effort = 'low', schema, onDelta, signal }) {
  if (authModeFor('openai') === 'subscription') {
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
    // Codex has no separate system channel; lead with the instructions.
    const streamed = await thread.runStreamed(`${system}\n\n${text}`, { outputSchema: schema, signal });
    const sent = new Map();
    let reply = '';
    for await (const event of streamed.events) {
      if (event.type === 'item.updated' || event.type === 'item.completed') {
        const item = event.item;
        if (item && item.type === 'agent_message' && typeof item.text === 'string') {
          const prev = sent.get(item.id) || 0;
          if (item.text.length > prev) {
            onDelta?.(item.text.slice(prev));
            sent.set(item.id, item.text.length);
          }
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
    if (!reply) throw new Error('ChatGPT returned no content.');
    return reply;
  }

  const key = getProviderKey('openai');
  if (!key) throw new Error('No OpenAI key configured, and OpenAI is not in subscription mode.');
  const { generateText } = await import('ai');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const { text: reply } = await generateText({
    model: createOpenAI({ apiKey: key }).chat(getModelId('openai')),
    system,
    messages: [{ role: 'user', content: text }],
    abortSignal: signal,
  });
  if (!reply) throw new Error('ChatGPT returned no content.');
  onDelta?.(reply);
  return reply;
}

async function geminiGenerate({ system, text }) {
  const key = getProviderKey('gemini');
  if (!key) throw new Error('No Gemini key configured.');
  const { GoogleGenAI } = await import('@google/genai');
  const result = await new GoogleGenAI({ apiKey: key }).models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text }] }],
    config: { systemInstruction: system },
  });
  if (!result.text) throw new Error('Gemini returned no content.');
  return result.text;
}

function transcriptOf(history) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-10)
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n\n');
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ── picking ────────────────────────────────────────────────────────────────

// Includes snips whose AI tagging failed (status 'error'): picking only needs
// their text, which ingest saved even though enrichment did not run.
function pickableSnippets() {
  return sqliteStore.call('getAllSnippets', [])
    .filter((s) => s && (s.title || s.summary || s.extractedText));
}

/** Newest-first catalog, numbered so the model can answer with short ids. */
function buildCatalog(snippets) {
  const lines = [];
  const included = [];
  let chars = 0;
  for (const s of snippets) {
    const line = [
      `#${included.length + 1} (${new Date(s.timestamp || 0).toISOString().slice(0, 10)})`,
      oneLine(s.title || '(no title)', 120),
      [s.category, (s.tags || []).slice(0, 6).join(', ')].filter(Boolean).join(' | '),
      oneLine(s.summary || s.extractedText, SUMMARY_CHARS),
    ].filter(Boolean).join(' — ');
    if (chars + line.length > CATALOG_MAX_CHARS) break;
    chars += line.length + 1;
    lines.push(line);
    included.push(s);
  }
  return { text: lines.join('\n'), included };
}

const STOPWORDS = new Set('the and for are but not you all any can had her was one our out has have how what when where which who why will with this that from they them then than there their about into your just like some what'.split(' '));

/** Fallback when ChatGPT cannot pick: rank by how many question words appear. */
function keywordPick(question, snippets, limit) {
  const words = [...new Set(String(question).toLowerCase().match(/[a-z0-9]{3,}/g) || [])]
    .filter((w) => !STOPWORDS.has(w));
  if (!words.length) return [];
  return snippets
    .map((s) => {
      const hay = [s.title, s.summary, s.extractedText, s.category, s.source, (s.tags || []).join(' ')]
        .filter(Boolean).join(' ').toLowerCase();
      return { s, score: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

const PICK_SCHEMA = {
  type: 'object',
  properties: { picks: { type: 'array', items: { type: 'integer' } } },
  required: ['picks'],
  additionalProperties: false,
};

/**
 * Choose the snips that help answer `question`.
 * @returns {Promise<{ items: object[], via: 'chatgpt' | 'keyword' }>} full snippet objects, best first
 */
async function pickSnippets(question, { history, limit = PICK_LIMIT, signal } = {}) {
  const all = pickableSnippets();
  if (!all.length) return { items: [], via: 'chatgpt' };
  const { text: catalog, included } = buildCatalog(all);
  const transcript = transcriptOf(history);
  const system = `You choose which notes from a personal knowledge base help answer a question. Reply with JSON {"picks": [numbers]} listing up to ${limit} note numbers, most relevant first. Pick only notes that are actually relevant; an empty list is fine. Do not answer the question.`;
  const text = [
    `Notes (number, capture date, title, category | tags, summary):\n${catalog}`,
    transcript ? `Conversation so far:\n${transcript}` : '',
    `Question: ${question}`,
  ].filter(Boolean).join('\n\n');
  try {
    const reply = await chatgptGenerate({ system, text, schema: PICK_SCHEMA, signal });
    const picks = parseJsonReply(reply)?.picks;
    if (!Array.isArray(picks)) throw new Error('ChatGPT returned no picks.');
    const seen = new Set();
    const items = [];
    for (const n of picks) {
      const s = included[Number(n) - 1];
      if (s && !seen.has(s.id)) { seen.add(s.id); items.push(s); }
      if (items.length >= limit) break;
    }
    return { items, via: 'chatgpt' };
  } catch (e) {
    if (signal?.aborted) throw e;
    console.error('[vault-ask] ChatGPT pick failed, using keyword match:', e?.message || e);
    return { items: keywordPick(question, all, limit), via: 'keyword' };
  }
}

// ── answering ──────────────────────────────────────────────────────────────

/** Context items: { title, summary, category, source, tags, extractedText, timestamp }. */
function buildAnswerText(question, items, history) {
  const contextBlock = items.length
    ? items.map((c, i) => [
      `[Snip ${i + 1}] (captured ${new Date(c.timestamp || Date.now()).toLocaleString()})`,
      `Title: ${c.title || '(no title)'}`,
      `Category: ${c.category || ''} | Source: ${c.source || ''}`,
      `Tags: ${(c.tags || []).join(', ') || '(none)'}`,
      `Summary: ${c.summary || ''}`,
      `Extracted text: ${(c.extractedText || '(no text)').slice(0, 1500)}`,
    ].join('\n')).join('\n\n')
    : '(The vault has no relevant snips for this question.)';
  const transcript = transcriptOf(history);
  return `${transcript ? `Earlier conversation:\n${transcript}\n\n` : ''}Context from my vault (top matches for my question):\n\n${contextBlock}\n\nMy question: ${question}`;
}

/**
 * Write the grounded answer: ChatGPT (streamed through onDelta), then Claude,
 * then Gemini. A fallback only runs if ChatGPT failed before streaming text.
 * @returns {Promise<{ text: string, provider: 'chatgpt' | 'claude' | 'gemini' }>}
 */
async function answerQuestion({ question, items, history, onDelta, signal }) {
  const system = SYSTEM_INSTRUCTION();
  const text = buildAnswerText(question, items, history);
  const errors = [];
  let streamed = false;
  try {
    const reply = await chatgptGenerate({
      system, text, signal,
      onDelta: (t) => { streamed = true; onDelta?.(t); },
    });
    return { text: reply, provider: 'chatgpt' };
  } catch (e) {
    if (streamed || signal?.aborted) throw e;
    errors.push(`ChatGPT: ${e?.message || e}`);
  }
  try {
    const reply = await claudeGenerate({ authMode: authModeFor('anthropic'), system, text });
    onDelta?.(reply);
    return { text: reply, provider: 'claude' };
  } catch (e) {
    errors.push(`Claude: ${e?.message || e}`);
  }
  try {
    const reply = await geminiGenerate({ system, text });
    onDelta?.(reply);
    return { text: reply, provider: 'gemini' };
  } catch (e) {
    errors.push(`Gemini: ${e?.message || e}`);
  }
  throw new Error(`No model could answer. ${errors.join(' · ')}`);
}

module.exports = { pickSnippets, answerQuestion, keywordPick, buildCatalog };
