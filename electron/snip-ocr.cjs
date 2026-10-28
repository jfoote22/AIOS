// Screenshot OCR + filing metadata shared by the desktop snipping vault
// (/api/vision/analyze-snip) and the phone (/api/mobile/ocr).
const router = require('./model-router.cjs');


const OCR_INSTRUCTIONS = 'You are the AI curator for "AIOS Vault" — a personal knowledge capture tool. The user has just captured this screenshot. Analyze it and return structured metadata so it can be filed and searched later.\n\nBe specific and faithful to what is actually visible. Do not invent details. If the image is mostly empty or unreadable, say so honestly in the summary.';

// Provider error bodies are often raw JSON; keep the human-readable message.
function shortError(e) {
  const raw = String(e?.message || e || 'failed');
  try { const j = JSON.parse(raw); return j?.error?.message || raw; } catch { return raw.slice(0, 300); }
}

function normalizeOcr(parsed) {
  const allowed = new Set(['link', 'number', 'address', 'info']);
  return {
    title: String(parsed.title || 'Untitled capture'),
    summary: String(parsed.summary || ''),
    category: String(parsed.category || 'Other'),
    source: String(parsed.source || ''),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    entities: (Array.isArray(parsed.entities) ? parsed.entities : [])
      .map((e) => ({ type: allowed.has(e?.type) ? e.type : 'info', label: String(e?.label || ''), value: String(e?.value || '') })),
    extractedText: String(parsed.extractedText || ''),
  };
}

const OCR_SHAPE = `Return exactly this JSON shape:
{"title": string, "summary": string, "category": string, "source": string, "tags": string[], "entities": [{"type": "link"|"number"|"address"|"info", "label": string, "value": string}], "extractedText": string}

title: 5-10 descriptive words. summary: 2-4 sentences on what the image shows. category: one short name like Houdini, Travel, Finance, Development, Design, Reference, Personal, General. source: best guess of the app or website from visible UI. tags: 3-8 lowercase keywords. entities: links, numbers, addresses, prices, dates, names, versions. extractedText: all readable text, verbatim ("" if none).`;

/**
 * Read a screenshot on the model routed to the 'ocr' task (it must accept
 * images); other connected vision models are tried if it fails. Resolves with
 * the normalized analysis plus the model that produced it.
 */
async function analyzeSnipImage(image, { signal } = {}) {
  const { text, label } = await router.generate({
    task: 'ocr',
    system: 'You extract structured metadata from screenshots.',
    prompt: `${OCR_INSTRUCTIONS}\n\n${OCR_SHAPE}`,
    image, json: true, signal,
  });
  return { ...normalizeOcr(router.parseJsonReply(text)), ocrProvider: label };
}

module.exports = { analyzeSnipImage, normalizeOcr, shortError, OCR_INSTRUCTIONS };
