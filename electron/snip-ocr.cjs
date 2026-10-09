// Screenshot OCR + filing metadata shared by the desktop snipping vault
// (/api/vision/analyze-snip) and the phone (/api/mobile/ocr). Gemini is the
// primary model; Claude reads the image when Gemini is unavailable (no key,
// depleted credits, outage), on the subscription or the Anthropic key.
const { getProviderKey } = require('./keystore.cjs');
const { getModelId } = require('./modelstore.cjs');
const { claudeGenerate, parseJsonReply } = require('./claude-generate.cjs');


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

async function geminiOcr(image) {
  const key = getProviderKey('gemini');
  if (!key) throw new Error('no Gemini key configured');
  const { GoogleGenAI, Type } = await import('@google/genai');
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      summary: { type: Type.STRING },
      category: { type: Type.STRING },
      source: { type: Type.STRING },
      tags: { type: Type.ARRAY, items: { type: Type.STRING } },
      entities: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: { type: { type: Type.STRING }, label: { type: Type.STRING }, value: { type: Type.STRING } },
          required: ['type', 'label', 'value'],
        },
      },
      extractedText: { type: Type.STRING },
    },
    required: ['title', 'summary', 'category', 'source', 'tags', 'entities', 'extractedText'],
  };
  const result = await new GoogleGenAI({ apiKey: key }).models.generateContent({
    model: getModelId('gemini'),
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: image.mimeType, data: image.data } }, { text: OCR_INSTRUCTIONS }] }],
    config: { responseMimeType: 'application/json', responseSchema },
  });
  if (!result.text) throw new Error('Gemini returned no content.');
  return JSON.parse(result.text);
}

async function claudeOcr(image, authMode) {
  const reply = await claudeGenerate({
    authMode,
    system: 'You extract structured metadata from screenshots. Reply with a single JSON object and nothing else.',
    text: `${OCR_INSTRUCTIONS}\n\nReturn exactly this JSON shape:\n{"title": string, "summary": string, "category": string, "source": string, "tags": string[], "entities": [{"type": "link"|"number"|"address"|"info", "label": string, "value": string}], "extractedText": string}\n\nextractedText is the full verbatim text visible in the image.`,
    image,
  });
  return parseJsonReply(reply);
}

// Gemini first, then Claude. Resolves with the normalized analysis plus the
// provider that produced it; rejects with every provider's reason.
async function analyzeSnipImage(image, { anthropicAuthMode }) {
  const failures = [];
  for (const [name, run] of [['Gemini', geminiOcr], ['Claude', (img) => claudeOcr(img, anthropicAuthMode)]]) {
    try {
      return { ...normalizeOcr(await run(image)), ocrProvider: name };
    } catch (e) {
      failures.push(`${name}: ${shortError(e)}`);
    }
  }
  throw new Error(`OCR failed — ${failures.join(' | ')}`);
}

module.exports = { analyzeSnipImage, geminiOcr, claudeOcr, normalizeOcr, shortError, OCR_INSTRUCTIONS };
