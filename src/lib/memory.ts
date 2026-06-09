// Renderer-side enrichment for externally ingested notes (e.g. Hermes task
// markdown delivered over the LAN memory-ingest webhook).
//
// The main process stores each delivered file as a single RAW neuron with
// `memoryPending: true` and `status: 'analyzing'` — it can't embed (Gemini only
// lives in the renderer). This module finishes the job: auto-categorize the
// doc, split a long doc into multiple linked chunk-neurons, embed each, and
// write them back so the Second Brain graph picks them up.
//
// Mirrors the screenshot pipeline (SnippingTab.processSnip) and the imports
// chunking (imports.ts) so ingested notes behave exactly like every other neuron.

import * as db from './db';
import * as ai from './ai';
import { emitSnippetsChange } from './snippetStore';
import type { CapturedItem } from '../components/SnippetEditor';

// Match the imports.ts chunk size so ingested docs chunk the same way.
const MAX_CHUNK_CHARS = 3500;
// Cap the text we send to the categorizer (the embedder already slices to 8000).
const ANALYZE_HEAD_CHARS = 12000;

let running = false;

/**
 * Enrich every pending ingested neuron. Safe to call repeatedly and concurrently
 * (guarded). No-ops (leaving items pending) when Gemini isn't configured yet, so
 * a later call — e.g. once the user adds a key — will complete them. Returns the
 * number of source documents processed.
 *
 * Drains: each pass re-queries the store, so notes that arrive WHILE we're
 * embedding (a rapid batch push delivers them one POST at a time) are picked up
 * on the next pass instead of being stranded by the in-flight guard.
 */
export async function enrichPendingMemory(): Promise<number> {
  if (running) return 0;
  if (!ai.isGeminiReady()) return 0;
  running = true;
  let processed = 0;
  try {
    for (;;) {
      const all = await db.getAllSnippets<CapturedItem>();
      const pending = all.filter((s) => s.memoryPending && s.status !== 'ready');
      if (!pending.length) break;
      for (const item of pending) {
        try {
          await enrichOne(item);
          processed++;
          // Emit per item so the graph lights up progressively during a batch
          // (downstream reload is debounced, so this coalesces).
          emitSnippetsChange();
        } catch (e) {
          console.error('[memory] enrich failed for', item.id, e);
          // Mark as error and clear the pending flag so we don't spin on it.
          await db.putSnippet({
            ...item,
            status: 'error',
            error: (e as Error)?.message || String(e),
            memoryPending: false,
          });
        }
      }
    }
  } finally {
    running = false;
  }
  return processed;
}

async function enrichOne(item: CapturedItem): Promise<void> {
  // Pre-analyzed items (e.g. a mobile OCR capture that already carries a
  // Gemini-derived title/summary/tags/entities) only need an embedding so they
  // land in the graph and semantic search — re-analyzing would clobber the good
  // vision-based metadata, so we skip straight to embedding.
  if ((item as any).preAnalyzed) {
    const ready: CapturedItem = { ...item, status: 'ready', error: undefined, memoryPending: false };
    const embedding = await ai.embedText(ai.buildEmbedSource(ready));
    await db.putSnippet({ ...ready, embedding, preAnalyzed: false } as CapturedItem);
    return;
  }

  const content = item.extractedText || '';
  const analysis = await ai.analyzeMarkdown(content.slice(0, ANALYZE_HEAD_CHARS));

  // 'hermes' (or the origin) is always present so ingested notes are filterable
  // as a group while still carrying their AI-derived topical tags.
  const originTag = (item.memorySource || 'hermes').toLowerCase();
  const baseTags = dedupeTags([...analysis.tags, originTag]);

  if (content.length <= MAX_CHUNK_CHARS) {
    const enriched: CapturedItem = {
      ...item,
      title: analysis.title || item.title,
      summary: analysis.summary,
      category: analysis.category || item.category,
      tags: baseTags,
      entities: analysis.entities,
      status: 'ready',
      error: undefined,
      memoryPending: false,
    };
    const embedding = await ai.embedText(ai.buildEmbedSource(enriched));
    await db.putSnippet({ ...enriched, embedding });
    return;
  }

  // Long doc → multiple linked chunk-neurons. A shared doc-slug tag clusters the
  // siblings via the graph's tag links (on top of semantic similarity).
  const pieces = splitOversized(content, MAX_CHUNK_CHARS);
  const docSlug = slugTag(analysis.title || item.title || 'hermes-doc');
  const sharedTags = dedupeTags([...baseTags, docSlug]);
  const total = pieces.length;

  for (let i = 0; i < total; i++) {
    const piece = pieces[i];
    // The first chunk reuses the original neuron id (no orphan placeholder);
    // the rest get deterministic sibling ids.
    const id = i === 0 ? item.id : `${item.id}-c${i}`;
    const chunk: CapturedItem = {
      ...item,
      id,
      title: total > 1 ? `${analysis.title} (part ${i + 1}/${total})` : analysis.title,
      summary: analysis.summary,
      category: analysis.category || item.category,
      tags: sharedTags,
      // Entities only on the first part to avoid N copies of the same values.
      entities: i === 0 ? analysis.entities : [],
      extractedText: piece,
      status: 'ready',
      error: undefined,
      memoryPending: false,
      memoryDocId: item.id,
      memoryPart: i + 1,
      memoryParts: total,
    };
    // Embed the chunk text itself (with light title/summary context) for
    // fine-grained semantic linking between this part and the rest of the brain.
    const embedding = await ai.embedText(ai.buildEmbedSource(chunk));
    await db.putSnippet({ ...chunk, embedding });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = (raw || '').toLowerCase().trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

function slugTag(title: string): string {
  const slug = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'hermes-doc';
}

// Paragraph-aware splitter, same strategy as imports.ts:splitOversized.
function splitOversized(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  const paras = text.split(/\n\n+/);
  let buf = '';
  for (const p of paras) {
    if (buf.length + p.length + 2 > max && buf) {
      out.push(buf);
      buf = '';
    }
    if (p.length > max) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}
