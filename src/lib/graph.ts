// Build a force-directed graph view of the Second Brain.
// Nodes  = captured snippets + saved DeepDive sessions.
// Links  = origin (DeepDive→snippet), shared tags, semantic similarity (top-K).
// Category drives node color, which causes natural clustering under
// the default d3-force charge + link forces.

import { cosineSimilarity } from './ai';

export interface BrainNode {
  id: string;
  kind: 'snippet' | 'deepdive' | 'import';
  label: string;
  /** Used by react-force-graph's nodeAutoColorBy="group" for clustering color. */
  group: string;
  /** Visual radius hint. */
  val: number;
  /** Original underlying record so the panel/chat can deep-link. */
  data: any;
}

export interface BrainLink {
  source: string;
  target: string;
  kind: 'origin' | 'tag' | 'similar' | 'similar-soft';
  /** Force-graph uses `value` as a link strength hint. */
  value: number;
}

export interface BrainGraph {
  nodes: BrainNode[];
  links: BrainLink[];
}

interface SnippetLike {
  id: string;
  title?: string;
  summary?: string;
  category?: string;
  source?: string;
  tags?: string[];
  embedding?: number[];
  originThreadId?: string;
  timestamp?: number;
  extractedText?: string;
}

interface DeepDiveLike {
  id: string;
  title?: string;
  description?: string;
  mainMessages?: any[];
  threads?: any[];
  timestamp?: number;
  updatedAt?: number;
  /** Centroid of the session's assistant text. Required for an a DeepDive to
   *  participate in semantic similarity links (otherwise it only gets origin
   *  links from snippets saved out of it). */
  embedding?: number[];
}

interface ImportLike {
  id: string;
  provider: 'claude' | 'chatgpt';
  title: string;
  messages: { role: string; content: string }[];
  createdAt: number;
  updatedAt: number;
  /** Optional conversation-level centroid (mean of chunk embeddings).
   *  Required for an import to participate in semantic similarity links. */
  embedding?: number[];
}

// Connection tuning. Defaults are looser than the original (0.62 / top-3) so
// adjacent topics surface; both are user-tunable via the graph settings
// sliders. Pairs in [threshold - SOFT_BAND, threshold) are kept as faint
// 'similar-soft' links so "a little bit related" shows without clutter.
export const DEFAULT_SIMILARITY_THRESHOLD = 0.55;
export const DEFAULT_SIMILAR_TOP_K = 5;
const SOFT_BAND = 0.08;

export interface GraphOptions {
  /** Minimum cosine similarity for a solid 'similar' link. */
  threshold?: number;
  /** Max semantic neighbors kept per node. */
  topK?: number;
}

