// Autonomous "Deep Dive" research engine for DeepDive.
// A native TypeScript-free port of GPT Researcher's planner → execute → publish
// loop, built entirely on primitives this app already ships:
//   - search     → research.findLinks()  (Gemini Google-Search grounding + liveness verify)
//   - read/scrape → extract.extractUrl()  (Readability/Turndown + headless Electron fallback)
//   - summarize   → Gemini (cheap, high-volume per-source attribution)
//   - synthesize  → Claude (best long-form cited writing)
//
// The loop emits typed progress events via an onEvent callback so the renderer
// can render live status, per-source cards, and a streaming cited report.
// Runs in the Electron main process (full network + filesystem, no CORS).

const research = require('./research.cjs');
const extract = require('./extract.cjs');
const { getProviderKey } = require('./keystore.cjs');
const { getModelId } = require('./modelstore.cjs');

// --- tuning knobs (overridable per request) ---
const DEFAULTS = {
  breadth: 4,        // sub-questions generated per level
  depth: 2,          // recursion levels (1 = plan + answer, no follow-ups)
  perQuery: 4,       // sources read per sub-question
  concurrency: 4,    // max simultaneous source reads
  totalWords: 2000,  // target report length
};
const SUMMARY_BODY_CAP = 6000; // chars of page body fed to the summarizer

function parseTag(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

// Pull the first balanced JSON value (array or object) out of a string,
// tolerating fences and surrounding prose.
function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '');
  const tagged = parseTag(cleaned, 'json');
  const body = tagged || cleaned;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

// Bounded-concurrency map. Preserves input order in the result array.
async function pool(items, limit, worker, signal) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) return;
      const idx = next++;
      try { results[idx] = await worker(items[idx], idx); }
      catch (e) { results[idx] = { __error: e?.message || String(e) }; }
    }
  });
  await Promise.all(runners);
  return results;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const e = new Error('Deep research canceled.');
    e.canceled = true;
    throw e;
  }
}

// --- Gemini: planning + per-source summarization (and grounded search reuse) ---
async function geminiGenerate(prompt, { search = false } = {}) {
  const key = getProviderKey('gemini');
  if (!key) throw new Error('Gemini key not configured — it powers deep-research search & summarization. Add it in the Models tab.');
  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({ apiKey: key });
  const result = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(search ? { config: { tools: [{ googleSearch: {} }] } } : {}),
  });
  return result.text || '';
}

// --- Claude: final synthesis (streaming) + JSON judgments (verification) ---
// Honors the same dual auth as the rest of the app: subscription (Agent SDK,
// the user's Claude plan) or API key (@anthropic-ai/sdk).
async function claudeStream({ system, user, authMode, onDelta, signal }) {
  let full = '';
  if (authMode === 'subscription') {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const modelId = getModelId('claude') || getModelId('anthropic');
    const stream = query({
      prompt: `${system}\n\n${user}`,
      options: { model: modelId, systemPrompt: system, allowedTools: [], permissionMode: 'bypassPermissions' },
    });
    let prev = 0;
    for await (const msg of stream) {
      if (signal?.aborted) break;
      if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
        let f = '';
        for (const b of msg.message.content) if (b && b.type === 'text' && typeof b.text === 'string') f += b.text;
        if (f.length > prev) { onDelta?.(f.slice(prev)); prev = f.length; full = f; }
      } else if (msg.type === 'result') break;
    }
    return full;
  }
  const key = getProviderKey('anthropic');
  if (!key) throw new Error('Anthropic key not configured — needed to synthesize the report. Add it in the Models tab or switch to Claude subscription auth.');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  const modelId = getModelId('claude') || 'claude-opus-4-8';
  const stream = await client.messages.stream(
    { model: modelId, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] },
    { signal },
  );
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      onDelta?.(ev.delta.text);
      full += ev.delta.text;
    }
  }
  return full;
}

async function claudeText({ system, user, authMode, signal }) {
  return claudeStream({ system, user, authMode, signal, onDelta: null });
}

// --- Pipeline stages ---

async function planQuestions(query, breadth) {
  const prompt = `You are the planning agent for an autonomous research system. The user's research query is:
"""
${query.slice(0, 2000)}
"""

Decompose this into ${breadth} specific, non-overlapping research questions that together would let someone write a thorough, objective report. Cover distinct facets where relevant: definitions/fundamentals, mechanisms/how it works, evidence/data, comparisons/alternatives, criticisms/limitations, applications, and recent developments.

Respond with NOTHING but a JSON array of question strings:
<json>["question 1","question 2", ...]</json>`;
  const text = await geminiGenerate(prompt);
  const arr = parseJsonLoose(text);
  const questions = Array.isArray(arr) ? arr.filter(q => typeof q === 'string' && q.trim()).map(q => q.trim()) : [];
  if (!questions.length) return [query]; // fall back to the raw query as a single line
  return questions.slice(0, breadth);
}

