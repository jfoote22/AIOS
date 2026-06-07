// Build a force-directed graph view of the Second Brain.
// Nodes  = captured snippets + saved DeepDive sessions.
// Links  = origin (DeepDive→snippet), shared tags, semantic similarity (top-K).
// Category drives node color, which causes natural clustering under
// the default d3-force charge + link forces.

import { cosineSimilarity } from './ai';

export interface BrainNode {
  id: string;
  kind: 'snippet' | 'deepdive' | 'import' | 'cluster';
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
  /** Set when a long ingested doc was split — ties sibling chunks to one source. */
  memoryDocId?: string;
  /** Total parts the source doc was split into (>1 means it's a collapsible cluster). */
  memoryParts?: number;
  /** 1-based part index within the source doc. */
  memoryPart?: number;
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

function importProviderLabel(p: string): string {
  if (p === 'claude') return 'Claude';
  return 'ChatGPT';
}

function importMsgCount(im: { messageCount?: number; messages?: unknown[] }): number {
  return im.messageCount ?? im.messages?.length ?? 0;
}

interface ImportLike {
  id: string;
  provider: 'claude' | 'chatgpt';
  title: string;
  /** Present only when a full conversation is loaded; graph nodes usually carry
   *  just `messageCount` (metadata) to avoid materializing every message. */
  messages?: { role: string; content: string }[];
  messageCount?: number;
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

// A node needs at least this many connections to count as a "hub" (Layer 1)
// and seed the network-pulse wave. User-tunable via the graph settings slider.
export const DEFAULT_HUB_THRESHOLD = 4;

export interface GraphOptions {
  /** Minimum cosine similarity for a solid 'similar' link. */
  threshold?: number;
  /** Max semantic neighbors kept per node. */
  topK?: number;
  /** Min connections for a node to be a hub (drives outward link orientation
   *  and the pulse animation's Layer 1). */
  hubThreshold?: number;
}

// ── Link/graph topology helpers (shared by orientation + pulse planning) ──────

/** Normalize a link endpoint to its id string. react-force-graph hydrates
 *  source/target from id strings into node objects after the first render, so
 *  callers may hand us either form. */
function endpointId(x: any): string {
  return x && typeof x === 'object' ? x.id : x;
}

function degreeMap(links: { source: any; target: any }[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const l of links) {
    const s = endpointId(l.source), t = endpointId(l.target);
    if (!s || !t) continue;
    d.set(s, (d.get(s) ?? 0) + 1);
    d.set(t, (d.get(t) ?? 0) + 1);
  }
  return d;
}

function adjacencyMap(links: { source: any; target: any }[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = m.get(a);
    if (!set) { set = new Set(); m.set(a, set); }
    set.add(b);
  };
  for (const l of links) {
    const s = endpointId(l.source), t = endpointId(l.target);
    if (!s || !t) continue;
    add(s, t);
    add(t, s);
  }
  return m;
}

/** Hubs = nodes whose connection count meets the threshold. If the threshold
 *  is too high for this graph (no node qualifies), fall back to the single
 *  most-connected node(s) so a pulse always has somewhere to start. */
function pickHubs(degree: Map<string, number>, hubThreshold: number): Set<string> {
  const hubs = new Set<string>();
  for (const [id, deg] of degree) if (deg >= hubThreshold) hubs.add(id);
  if (hubs.size === 0 && degree.size) {
    let max = 0;
    for (const deg of degree.values()) if (deg > max) max = deg;
    if (max > 0) for (const [id, deg] of degree) if (deg === max) hubs.add(id);
  }
  return hubs;
}

/** Multi-source BFS: distance of every reachable node from the nearest hub
 *  (hubs are distance 0). Unreachable nodes are absent from the map. */
function bfsDistances(adj: Map<string, Set<string>>, hubs: Set<string>): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier: string[] = [];
  for (const h of hubs) { dist.set(h, 0); frontier.push(h); }
  let d = 0;
  while (frontier.length) {
    const next: string[] = [];
    for (const u of frontier) {
      for (const v of adj.get(u) ?? []) {
        if (!dist.has(v)) { dist.set(v, d + 1); next.push(v); }
      }
    }
    frontier = next;
    d++;
  }
  return dist;
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
      group: importProviderLabel(im.provider),
      val: 5 + Math.min(10, importMsgCount(im) * 0.15),
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