export function buildGraph(
  snippets: SnippetLike[],
  deepDives: DeepDiveLike[],
  imports: ImportLike[] = [],
  opts: GraphOptions = {},
): BrainGraph {
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const topK = opts.topK ?? DEFAULT_SIMILAR_TOP_K;
  const softThreshold = Math.max(0.3, threshold - SOFT_BAND);
  const nodes: BrainNode[] = [];
  const links: BrainLink[] = [];

  // --- Imported conversation nodes (one per conversation, not per chunk —
  //     chunks live in their own store and are used for chat retrieval only) ---
  for (const im of imports) {
    nodes.push({
      id: `import:${im.id}`,
      kind: 'import',
      label: im.title || '(untitled)',
      group: im.provider === 'claude' ? 'Claude' : 'ChatGPT',
      val: 5 + Math.min(10, (im.messages?.length ?? 0) * 0.15),
      data: im,
    });
  }

  // --- Snippet nodes ---
  for (const s of snippets) {
    nodes.push({
      id: `snip:${s.id}`,
      kind: 'snippet',
      label: s.title || s.summary?.slice(0, 60) || '(untitled)',
      group: s.category || 'Uncategorized',
      val: 4 + Math.min(6, (s.tags?.length ?? 0) * 0.6),
      data: s,
    });
  }

  // --- DeepDive nodes ---
  for (const dd of deepDives) {
    const msgCount = (dd.mainMessages?.length ?? 0) + (dd.threads?.reduce((acc: number, t: any) => acc + (t.messages?.length ?? 0), 0) ?? 0);
    nodes.push({
      id: `dd:${dd.id}`,
      kind: 'deepdive',
      label: dd.title || '(untitled deepdive)',
      group: 'DeepDive',
      val: 6 + Math.min(14, msgCount * 0.25),
      data: dd,
    });
  }

  const nodeIds = new Set(nodes.map(n => n.id));

  // --- Origin links: snippet.originThreadId points back to a DeepDive thread ---
  // The DeepDive thread is inside a session; we link the snippet to the session node.
  // Build a quick lookup of which session contains which thread id.
  const threadToDeepDive = new Map<string, string>();
  for (const dd of deepDives) {
    for (const t of dd.threads ?? []) {
      if (t?.id) threadToDeepDive.set(t.id, dd.id);
    }
  }
  for (const s of snippets) {
    if (!s.originThreadId) continue;
    const ddId = threadToDeepDive.get(s.originThreadId);
    if (!ddId) continue;
    const a = `snip:${s.id}`;
    const b = `dd:${ddId}`;
    if (nodeIds.has(a) && nodeIds.has(b)) {
      links.push({ source: a, target: b, kind: 'origin', value: 3 });
    }
  }

  // --- Shared-tag links between snippets ---
  // For each tag, connect every pair of snippets that share it. To avoid hairballs,
  // collapse to one link per pair with value = number of shared tags.
  const sharedPairs = new Map<string, number>(); // key = a<b ids
  const tagIndex = new Map<string, string[]>();
  for (const s of snippets) {
    for (const tagRaw of s.tags ?? []) {
      const tag = tagRaw.toLowerCase().trim();
      if (!tag) continue;
      const arr = tagIndex.get(tag) ?? [];
      arr.push(s.id);
      tagIndex.set(tag, arr);
    }
  }
  for (const ids of tagIndex.values()) {
    if (ids.length < 2 || ids.length > 30) continue; // skip super-common tags
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        const key = `${a}|${b}`;
        sharedPairs.set(key, (sharedPairs.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, shared] of sharedPairs) {
    if (shared < 2) continue; // require at least 2 shared tags to draw a tag link
    const [a, b] = key.split('|');
    links.push({ source: `snip:${a}`, target: `snip:${b}`, kind: 'tag', value: shared });
  }

  // --- Semantic similarity links (top-K per node, threshold) ---
  // Unified pool: snippets + indexed imports. Imports without an embedding
  // (not yet indexed) are skipped — they show as isolated nodes until indexed.
  // Cross-kind links emerge naturally because they share the same vector space.
  type Embedded = { graphId: string; embedding: number[] };
  const pool: Embedded[] = [];
  for (const s of snippets) {
    if (s.embedding?.length) pool.push({ graphId: `snip:${s.id}`, embedding: s.embedding });
  }
  for (const dd of deepDives) {
    if (dd.embedding?.length) pool.push({ graphId: `dd:${dd.id}`, embedding: dd.embedding });
  }
  for (const im of imports) {
    if (im.embedding?.length) pool.push({ graphId: `import:${im.id}`, embedding: im.embedding });
  }

  if (pool.length > 1) {
    const seen = new Set<string>();
    for (let i = 0; i < pool.length; i++) {
      const a = pool[i];
      const sims: { graphId: string; sim: number }[] = [];
      for (let j = 0; j < pool.length; j++) {
        if (i === j) continue;
        const b = pool[j];
        if (a.embedding.length !== b.embedding.length) continue; // skip dim mismatches
        const sim = cosineSimilarity(a.embedding, b.embedding);
        if (sim >= softThreshold) sims.push({ graphId: b.graphId, sim });
      }
      sims.sort((x, y) => y.sim - x.sim);
      for (const { graphId, sim } of sims.slice(0, topK)) {
        const [x, y] = a.graphId < graphId ? [a.graphId, graphId] : [graphId, a.graphId];
        const key = `${x}|${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const kind: BrainLink['kind'] = sim >= threshold ? 'similar' : 'similar-soft';
        links.push({ source: x, target: y, kind, value: sim * 4 });
      }
    }
  }

  // Orient each link so a directional pulse flows from the more-connected
  // ("parent") node outward. adjacency/hierarchy treat links as undirected,
  // so swapping source/target here is purely cosmetic (drives particle flow).
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  for (const l of links) {
    if ((degree.get(l.target) ?? 0) > (degree.get(l.source) ?? 0)) {
      const tmp = l.source; l.source = l.target; l.target = tmp;
    }
  }

  return { nodes, links };
}

/** Build the text used to embed a DeepDive session (title + description +
 *  all assistant replies). Capped to keep the embedding request bounded. */
export function deepDiveEmbedSource(dd: DeepDiveLike): string {
  const assistant = [
    ...((dd.mainMessages ?? []).filter((m: any) => m?.role === 'assistant').map((m: any) => m.content || '')),
    ...((dd.threads ?? []).flatMap((t: any) =>
      (t.messages ?? []).filter((m: any) => m?.role === 'assistant').map((m: any) => m.content || ''))),
  ].join('\n\n');
  return [dd.title, dd.description, assistant].filter(Boolean).join('\n').slice(0, 8000);
}

/** Convert a graph node back into a Vault-style context item for chat retrieval. */
export function nodeAsContextItem(node: BrainNode) {
  if (node.kind === 'import') {
    const im = node.data as ImportLike;
    const text = (im.messages ?? [])
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n')
      .slice(0, 4000);
    return {
      id: node.id,
      title: im.title || '(untitled)',
      summary: `Imported ${im.provider === 'claude' ? 'Claude' : 'ChatGPT'} conversation, ${im.messages?.length ?? 0} messages.`,
      category: im.provider === 'claude' ? 'Claude' : 'ChatGPT',
      source: 'Imported',
      tags: [],
      extractedText: text,
      timestamp: im.updatedAt || im.createdAt || 0,
    };
  }
  if (node.kind === 'snippet') {
    const s = node.data as SnippetLike;
    return {
      id: node.id,
      title: s.title || node.label,
      summary: s.summary || '',
      category: s.category || 'Uncategorized',
      source: s.source || '',
      tags: s.tags || [],
      extractedText: s.extractedText || '',
      timestamp: s.timestamp || 0,
    };
  }
  const dd = node.data as DeepDiveLike;
  const allText = [
    ...(dd.mainMessages ?? []).filter((m: any) => m?.role === 'assistant').map((m: any) => m.content || ''),
    ...((dd.threads ?? []).flatMap((t: any) => (t.messages ?? []).filter((m: any) => m?.role === 'assistant').map((m: any) => m.content || ''))),
  ].join('\n\n').slice(0, 4000);
  return {
    id: node.id,
    title: dd.title || '(untitled deepdive)',
    summary: dd.description || `DeepDive session with ${dd.mainMessages?.length ?? 0} messages across ${dd.threads?.length ?? 0} threads.`,
    category: 'DeepDive',
    source: 'DeepDive Session',
    tags: [],
    extractedText: allText,
    timestamp: dd.updatedAt || dd.timestamp || 0,
  };
}