async function followUpQuestions(query, learnings, asked, count) {
  const prompt = `You are deepening an autonomous research process. Original query:
"""
${query.slice(0, 1500)}
"""

Questions already explored:
${asked.map(q => `- ${q}`).join('\n')}

Key learnings gathered so far:
${learnings.slice(0, 6000)}

Identify ${count} NEW, deeper follow-up questions that fill important gaps, resolve contradictions, or pursue promising leads NOT already covered above. Avoid restating earlier questions.

Respond with NOTHING but a JSON array of question strings:
<json>["question 1", ...]</json>`;
  const text = await geminiGenerate(prompt);
  const arr = parseJsonLoose(text);
  const qs = Array.isArray(arr) ? arr.filter(q => typeof q === 'string' && q.trim()).map(q => q.trim()) : [];
  return qs.slice(0, count);
}

async function summarizeSource(subQuestion, title, url, body) {
  const prompt = `Research question: "${subQuestion}"
Source: ${title || url}
URL: ${url}

Content:
"""
${body.slice(0, SUMMARY_BODY_CAP)}
"""

Extract ONLY the facts, data, figures, and arguments from THIS source that help answer the research question. Write 3-6 tight bullet points, each self-contained. Quote specific numbers/names where present. Do NOT add anything not supported by the content. If this source is irrelevant or contentless, reply with exactly: IRRELEVANT`;
  const text = (await geminiGenerate(prompt)).trim();
  if (!text || /^IRRELEVANT/i.test(text)) return null;
  return text;
}

// Read + summarize every candidate link for one sub-question. Returns the
// relevant {title,url,summary} list; emits a 'source' event per kept source.
async function researchQuestion({ subQuestion, perQuery, concurrency, seen, assignNumber, onEvent, signal }) {
  let candidates = [];
  try {
    const { items } = await research.findLinks(subQuestion);
    candidates = (items || []).filter(c => c.url && !seen.has(c.url)).slice(0, perQuery);
  } catch (e) {
    onEvent({ type: 'note', message: `Search failed for "${subQuestion}": ${e?.message || e}` });
    return [];
  }
  candidates.forEach(c => seen.add(c.url));

  const read = await pool(candidates, concurrency, async (cand) => {
    throwIfAborted(signal);
    let extracted;
    try {
      extracted = await extract.extractUrl(cand.url);
    } catch {
      return null; // dead/blocked/unsupported — skip silently
    }
    if (!extracted?.text || extracted.text.trim().length < 200) return null;
    const summary = await summarizeSource(subQuestion, extracted.title || cand.title, extracted.source || cand.url, extracted.text);
    if (!summary) return null;
    const source = {
      n: assignNumber(),
      title: extracted.title || cand.title || cand.url,
      url: extracted.source || cand.url,
      subQuestion,
      summary,
    };
    onEvent({ type: 'source', source });
    return source;
  }, signal);

  return read.filter(s => s && !s.__error);
}

