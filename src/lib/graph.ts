// Build a force-directed graph view of the Second Brain.
// Nodes  = captured snippets + saved DeepDive sessions.
// Links  = origin (DeepDive→snippet), shared tags, semantic similarity (top-K).
// Category drives node color, which causes natural clustering under
// the default d3-force charge + link forces.

import { cosineSimilarity } from './ai';

export interface BrainNode {
  id: string;
  kind: 'snippet' | 'deepdive';
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
  kind: 'origin' | 'tag' | 'similar';
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
  learningSnippets?: any[];
  timestamp?: number;
  updatedAt?: number;
}

const SIMILARITY_THRESHOLD = 0.62;
const SIMILAR_TOP_K = 3;

export function buildGraph(snippets: SnippetLike[], deepDives: DeepDiveLike[]): BrainGraph {
  const nodes: BrainNode[] = [];
  const links: BrainLink[] = [];

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

  // --- Semantic similarity links (top-K per snippet, threshold) ---
  const embedded = snippets.filter(s => s.embedding && s.embedding.length > 0);
  if (embedded.length > 1) {
    const seen = new Set<string>();
    for (let i = 0; i < embedded.length; i++) {
      const a = embedded[i];
      const sims: { id: string; sim: number }[] = [];
      for (let j = 0; j < embedded.length; j++) {
        if (i === j) continue;
        const b = embedded[j];
        const sim = cosineSimilarity(a.embedding!, b.embedding!);
        if (sim >= SIMILARITY_THRESHOLD) sims.push({ id: b.id, sim });
      }
      sims.sort((x, y) => y.sim - x.sim);
      for (const { id, sim } of sims.slice(0, SIMILAR_TOP_K)) {
        const [x, y] = a.id < id ? [a.id, id] : [id, a.id];
        const key = `${x}|${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: `snip:${x}`, target: `snip:${y}`, kind: 'similar', value: sim * 4 });
      }
    }
  }

  return { nodes, links };
}

/** Convert a graph node back into a Vault-style context item for chat retrieval. */
export function nodeAsContextItem(node: BrainNode) {
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