  // Orient each link so a directional pulse flows outward from the hub
  // neurons. We BFS-rank every node by its distance from the nearest hub
  // (hubs = the most-connected nodes) and make the hub-closer endpoint the
  // `source`; particles then visibly flow hub → outer rings. This is purely
  // cosmetic (adjacency/hierarchy treat links as undirected) and is exactly
  // the orientation the network-pulse animation rides on, so both the
  // always-on flows and the BFS wave travel the same direction.
  const degree = degreeMap(links);
  const hubThreshold = opts.hubThreshold ?? DEFAULT_HUB_THRESHOLD;
  const hubs = pickHubs(degree, hubThreshold);
  const dist = bfsDistances(adjacencyMap(links), hubs);
  const distOf = (id: string) => dist.get(id) ?? Infinity;
  for (const l of links) {
    const s = l.source as string, t = l.target as string;
    const sd = distOf(s), td = distOf(t);
    // Hub-closer endpoint first; break ties by higher degree.
    const swap = td < sd || (td === sd && (degree.get(t) ?? 0) > (degree.get(s) ?? 0));
    if (swap) { l.source = t; l.target = s; }
  }

  return { nodes, links };
}

// ── Doc clusters (collapse a multi-part ingested doc into one node) ───────────
// Long Hermes/Obsidian docs are split by memory.ts into many chunk-snippets that
// all share a `memoryDocId` (+ memoryPart/memoryParts). Those siblings form a
// visually noisy cluster; we let the UI collapse them to a single placeholder
// node and expand on demand. This is a pure view transform — no data changes.

export interface ClusterDef {
  /** Source doc id shared by every chunk (snippet.memoryDocId). */
  docId: string;
  /** Display title with the "(part N/M)" suffix stripped. */
  label: string;
  /** Graph node ids ("snip:<id>") of the chunk neurons in this cluster. */
  memberIds: string[];
}

/** Find every multi-part (>1) ingested doc and the chunk neurons it owns. */
export function findDocClusters(snippets: SnippetLike[]): ClusterDef[] {
  const groups = new Map<string, SnippetLike[]>();
  for (const s of snippets) {
    if (!s.memoryDocId || !(s.memoryParts && s.memoryParts > 1)) continue;
    const arr = groups.get(s.memoryDocId) ?? [];
    arr.push(s);
    groups.set(s.memoryDocId, arr);
  }
  const out: ClusterDef[] = [];
  for (const [docId, members] of groups) {
    if (members.length < 2) continue; // need at least two visible chunks to cluster
    const ordered = [...members].sort((a, b) => (a.memoryPart ?? 0) - (b.memoryPart ?? 0));
    const rawTitle = ordered[0]?.title || docId;
    const label = rawTitle.replace(/\s*\(part \d+\/\d+\)\s*$/i, '').trim() || docId;
    out.push({ docId, label, memberIds: ordered.map(s => `snip:${s.id}`) });
  }
  return out;
}

/** Replace each collapsed cluster's member nodes with a single 'cluster' node,
 *  rewiring links to it (intra-cluster links dropped, parallel links deduped to
 *  the strongest). Returns the original graph unchanged when nothing collapses. */
export function applyCollapsedClusters(
  graph: BrainGraph,
  clusters: ClusterDef[],
  collapsed: Set<string>,
): BrainGraph {
  const active = clusters.filter(c => collapsed.has(c.docId));
  if (!active.length) return graph;

  // member node id -> cluster node id
  const memberToCluster = new Map<string, string>();
  const clusterNodes: BrainNode[] = [];
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  for (const c of active) {
    const present = c.memberIds.filter(id => nodeById.has(id));
    if (present.length < 2) continue; // not enough still in the graph to be worth collapsing
    const clusterId = `cluster:${c.docId}`;
    for (const id of present) memberToCluster.set(id, clusterId);
    const group = nodeById.get(present[0])?.group ?? 'Uncategorized';
    // Carry the member snippet records (ordered by part) so the detail panel can
    // summarize the whole subnetwork and DeepDive/Ask can use it as context.
    const members = present
      .map(id => nodeById.get(id)?.data)
      .filter(Boolean)
      .sort((a: any, b: any) => (a?.memoryPart ?? 0) - (b?.memoryPart ?? 0));
    clusterNodes.push({
      id: clusterId,
      kind: 'cluster',
      label: c.label,
      group,
      val: 10 + Math.min(16, present.length * 1.5),
      data: { docId: c.docId, count: present.length, memberIds: present, label: c.label, members },
    });
  }
  if (!clusterNodes.length) return graph;

  const nodes = graph.nodes.filter(n => !memberToCluster.has(n.id));
  nodes.push(...clusterNodes);

  // Rewrite + dedupe links through the member→cluster map.
  const remap = (id: string) => memberToCluster.get(id) ?? id;
  const byPair = new Map<string, BrainLink>();
  for (const l of graph.links) {
    const s = remap(endpointId(l.source));
    const t = remap(endpointId(l.target));
    if (!s || !t || s === t) continue; // drop self / intra-cluster links
    const key = s < t ? `${s}|${t}` : `${t}|${s}`;
    const existing = byPair.get(key);
    if (!existing || (l.value ?? 0) > (existing.value ?? 0)) {
      byPair.set(key, { source: s, target: t, kind: l.kind, value: l.value });
    }
  }
  return { nodes, links: Array.from(byPair.values()) };
}

export interface PulseLayers {
  /** Hub node ids the wave starts from (Layer 1). */
  hubs: string[];
  /** rings[d] = the link objects to emit particles on for hop d+1
   *  (rings[0] = hub→ring 2, rings[1] = ring 2→ring 3, …). These are the SAME
   *  link references held in the graph, so they pass straight to
   *  react-force-graph's emitParticle(). */
  rings: BrainLink[][];
}

/** Plan a breadth-first "pulse" wave outward from the hub neurons. Layer 1 =
 *  hubs (nodes with ≥ hubThreshold connections); the wave steps outward one
 *  ring per hop and stops after `maxLayers` total layers. Each ring lists the
 *  links connecting the previous ring to the newly-reached nodes, oriented (by
 *  buildGraph) so emitting a particle flows outward. */
export function computePulseLayers(
  graph: BrainGraph,
  opts: { hubThreshold?: number; maxLayers?: number } = {},
): PulseLayers {
  const hubThreshold = opts.hubThreshold ?? DEFAULT_HUB_THRESHOLD;
  const maxLayers = Math.max(2, opts.maxLayers ?? DEFAULT_SIMILAR_TOP_K);
  const links = graph.links;
  if (!links.length) return { hubs: [], rings: [] };

  const degree = degreeMap(links);
  const hubs = pickHubs(degree, hubThreshold);
  if (hubs.size === 0) return { hubs: [], rings: [] };

  // Recover the actual link object (with its baked-in orientation) for any
  // unordered endpoint pair discovered during the BFS.
  const linkByPair = new Map<string, BrainLink>();
  for (const l of links) {
    const s = endpointId((l as any).source), t = endpointId((l as any).target);
    if (!s || !t) continue;
    const key = s < t ? `${s}|${t}` : `${t}|${s}`;
    if (!linkByPair.has(key)) linkByPair.set(key, l);
  }
  const adj = adjacencyMap(links);

  const visited = new Set<string>(hubs);
  let frontier = Array.from(hubs);
  const rings: BrainLink[][] = [];
  const maxHops = maxLayers - 1; // Layer 1 is the hubs; the rest are hops out.
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = [];
    const ring: BrainLink[] = [];
    for (const u of frontier) {
      for (const v of adj.get(u) ?? []) {
        if (visited.has(v)) continue;
        visited.add(v);
        next.push(v);
        const key = u < v ? `${u}|${v}` : `${v}|${u}`;
        const link = linkByPair.get(key);
        if (link) ring.push(link);
      }
    }
    if (ring.length) rings.push(ring);
    frontier = next;
  }
  return { hubs: Array.from(hubs), rings };
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
      summary: `Imported ${importProviderLabel(im.provider)} conversation, ${importMsgCount(im)} messages.`,
      category: importProviderLabel(im.provider),
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