// --- Public entry point ---
async function runDeepResearch({ query, breadth, depth, perQuery, concurrency, totalWords, authMode, onEvent, signal }) {
  const cfg = {
    breadth: clampInt(breadth, 2, 8, DEFAULTS.breadth),
    depth: clampInt(depth, 1, 4, DEFAULTS.depth),
    perQuery: clampInt(perQuery, 2, 8, DEFAULTS.perQuery),
    concurrency: clampInt(concurrency, 1, 8, DEFAULTS.concurrency),
    totalWords: clampInt(totalWords, 500, 6000, DEFAULTS.totalWords),
  };
  const emit = (e) => { try { onEvent?.(e); } catch { /* swallow sink errors */ } };

  if (!query || !query.trim()) throw new Error('A research query is required.');
  emit({ type: 'status', phase: 'planning', message: 'Planning the investigation…' });

  // Plan.
  const planned = await planQuestions(query, cfg.breadth);
  throwIfAborted(signal);
  emit({ type: 'plan', query, questions: planned, config: cfg });

  // Execute, level by level. Sources are numbered globally in discovery order.
  const seen = new Set();
  const allSources = [];
  let counter = 0;
  const assignNumber = () => ++counter;
  let currentQuestions = planned;

  for (let level = 0; level < cfg.depth; level++) {
    throwIfAborted(signal);
    emit({ type: 'depth', level: level + 1, total: cfg.depth, questions: currentQuestions });

    // Run all of this level's questions (each fans out to perQuery reads).
    const perQuestion = await pool(currentQuestions, cfg.concurrency, (subQuestion) =>
      researchQuestion({ subQuestion, perQuery: cfg.perQuery, concurrency: cfg.concurrency, seen, assignNumber, onEvent: emit, signal }),
      signal,
    );
    for (const list of perQuestion) {
      if (Array.isArray(list)) allSources.push(...list);
    }

    // Decide next level's questions from what we learned.
    if (level < cfg.depth - 1) {
      throwIfAborted(signal);
      const learnings = allSources.map(s => `• (${s.subQuestion}) ${s.summary}`).join('\n');
      const askedSoFar = [...currentQuestions];
      const nextCount = Math.max(2, Math.floor(cfg.breadth / 2));
      const next = await followUpQuestions(query, learnings, askedSoFar, nextCount);
      if (!next.length) break; // nothing new to chase — stop early
      currentQuestions = next;
    }
  }

  throwIfAborted(signal);

  if (!allSources.length) {
    throw new Error('No readable sources could be gathered for this query. Try a broader or differently-worded topic.');
  }

  // Synthesize a cited report from the attributed summaries.
  emit({ type: 'status', phase: 'writing', message: `Synthesizing report from ${allSources.length} sources…` });

  const system = `You are an expert research writer. Write a comprehensive, well-structured, factual research report using ONLY the numbered sources provided. Requirements:
- Use inline citations in square brackets like [1], [3] immediately after the claims they support. Every non-obvious factual claim must cite at least one source.
- Organize with clear markdown headings (##) and short paragraphs; use bullet lists where they aid clarity.
- Be objective. Where sources disagree, say so and cite both.
- Do NOT invent facts, sources, or citations. Only cite source numbers that exist.
- Target roughly ${cfg.totalWords} words.
- End with a "## Sources" section listing every cited source as: [n] Title — URL`;

  const user = `Research query:
"""
${query}
"""

Numbered sources (each is a faithful summary of one web page):

${allSources.map(s => `[${s.n}] ${s.title} — ${s.url}\n${s.summary}`).join('\n\n')}

Write the full research report now.`;

  let report = '';
  report = await claudeStream({
    system, user, authMode, signal,
    onDelta: (delta) => emit({ type: 'report-delta', delta }),
  });
  report = report.trim();

  const citations = allSources.map(s => ({ n: s.n, title: s.title, url: s.url }));
  emit({ type: 'report', report, citations });
  emit({ type: 'done', sources: allSources.length });

  return { query, config: cfg, plan: planned, sources: allSources, report, citations };
}

// --- Adversarial verification (the step GPT Researcher omits) ---
// Checks each cited factual claim in the report against the cited source
// summary. One batched Claude call keeps it cheap. Returns claim verdicts.
async function verifyReport({ query, report, sources, authMode, signal }) {
  if (!report || !Array.isArray(sources) || !sources.length) {
    return { claims: [] };
  }
  const system = `You are a rigorous fact-checking judge. You are given a research report and the numbered source summaries it was written from. For each significant factual claim in the report that carries a citation like [n], decide whether the cited source summary actually supports it.

Return NOTHING but a JSON array. Each element:
{"claim": "<the claim text, <=200 chars>", "citation": <source number>, "verdict": "supported"|"partial"|"unsupported", "note": "<short reason, <=160 chars>"}

Be skeptical: if the cited summary does not clearly contain the claim, mark it "partial" or "unsupported". Judge at most the 12 most important claims.`;

  const user = `Research query: "${query}"

Numbered source summaries:
${sources.map(s => `[${s.n}] ${s.title}\n${s.summary}`).join('\n\n')}

REPORT:
"""
${report.slice(0, 16000)}
"""

Return the JSON array of claim verdicts now.`;

  const raw = await claudeText({ system, user, authMode, signal });
  const arr = parseJsonLoose(raw);
  const claims = Array.isArray(arr)
    ? arr
        .filter(c => c && typeof c.claim === 'string')
        .map(c => ({
          claim: String(c.claim).slice(0, 240),
          citation: Number.isFinite(Number(c.citation)) ? Number(c.citation) : null,
          verdict: ['supported', 'partial', 'unsupported'].includes(c.verdict) ? c.verdict : 'partial',
          note: typeof c.note === 'string' ? c.note.slice(0, 200) : '',
        }))
    : [];
  const tally = claims.reduce((acc, c) => { acc[c.verdict] = (acc[c.verdict] || 0) + 1; return acc; }, {});
  return { claims, tally };
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

module.exports = { runDeepResearch, verifyReport, DEFAULTS };
