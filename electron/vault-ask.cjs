// Ask Second Brain without embeddings. A model reads a compact catalog of
// every snip and picks the relevant ones, then writes the grounded answer.
// Both steps run on the model routed to the 'vault-ask' task (model-router.cjs),
// falling back to other connected models; if picking fails entirely, a keyword
// match chooses the snips instead. Shared by the desktop api-server
// (/api/vault/*) and the mobile gateway (/api/mobile/ask).
const sqliteStore = require('./sqlite-store.cjs');
const router = require('./model-router.cjs');

const PICK_LIMIT = 8;
// Bounds the catalog prompt (~4 chars/token → ~60k tokens); newest snips win.
const CATALOG_MAX_CHARS = 240_000;
const SUMMARY_CHARS = 240;

const SYSTEM_INSTRUCTION = () => `You are the personal AI assistant for "AIOS Vault" — a private knowledge base of screenshots and notes the user has captured over time. Answer the user's question using ONLY the snips provided as context. If the answer is not in the context, say so honestly and suggest what they could capture or search for. When you reference information, cite which snip it came from like [Snip 2]. Keep answers concise and useful. Today's date is ${new Date().toLocaleDateString()}.`;

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

/** Fallback when no model can pick: rank by how many question words appear. */
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
 * @returns {Promise<{ items: object[], via: string }>} full snippet objects, best
 *   first; `via` is the model that picked, or 'keyword'
 */
async function pickSnippets(question, { history, limit = PICK_LIMIT, signal } = {}) {
  const all = pickableSnippets();
  if (!all.length) return { items: [], via: 'none' };
  const { text: catalog, included } = buildCatalog(all);
  const transcript = transcriptOf(history);
  const system = `You choose which notes from a personal knowledge base help answer a question. Reply with JSON {"picks": [numbers]} listing up to ${limit} note numbers, most relevant first. Pick only notes that are actually relevant; an empty list is fine. Do not answer the question.`;
  const text = [
    `Notes (number, capture date, title, category | tags, summary):\n${catalog}`,
    transcript ? `Conversation so far:\n${transcript}` : '',
    `Question: ${question}`,
  ].filter(Boolean).join('\n\n');
  try {
    const { text: reply, label } = await router.generate({ task: 'vault-ask', system, prompt: text, json: true, schema: PICK_SCHEMA, signal });
    const picks = router.parseJsonReply(reply)?.picks;
    if (!Array.isArray(picks)) throw new Error('The model returned no picks.');
    const seen = new Set();
    const items = [];
    for (const n of picks) {
      const s = included[Number(n) - 1];
      if (s && !seen.has(s.id)) { seen.add(s.id); items.push(s); }
      if (items.length >= limit) break;
    }
    return { items, via: label };
  } catch (e) {
    if (signal?.aborted) throw e;
    console.error('[vault-ask] picking failed, using keyword match:', e?.message || e);
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
 * Write the grounded answer, streamed through onDelta.
 * @returns {Promise<{ text: string, provider: string }>} provider is the model's display name
 */
async function answerQuestion({ question, items, history, onDelta, signal }) {
  const { text, label } = await router.generate({
    task: 'vault-ask',
    system: SYSTEM_INSTRUCTION(),
    prompt: buildAnswerText(question, items, history),
    onDelta, signal,
  });
  return { text, provider: label };
}

module.exports = { pickSnippets, answerQuestion, keywordPick, buildCatalog };
