import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import ForceGraph2D, { type ForceGraphMethods, type NodeObject, type LinkObject } from 'react-force-graph-2d';
import { Brain, Send, X, Sparkles, MessageSquare, Scissors, Compass, Download as DownloadIcon, Bot, User as UserIcon, Sliders, RotateCcw, Trash2, ChevronRight, ChevronDown, Network, AlertCircle, Search } from 'lucide-react';
import * as db from '../lib/db';
import {
  embedText, cosineSimilarity, chatWithVault, isGeminiReady, onGeminiReadyChange, buildEmbedSource,
  type ChatTurn, type VaultContextItem,
} from '../lib/ai';
import {
  buildGraph, nodeAsContextItem, deepDiveEmbedSource, computePulseLayers,
  DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_SIMILAR_TOP_K, DEFAULT_HUB_THRESHOLD,
  type BrainNode, type BrainLink, type BrainGraph,
} from '../lib/graph';
import { listImports, listAllChunks, onImportsChange, deleteImport, type ImportedConversation, type ImportChunk } from '../lib/imports';
import { setSeed as setDeepDiveSeed } from '../lib/deepdiveSeed';
import { onDeepDivesChange } from '../lib/deepdiveStore';
import { onSnippetsChange, emitSnippetsChange } from '../lib/snippetStore';
import { navigateTo } from '../lib/navigate';
import SnippetEditor, { type CapturedItem } from '../components/SnippetEditor';

interface ChatMessage extends ChatTurn { citedIds?: string[]; }

// Network-pulse animation timing. The wave is the ONLY animation — there is
// no always-on continuous particle flow (that read as constant churn, with a
// dot permanently on every wire). A single uniform photon speed keeps every
// hop the same length, so the cascade reads as one clean ripple spreading
// outward from the hubs. The next wave only starts once the current one has
// fully cleared the wire (+ a short rest) so pulses never overlap — but no
// sooner than the 5s cadence.
const PULSE_WAVE_INTERVAL_MS = 5000; // minimum spacing between waves
const PULSE_GAP_MS = 500;            // quiet rest after a wave fully arrives
const PULSE_SPEED = 0.02;            // wave photon speed (fraction/frame ≈ 0.83s per hop)
/** Milliseconds for a single-hop photon to traverse one link at `speed` (~60fps). */
const photonTravelMs = (speed: number) => (1 / speed / 60) * 1000;
// Each ring fires when the previous ring's dot is ~85% of the way to its
// neuron — a layer-by-layer handoff with just enough overlap to flow smoothly.
const PULSE_STEP_MS = photonTravelMs(PULSE_SPEED) * 0.85;

export default function SecondBrainTab({ active = true }: { active?: boolean }) {
  const [snippets, setSnippets] = useState<any[]>([]);
  const [deepDives, setDeepDives] = useState<any[]>([]);
  const [imports, setImports] = useState<ImportedConversation[]>([]);
  const [chunks, setChunks] = useState<ImportChunk[]>([]);
  const [graph, setGraph] = useState<BrainGraph>({ nodes: [], links: [] });
  const [focusedNode, setFocusedNode] = useState<BrainNode | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [citedIds, setCitedIds] = useState<Set<string>>(new Set());
  const [aiReady, setAiReady] = useState<boolean>(isGeminiReady());
  const [containerSize, setContainerSize] = useState({ w: 800, h: 600 });
  const [nodeMenu, setNodeMenu] = useState<{ node: BrainNode; x: number; y: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BrainNode | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [backfill, setBackfill] = useState<{ done: number; total: number } | null>(null);

  // Left-panel mode + search state (search reuses the snippet keyword+semantic
  // logic, but ranks across every neuron kind that carries an embedding).
  const [leftView, setLeftView] = useState<'ask' | 'search'>('ask');
  const [searchQuery, setSearchQuery] = useState('');
  const [queryEmbedding, setQueryEmbedding] = useState<number[] | null>(null);
  const [isSemanticSearching, setIsSemanticSearching] = useState(false);

  // Live editable copy of the focused snippet. Kept as a synchronous mirror so
  // typing in the editor reflects instantly (the graph reload is debounced).
  const [snippetDraft, setSnippetDraft] = useState<CapturedItem | null>(null);

  const isElectron = !!window.aios?.isElectron;

  // ── Physics controls (persist to db.meta so they survive reloads) ──────────
  const [physics, setPhysics] = useState<PhysicsSettings>(DEFAULT_PHYSICS);
  const [showPhysics, setShowPhysics] = useState(false);
  useEffect(() => {
    db.getMeta<PhysicsSettings>('second-brain-physics')
      .then(p => { if (p) setPhysics({ ...DEFAULT_PHYSICS, ...p }); })
      .catch(() => {});
  }, []);
  useEffect(() => { db.setMeta('second-brain-physics', physics).catch(() => {}); }, [physics]);

  // Debounce connection-slider changes so dragging the threshold / max-links
  // sliders doesn't rebuild the graph (and reset node positions) on every tick.
  const [connOpts, setConnOpts] = useState({ threshold: physics.simThreshold, topK: physics.maxLinks, hubThreshold: physics.pulseHubThreshold });
  useEffect(() => {
    const t = setTimeout(() => setConnOpts({ threshold: physics.simThreshold, topK: physics.maxLinks, hubThreshold: physics.pulseHubThreshold }), 250);
    return () => clearTimeout(t);
  }, [physics.simThreshold, physics.maxLinks, physics.pulseHubThreshold]);

  // Push the slider values into d3-force whenever they change (or after the
  // graph is built — d3 forces are reset when react-force-graph rebuilds).
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const link = fg.d3Force('link') as any;
    const charge = fg.d3Force('charge') as any;
    if (link) {
      link.distance(physics.linkDistance);
      link.strength(physics.linkStrength);
    }
    if (charge) {
      charge.strength(physics.chargeStrength);
    }
    fg.d3ReheatSimulation();
  }, [physics, graph]);

  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => onGeminiReadyChange(setAiReady), []);

  // Load snippets + DeepDive sessions + imported conversations + their chunks
  const loadData = useCallback(async () => {
    try {
      const [snips, dds, imps, chks] = await Promise.all([
        db.getAllSnippets<any>(),
        db.getAllThreads<any>(),
        listImports(),
        listAllChunks(),
      ]);
      setSnippets(snips);
      setDeepDives(dds);
      setImports(imps);
      setChunks(chks);
    } catch (e) { console.error('SecondBrain load failed:', e); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => onImportsChange(() => { loadData(); }), [loadData]);

  // Reactively pick up DeepDive saves/deletes without a manual refresh.
  // If this tab is visible, reload (debounced to coalesce rapid saves); if it's
  // hidden (TabPanel keeps it mounted but display:none), just mark dirty and
  // defer the reload until the tab becomes active again — so we never rebuild
  // the graph in the background for a tab the user isn't looking at.
  const dirtyRef = useRef(false);
  const activeRef = useRef(active);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Id (snip:<id>) of a freshly captured snippet to auto-focus once it appears.
  const pendingFocusRef = useRef<string | null>(null);
  useEffect(() => { activeRef.current = active; }, [active]);

  const scheduleReload = useCallback(() => {
    if (activeRef.current) {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => { dirtyRef.current = false; loadData(); }, 300);
    } else {
      dirtyRef.current = true;
    }
  }, [loadData]);

  useEffect(() => onDeepDivesChange(scheduleReload), [scheduleReload]);

  // Same reactive reload for snippet captures/edits/deletes. A capture carries
  // its new id so we can auto-focus + open the editor once the graph rebuilds.
  useEffect(() => onSnippetsChange((detail) => {
    if (detail?.newId) pendingFocusRef.current = `snip:${detail.newId}`;
    scheduleReload();
  }), [scheduleReload]);

  useEffect(() => {
    if (active && dirtyRef.current) {
      dirtyRef.current = false;
      loadData();
    }
  }, [active, loadData]);

  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current); }, []);

  // Rebuild graph whenever underlying data changes.
  // Compute a conversation-level centroid (mean of chunk embeddings) so
  // imports participate in semantic similarity links the same way snippets do.
  useEffect(() => {
    const centroids = new Map<string, number[]>();
    if (chunks.length) {
      const groups = new Map<string, number[][]>();
      for (const c of chunks) {
        if (!c.embedding?.length) continue;
        const arr = groups.get(c.conversationId) ?? [];
        arr.push(c.embedding);
        groups.set(c.conversationId, arr);
      }
      for (const [convId, vecs] of groups) {
        if (!vecs.length) continue;
        const dim = vecs[0].length;
        const mean = new Array(dim).fill(0);
        for (const v of vecs) for (let i = 0; i < dim; i++) mean[i] += v[i];
        for (let i = 0; i < dim; i++) mean[i] /= vecs.length;
        centroids.set(convId, mean);
      }
    }
    const importsForGraph = imports.map(im => ({ ...im, embedding: centroids.get(im.id) }));
    setGraph(buildGraph(snippets, deepDives, importsForGraph, {
      threshold: connOpts.threshold,
      topK: connOpts.topK,
      hubThreshold: connOpts.hubThreshold,
    }));
  }, [snippets, deepDives, imports, chunks, connOpts]);

  // Plan the breadth-first pulse wave: Layer 1 = hubs (≥ hubThreshold links),
  // then one ring outward per hop, capped at "Max links / node" total layers.
  // Recomputed whenever the graph or the connection sliders change. The link
  // objects in here are the same references react-force-graph renders, so they
  // can be passed straight to emitParticle().
  const pulseLayers = useMemo(
    () => computePulseLayers(graph, { hubThreshold: connOpts.hubThreshold, maxLayers: connOpts.topK }),
    [graph, connOpts.hubThreshold, connOpts.topK],
  );

  // Network pulse: every PULSE_WAVE_INTERVAL_MS, fire a wave of particles that
  // starts at the hub neurons and cascades outward ring-by-ring. Rides on top
  // of the always-on continuous flows via react-force-graph's emitParticle().
  // We read the latest plan through a ref so retuning the sliders doesn't reset
  // the wave clock — only mounting / the graph appearing does.
  const pulseRef = useRef(pulseLayers);
  useEffect(() => { pulseRef.current = pulseLayers; }, [pulseLayers]);
  const waveTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const hasGraph = graph.nodes.length > 0;
  useEffect(() => {
    if (!active || !hasGraph) return;
    let cancelled = false;
    let nextWave: ReturnType<typeof setTimeout> | undefined;

    const fireWave = () => {
      if (cancelled) return;
      // Clear any stragglers from the previous wave so the timer list is bounded.
      waveTimers.current.forEach(clearTimeout);
      waveTimers.current = [];

      const fg = fgRef.current as any;
      const rings = pulseRef.current.rings;
      let waveDurationMs = 0;
      if (fg?.emitParticle && rings.length) {
        rings.forEach((ring, i) => {
          waveTimers.current.push(setTimeout(() => {
            for (const link of ring) {
              try { fg.emitParticle(link); } catch { /* link not hydrated yet — next wave catches it */ }
            }
          }, i * PULSE_STEP_MS));
        });
        // Wave is fully done once the last ring's photon finishes its hop.
        waveDurationMs = (rings.length - 1) * PULSE_STEP_MS + photonTravelMs(PULSE_SPEED);
      }

      // Start the next wave only after this one has fully cleared the wire (+ a
      // rest), but never tighter than the 5s cadence — so pulses never overlap.
      const delay = Math.max(PULSE_WAVE_INTERVAL_MS, waveDurationMs + PULSE_GAP_MS);
      nextWave = setTimeout(fireWave, delay);
    };

    const kickoff = setTimeout(fireWave, 800); // first wave shortly after the graph settles
    return () => {
      cancelled = true;
      clearTimeout(kickoff);
      if (nextWave) clearTimeout(nextWave);
      waveTimers.current.forEach(clearTimeout);
      waveTimers.current = [];
    };
  }, [active, hasGraph]);

  // Nodes that can't form semantic links yet because they have no embedding
  // (older snippets saved before Gemini was configured, or DeepDives saved
  // before save-time embedding). The backfill button embeds them on demand.
  const unembedded = useMemo(() => {
    const s = snippets.filter((x: any) => x.status === 'ready' && !(x.embedding?.length) && (x.extractedText || x.summary || x.title)).length;
    const d = deepDives.filter((x: any) => !(x.embedding?.length)).length;
    return s + d;
  }, [snippets, deepDives]);

  const runBackfill = useCallback(async () => {
    if (!aiReady || backfill) return;
    const sTodo = snippets.filter((x: any) => x.status === 'ready' && !(x.embedding?.length) && (x.extractedText || x.summary || x.title));
    const dTodo = deepDives.filter((x: any) => !(x.embedding?.length));
    const total = sTodo.length + dTodo.length;
    if (!total) return;
    setBackfill({ done: 0, total });
    let done = 0;
    try {
      for (const s of sTodo) {
        try {
          const src = buildEmbedSource({
            title: s.title || '', summary: s.summary || '', tags: s.tags || [],
            extractedText: s.extractedText || '', category: s.category || '', source: s.source || '',
          });
          const emb = await embedText(src);
          if (emb.length) await db.putSnippet({ ...s, embedding: emb });
        } catch (e) { console.error('backfill: snippet failed', s.id, e); }
        setBackfill({ done: ++done, total });
      }
      for (const dd of dTodo) {
        try {
          const src = deepDiveEmbedSource(dd);
          if (src) {
            const emb = await embedText(src);
            if (emb.length) await db.putThread({ ...dd, embedding: emb });
          }
        } catch (e) { console.error('backfill: deepdive failed', dd.id, e); }
        setBackfill({ done: ++done, total });
      }
    } finally {
      setBackfill(null);
      loadData();
    }
  }, [aiReady, backfill, snippets, deepDives, loadData]);

  // Track container size for the graph canvas
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setContainerSize({ w: Math.max(300, r.width), h: Math.max(300, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chatHistory]);

  // Persist chat history
  useEffect(() => {
    db.getMeta<ChatMessage[]>('second-brain-chat-history')
      .then(saved => { if (saved && saved.length) setChatHistory(saved); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (chatBusy) return;
    db.setMeta('second-brain-chat-history', chatHistory).catch(() => {});
  }, [chatHistory, chatBusy]);

  const send = async () => {
    const q = chatInput.trim();
    if (!q || chatBusy) return;
    if (!aiReady) {
      setChatHistory(h => [...h, { role: 'user', text: q }, { role: 'model', text: 'AI is not configured. Add your Gemini key in the Models tab.' }]);
      setChatInput('');
      return;
    }
    setChatInput('');
    setChatBusy(true);
    const prior: ChatTurn[] = chatHistory.map(({ role, text }) => ({ role, text }));
    setChatHistory(h => [...h, { role: 'user', text: q }, { role: 'model', text: '' }]);

    try {
      const queryVec = await embedText(q);

      // Semantic ranking across snippets that have embeddings.
      const embedded = snippets.filter(s => s.embedding?.length && s.status === 'ready');
      const snipRanked = embedded
        .map(s => ({ kind: 'snip' as const, item: s, sim: cosineSimilarity(queryVec, s.embedding) }))
        .sort((a, b) => b.sim - a.sim);

      // Keyword ranking across DeepDive sessions (text-only fallback for now).
      const qLower = q.toLowerCase();
      const ddScored = deepDives.map(dd => {
        const hay = [
          dd.title, dd.description,
          ...(dd.mainMessages ?? []).map((m: any) => m?.content ?? ''),
          ...((dd.threads ?? []).flatMap((t: any) => (t.messages ?? []).map((m: any) => m?.content ?? ''))),
        ].join(' ').toLowerCase();
        const hits = qLower.split(/\s+/).filter(Boolean).reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0);
        return { dd, score: hits };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

      // Semantic ranking across import chunks (Claude / ChatGPT history)
      const chunkRanked = chunks
        .filter(c => c.embedding?.length)
        .map(c => ({ chunk: c, sim: cosineSimilarity(queryVec, c.embedding) }))
        .sort((a, b) => b.sim - a.sim);

      const TOP_SNIPS = 6;
      const TOP_DDS = 3;
      const TOP_CHUNKS = 6;

      const context: VaultContextItem[] = [
        ...snipRanked.slice(0, TOP_SNIPS).filter(r => r.sim >= 0.4).map(r => ({
          id: `snip:${r.item.id}`,
          title: r.item.title || '',
          summary: r.item.summary || '',
          category: r.item.category || 'Uncategorized',
          source: r.item.source || '',
          tags: r.item.tags || [],
          extractedText: r.item.extractedText || '',
          timestamp: r.item.timestamp || 0,
        })),
        ...chunkRanked.slice(0, TOP_CHUNKS).filter(r => r.sim >= 0.4).map(r => ({
          id: `chunk:${r.chunk.id}`,
          title: r.chunk.conversationTitle || '(untitled)',
          summary: `Turn ${r.chunk.turnIndex} of ${r.chunk.provider === 'claude' ? 'Claude' : 'ChatGPT'} chat`,
          category: r.chunk.provider === 'claude' ? 'Claude' : 'ChatGPT',
          source: 'Imported',
          tags: [],
          extractedText: r.chunk.text,
          timestamp: r.chunk.createdAt || 0,
        })),
        ...ddScored.slice(0, TOP_DDS).map(({ dd }) => {
          const node: BrainNode = { id: `dd:${dd.id}`, kind: 'deepdive', label: dd.title, group: 'DeepDive', val: 0, data: dd };
          return nodeAsContextItem(node);
        }),
      ];

      const cited = new Set<string>(context.map(c => c.id));
      setCitedIds(cited);

      let acc = '';
      for await (const chunk of chatWithVault(prior, q, context)) {
        acc += chunk;
        setChatHistory(h => {
          const next = [...h];
          next[next.length - 1] = { role: 'model', text: acc, citedIds: Array.from(cited) };
          return next;
        });
      }
    } catch (err: any) {
      console.error('Second Brain chat failed:', err);
      setChatHistory(h => {
        const next = [...h];
        next[next.length - 1] = { role: 'model', text: 'Error: ' + (err?.message ?? String(err)) };
        return next;
      });
    } finally { setChatBusy(false); }
  };

  // Search across every neuron that carries an embedding (snippets, deepdives,
  // imports) plus a keyword fallback over label/summary/tags/extractedText.
  // Returns null when there's no active query so the graph renders normally.
  const SEARCH_SIM_THRESHOLD = 0.5;
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length < 2) return null;
    const keyword = (n: BrainNode) => {
      const d: any = n.data || {};
      return (n.label || '').toLowerCase().includes(q)
        || (d.summary || '').toLowerCase().includes(q)
        || (d.extractedText || '').toLowerCase().includes(q)
        || (Array.isArray(d.tags) && d.tags.some((t: string) => (t || '').toLowerCase().includes(q)));
    };
    const scored = graph.nodes.map(n => {
      const emb = (n.data as any)?.embedding;
      const sim = (queryEmbedding && emb?.length) ? cosineSimilarity(queryEmbedding, emb) : 0;
      return { node: n, sim, kw: keyword(n) };
    }).filter(x => x.sim >= SEARCH_SIM_THRESHOLD || x.kw)
      .sort((a, b) => b.sim - a.sim);
    return { results: scored.map(x => x.node), ids: new Set(scored.map(x => x.node.id)) };
  }, [searchQuery, queryEmbedding, graph]);

  // Node color: cited > focused > search-dim > grouped (by category)
  const groupColors = useMemo(() => {
    const palette = ['#7c9cff', '#5ee6b0', '#ffb86b', '#ff7ad9', '#a78bfa', '#f87171', '#22d3ee', '#facc15', '#fb923c', '#34d399'];
    const groups = Array.from(new Set(graph.nodes.map(n => n.group)));
    const map: Record<string, string> = {};
    groups.forEach((g, i) => { map[g] = g === 'DeepDive' ? '#a78bfa' : palette[i % palette.length]; });
    return map;
  }, [graph]);

  const nodeColor = useCallback((n: NodeObject) => {
    const node = n as BrainNode;
    if (citedIds.has(node.id)) return '#fde047'; // bright yellow for cited
    if (focusedNode?.id === node.id) return '#ffffff';
    // When a search is active, dim everything that doesn't match.
    if (searchResults && !searchResults.ids.has(node.id)) return 'rgba(110,114,128,0.18)';
    return groupColors[node.group] || '#9ca3af';
  }, [citedIds, focusedNode, groupColors, searchResults]);

  const linkColor = useCallback((l: LinkObject) => {
    const link = l as unknown as BrainLink;
    if (link.kind === 'origin') return 'rgba(124,156,255,0.55)';
    if (link.kind === 'similar') return 'rgba(94,230,176,0.25)';
    if (link.kind === 'similar-soft') return 'rgba(94,230,176,0.10)';
    return 'rgba(255,255,255,0.12)';
  }, []);

  // Links touching the focused node form the "selected network" — they pulse
  // faster than the rest. source/target are id strings until react-force-graph
  // hydrates them into node objects, so handle both.
  const linkIsFocused = useCallback((l: any) => {
    if (!focusedNode) return false;
    const s = typeof l.source === 'object' ? l.source?.id : l.source;
    const t = typeof l.target === 'object' ? l.target?.id : l.target;
    return s === focusedNode.id || t === focusedNode.id;
  }, [focusedNode]);

  const onNodeClick = useCallback((n: NodeObject) => {
    const node = n as BrainNode;
    setFocusedNode(node);
    // Center & zoom on it
    if (fgRef.current && typeof (n as any).x === 'number' && typeof (n as any).y === 'number') {
      fgRef.current.centerAt((n as any).x, (n as any).y, 600);
      fgRef.current.zoom(2.4, 600);
    }
  }, []);

  const askAboutFocused = () => {
    if (!focusedNode) return;
    setChatInput(`Tell me about "${focusedNode.label}"`);
  };

  // Quick lookups for the hierarchy tree. react-force-graph mutates link
  // source/target from id strings into node objects once rendered, so normalize.
  const nodeById = useMemo(() => {
    const m = new Map<string, BrainNode>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  // Debounced query embedding for semantic search (mirrors the Snippit tab).
  useEffect(() => {
    const q = searchQuery.trim();
    if (!aiReady || q.length < 3) { setQueryEmbedding(null); setIsSemanticSearching(false); return; }
    setIsSemanticSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      embedText(q)
        .then(vec => { if (!cancelled) { setQueryEmbedding(vec); setIsSemanticSearching(false); } })
        .catch(err => { if (!cancelled) { console.error('Search embedding failed:', err); setQueryEmbedding(null); setIsSemanticSearching(false); } });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchQuery, aiReady]);

  // After every graph rebuild, re-resolve the focused node by id so the open
  // detail/editor panel survives the rebuild (buildGraph creates fresh node
  // objects). If it vanished (e.g. deleted), close the panel. Also fire any
  // pending auto-focus for a freshly captured snippet.
  useEffect(() => {
    setFocusedNode(prev => (prev ? (nodeById.get(prev.id) ?? null) : prev));
    const pid = pendingFocusRef.current;
    if (pid && activeRef.current) {
      const node = nodeById.get(pid);
      if (node) { pendingFocusRef.current = null; onNodeClick(node as any); }
    }
  }, [nodeById, onNodeClick]);

  // Keep the editable snippet draft in sync with the focused node — including
  // when its underlying data changes out from under us (e.g. an "Add Shot"
  // capture OCRs in the background and appends an image + extracted text).
  // Depending on the focusedNode object (re-resolved on every rebuild) means
  // external updates flow into the open editor live. Active typing is safe:
  // edits persist + emit, and the reload that rebuilds the graph is debounced
  // 300ms after the last keystroke, so node.data has caught up by then.
  useEffect(() => {
    if (focusedNode?.kind === 'snippet') setSnippetDraft(focusedNode.data as CapturedItem);
    else setSnippetDraft(null);
  }, [focusedNode]);

  // Persist an edit from the snippet editor: update the synchronous draft now,
  // write to SQLite, and notify other tabs (which triggers a debounced reload
  // here that rebuilds the graph once edits settle).
  const persistSnippet = useCallback((next: CapturedItem) => {
    setSnippetDraft(next);
    db.putSnippet(next).then(() => emitSnippetsChange()).catch(e => console.error('Failed to persist snippet edit:', e));
  }, []);

  // Category suggestions for the snippet editor's datalist.
  const categories = useMemo(
    () => Array.from(new Set(snippets.map((s: any) => s.category).filter(Boolean))) as string[],
    [snippets],
  );

  const adjacency = useMemo(() => {
    const idOf = (x: any) => (x && typeof x === 'object' ? x.id : x);
    const m = new Map<string, Set<string>>();
    for (const l of graph.links as any[]) {
      const s = idOf(l.source);
      const t = idOf(l.target);
      if (!s || !t) continue;
      if (!m.has(s)) m.set(s, new Set());
      if (!m.has(t)) m.set(t, new Set());
      m.get(s)!.add(t);
      m.get(t)!.add(s);
    }
    return m;
  }, [graph]);

  // Delete a neuron: remove the underlying record and prune local state so the
  // graph rebuilds without it.
  const deleteNode = async (node: BrainNode) => {
    setIsDeleting(true);
    try {
      if (node.kind === 'snippet') {
        await db.removeSnippet(node.data.id);
        setSnippets(prev => prev.filter(s => s.id !== node.data.id));
        emitSnippetsChange(); // keep the Snippit tab in sync
      } else if (node.kind === 'deepdive') {
        await db.removeThread(node.data.id);
        setDeepDives(prev => prev.filter(d => d.id !== node.data.id));
      } else if (node.kind === 'import') {
        await deleteImport(node.data.id); // also clears chunks + emits change
        setImports(prev => prev.filter(im => im.id !== node.data.id));
      }
      setCitedIds(prev => { const n = new Set(prev); n.delete(node.id); return n; });
      if (focusedNode?.id === node.id) setFocusedNode(null);
      setNodeMenu(null);
      setPendingDelete(null);
    } catch (e: any) {
      console.error('Failed to delete neuron:', e);
      alert(`Failed to delete: ${e?.message ?? e}`);
    } finally {
      setIsDeleting(false);
    }
  };

  // Close the right-click menu on any outside interaction.
  useEffect(() => {
    if (!nodeMenu) return;
    const close = () => setNodeMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', close); };
  }, [nodeMenu]);

  const stats = useMemo(() => {
    const snipCount = graph.nodes.filter(n => n.kind === 'snippet').length;
    const ddCount = graph.nodes.filter(n => n.kind === 'deepdive').length;
    const linkCount = graph.links.length;
    const categories = new Set(graph.nodes.filter(n => n.kind === 'snippet').map(n => n.group)).size;
    return { snipCount, ddCount, linkCount, categories };
  }, [graph]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="h-14 border-b border-zinc-800 px-6 flex items-center justify-between bg-zinc-900/60 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-zinc-800 rounded-md"><Brain className="w-4 h-4 text-indigo-400" /></div>
          <h2 className="text-sm font-bold text-white">Second Brain</h2>
          <span className="text-[10px] text-zinc-500 uppercase tracking-widest">
            {stats.snipCount} snips · {stats.ddCount} deepdives · {stats.categories} categories · {stats.linkCount} links
          </span>
        </div>
        <button onClick={loadData} className="text-[10px] text-zinc-500 hover:text-indigo-400 uppercase tracking-widest">Refresh</button>
      </header>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left 1/3 — Ask (chat) or Search */}
        <aside className="w-1/3 min-w-[320px] max-w-[480px] border-r border-zinc-800 flex flex-col bg-zinc-950">
          <div className="px-5 py-4 border-b border-zinc-800">
            <div className="flex items-center gap-1 bg-zinc-900/60 p-1 rounded-lg border border-zinc-800 mb-3">
              <button onClick={() => setLeftView('ask')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1 rounded text-xs font-bold uppercase tracking-wider transition-colors ${leftView === 'ask' ? 'bg-indigo-600/20 text-indigo-300' : 'text-zinc-500 hover:text-white'}`}>
                <Sparkles className="w-3.5 h-3.5" />Ask
              </button>
              <button onClick={() => setLeftView('search')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1 rounded text-xs font-bold uppercase tracking-wider transition-colors ${leftView === 'search' ? 'bg-indigo-600/20 text-indigo-300' : 'text-zinc-500 hover:text-white'}`}>
                <Search className="w-3.5 h-3.5" />Search
              </button>
            </div>
            {leftView === 'ask' ? (
              <p className="text-[11px] text-zinc-500">Queries retrieve across all snippets and DeepDive sessions. Cited items light up in the graph.</p>
            ) : (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
                <input type="text"
                  autoFocus
                  placeholder={aiReady ? "Search your neurons in plain English…" : "Search titles, summaries, tags…"}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 pl-9 pr-20 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                  value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                  {isSemanticSearching && <span className="text-[9px] text-amber-400 uppercase tracking-widest animate-pulse">Embedding…</span>}
                  {!isSemanticSearching && queryEmbedding && <span className="text-[9px] text-indigo-400 uppercase tracking-widest">Semantic</span>}
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} title="Clear search"
                      className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-zinc-700/60 transition-colors">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {leftView === 'ask' ? (
            <>
              <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 scrollbar-hide">
                {chatHistory.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center text-center py-12 space-y-3">
                    <Brain className="w-8 h-8 text-indigo-500/40" />
                    <p className="text-xs text-zinc-500 max-w-[240px] leading-relaxed">
                      Ask anything across your captured knowledge. Try: <em>"what did I learn about Houdini cameras"</em>, <em>"summarize my recent research"</em>, or click a node in the graph.
                    </p>
                  </div>
                )}

                {chatHistory.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 ${msg.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-zinc-900 border border-zinc-800 text-zinc-200'}`}>
                      <p className="text-xs whitespace-pre-wrap leading-relaxed">{msg.text || (chatBusy && i === chatHistory.length - 1 ? '…' : '')}</p>
                      {msg.role === 'model' && msg.citedIds && msg.citedIds.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-zinc-800/80 flex flex-wrap gap-1.5">
                          {msg.citedIds.slice(0, 8).map(id => {
                            const node = graph.nodes.find(n => n.id === id);
                            if (!node) return null;
                            const Icon = node.kind === 'snippet' ? Scissors : Compass;
                            return (
                              <button key={id} onClick={() => onNodeClick(node as any)}
                                className="text-[9px] px-2 py-0.5 bg-yellow-500/10 border border-yellow-500/30 rounded-full text-yellow-300 hover:bg-yellow-500/20 transition-colors inline-flex items-center gap-1">
                                <Icon className="w-2.5 h-2.5" />
                                {node.label.slice(0, 28)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-zinc-800 p-3">
                <div className="flex gap-1.5 items-end">
                  <textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                    rows={1}
                    disabled={chatBusy || !aiReady}
                    placeholder={aiReady ? 'Ask anything…' : 'Add Gemini key in Models tab'}
                    className="flex-1 resize-none bg-zinc-900 border border-zinc-800 rounded-xl py-2.5 px-3 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all max-h-32 disabled:opacity-50"
                  />
                  <button onClick={send} disabled={chatBusy || !aiReady || !chatInput.trim()}
                    className="p-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-xl text-white transition-colors">
                    <Send className="w-3.5 h-3.5" />
                  </button>
                </div>
                {chatHistory.length > 0 && (
                  <button onClick={() => { setChatHistory([]); setCitedIds(new Set()); db.setMeta('second-brain-chat-history', []).catch(() => {}); }}
                    className="mt-1.5 text-[9px] text-zinc-600 hover:text-zinc-400 uppercase tracking-widest">
                    Clear conversation
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5 scrollbar-hide">
              {!searchResults && (
                <div className="h-full flex flex-col items-center justify-center text-center py-12 space-y-3">
                  <Search className="w-8 h-8 text-indigo-500/40" />
                  <p className="text-xs text-zinc-500 max-w-[240px] leading-relaxed">
                    Search every neuron — snippets, DeepDives, and imports. Matches light up in the graph; click one to open it.
                  </p>
                </div>
              )}
              {searchResults && searchResults.results.length === 0 && (
                <p className="text-xs text-zinc-500 italic px-2 py-4 text-center">No neurons match "{searchQuery}".</p>
              )}
              {searchResults && searchResults.results.length > 0 && (
                <>
                  <div className="px-2 pb-1 text-[10px] uppercase tracking-widest text-zinc-600 font-bold">
                    {searchResults.results.length} match{searchResults.results.length === 1 ? '' : 'es'}
                  </div>
                  {searchResults.results.map(node => {
                    const Icon = kindIcon(node.kind);
                    const d: any = node.data || {};
                    return (
                      <button key={node.id} onClick={() => onNodeClick(node as any)}
                        className={`w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left transition-colors ${focusedNode?.id === node.id ? 'bg-indigo-600/20 border border-indigo-500/30' : 'hover:bg-zinc-800/60 border border-transparent'}`}>
                        <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-indigo-300" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-semibold text-zinc-100 truncate">{node.label}</div>
                          <div className="text-[10px] text-zinc-500 uppercase tracking-widest">{node.group}</div>
                          {d.summary && <div className="text-[11px] text-zinc-400 leading-snug line-clamp-2 mt-0.5">{d.summary}</div>}
                        </div>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </aside>

        {/* Right 2/3 — force-directed graph */}
        <div ref={containerRef} onContextMenu={(e) => e.preventDefault()} className="flex-1 relative bg-gradient-to-br from-zinc-950 via-zinc-950 to-zinc-900 overflow-hidden">
          {graph.nodes.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8 space-y-4">
              <div className="w-24 h-24 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center relative">
                <Brain className="w-10 h-10 text-zinc-800" />
                <div className="absolute inset-0 border-2 border-indigo-500/20 rounded-full animate-ping" />
              </div>
              <div className="max-w-sm">
                <p className="text-lg font-bold text-zinc-400 mb-1">Your Second Brain is empty</p>
                <p className="text-xs text-zinc-600 leading-relaxed">Capture some snippets and save a DeepDive — they'll appear here as a graph showing how everything relates.</p>
              </div>
            </div>
          ) : (
            <ForceGraph2D
              ref={fgRef as any}
              width={containerSize.w}
              height={containerSize.h}
              graphData={graph as any}
              nodeId="id"
              nodeVal="val"
              nodeLabel={(n) => {
                const node = n as unknown as BrainNode;
                const kind = node.kind === 'snippet' ? 'Snippet' : 'DeepDive';
                return `<div style="background:#11141a;border:1px solid #2D3441;color:#e6e8ec;padding:6px 10px;border-radius:8px;font-family:ui-sans-serif,system-ui;font-size:11px;max-width:260px"><div style="font-weight:700;margin-bottom:2px">${kind} · ${node.group}</div><div>${escapeHtml(node.label)}</div></div>`;
              }}
              nodeColor={nodeColor}
              linkColor={linkColor as any}
              linkWidth={(l) => Math.min(2.5, ((l as any).value ?? 1) * 0.4)}
              // No continuous emission — dots exist only as the BFS pulse wave
              // we emit() by hand, so the wires are still between pulses.
              linkDirectionalParticles={0}
              linkDirectionalParticleSpeed={PULSE_SPEED}
              linkDirectionalParticleWidth={(l) => (linkIsFocused(l) ? 3.5 : 2.5)}
              linkDirectionalParticleColor={(l) => {
                const k = (l as any).kind;
                if (k === 'origin') return '#7c9cff';
                if (k === 'similar') return '#5ee6b0';
                if (k === 'similar-soft') return 'rgba(94,230,176,0.55)';
                return 'rgba(255,255,255,0.5)';
              }}
              cooldownTicks={120}
              warmupTicks={20}
              onNodeClick={onNodeClick}
              onNodeRightClick={(n, e) => {
                const node = n as unknown as BrainNode;
                setFocusedNode(node);
                setNodeMenu({ node, x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
              }}
              onBackgroundClick={() => { setFocusedNode(null); setNodeMenu(null); }}
              backgroundColor="rgba(0,0,0,0)"
              enableNodeDrag={true}
              minZoom={0.2}
              maxZoom={8}
            />
          )}

          {/* Navigable hierarchy tree — upper-left, rooted at the selected node */}
          <AnimatePresence>
            {focusedNode && (
              <HierarchyPanel
                root={focusedNode}
                nodeById={nodeById}
                adjacency={adjacency}
                onSelect={(node) => onNodeClick(node as any)}
                onClose={() => setFocusedNode(null)}
              />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {focusedNode && (
              <NeuronDetailPanel
                node={focusedNode}
                allChunks={chunks}
                snippetDraft={snippetDraft}
                onPersistSnippet={persistSnippet}
                aiReady={aiReady}
                categories={categories}
                isElectron={isElectron}
                onClose={() => setFocusedNode(null)}
                onAsk={askAboutFocused}
                onDelete={() => setPendingDelete(focusedNode)}
                onDeepDive={() => {
                  const seed = nodeToSeed(focusedNode, chunks);
                  if (!seed) return;
                  setDeepDiveSeed(seed);
                  setFocusedNode(null);
                  navigateTo('deepdives');
                }}
              />
            )}
          </AnimatePresence>

          {/* Right-click context menu */}
          {nodeMenu && (
            <div
              className="fixed z-30 min-w-[180px] bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl py-1"
              style={{ left: nodeMenu.x, top: nodeMenu.y }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-800 truncate">
                {nodeMenu.node.label}
              </div>
              <button
                onClick={() => { setPendingDelete(nodeMenu.node); setNodeMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete neuron
              </button>
            </div>
          )}

          {/* Physics controls */}
          {graph.nodes.length > 0 && (
            <PhysicsPanel
              open={showPhysics}
              onToggle={() => setShowPhysics(o => !o)}
              physics={physics}
              setPhysics={setPhysics}
              onReset={() => setPhysics(DEFAULT_PHYSICS)}
              unembedded={unembedded}
              backfill={backfill}
              onBackfill={runBackfill}
              aiReady={aiReady}
            />
          )}

          {/* Legend */}
          {graph.nodes.length > 0 && (
            <div className="absolute bottom-4 right-4 bg-zinc-900/80 backdrop-blur-md border border-zinc-800 rounded-lg p-3 text-[10px] space-y-1.5">
              <div className="font-bold text-zinc-500 uppercase tracking-widest mb-1">Legend</div>
              <div className="flex items-center gap-2"><span className="inline-block w-2 h-2 rounded-full bg-[#a78bfa]" /><span className="text-zinc-400">DeepDive session</span></div>
              <div className="flex items-center gap-2"><span className="inline-block w-2 h-2 rounded-full bg-[#5ee6b0]" /><span className="text-zinc-400">Snippet (color = category)</span></div>
              <div className="flex items-center gap-2"><span className="inline-block w-2 h-2 rounded-full bg-[#fde047]" /><span className="text-zinc-400">Cited by current answer</span></div>
              <div className="flex items-center gap-2"><span className="inline-block w-2.5 h-px bg-[#7c9cff]" /><span className="text-zinc-400">Origin link</span></div>
              <div className="flex items-center gap-2"><span className="inline-block w-2.5 h-px bg-[#5ee6b0]/60" /><span className="text-zinc-400">Semantic similarity</span></div>
              <div className="flex items-center gap-2"><span className="inline-block w-2.5 h-px bg-white/20" /><span className="text-zinc-400">Shared tags</span></div>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation — styled to match AIOS */}
      <AnimatePresence>
        {pendingDelete && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[160] bg-black/90 backdrop-blur-xl flex items-center justify-center p-8"
            onClick={() => !isDeleting && setPendingDelete(null)}>
            <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
              className="max-w-md w-full bg-zinc-900/60 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl relative"
              onClick={(e) => e.stopPropagation()}>
              <div className="p-8 space-y-6">
                <header>
                  <div className="px-3 py-1 inline-flex items-center gap-1.5 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 font-bold text-[10px] uppercase tracking-widest mb-3">
                    <AlertCircle className="w-3 h-3" /> Delete neuron
                  </div>
                  <h2 className="text-xl font-bold text-zinc-100 leading-tight">Delete “{pendingDelete.label}”?</h2>
                  <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
                    This permanently removes the underlying {pendingDelete.kind === 'snippet' ? 'snippet' : pendingDelete.kind === 'deepdive' ? 'DeepDive session' : 'imported conversation'} from your vault. This can’t be undone.
                  </p>
                </header>
                <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                  <button onClick={() => setPendingDelete(null)} disabled={isDeleting}
                    className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-zinc-400 hover:text-white transition-colors">
                    Cancel
                  </button>
                  <button onClick={() => deleteNode(pendingDelete)} disabled={isDeleting}
                    className="flex items-center gap-1.5 px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-[11px] font-bold rounded-lg transition-all active:scale-95 uppercase tracking-wider">
                    <Trash2 className="w-3.5 h-3.5" />{isDeleting ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Navigable hierarchy tree ─────────────────────────────────────────────────

function kindIcon(kind: BrainNode['kind']) {
  if (kind === 'snippet') return Scissors;
  if (kind === 'deepdive') return Compass;
  return DownloadIcon;
}

function HierarchyPanel({
  root, nodeById, adjacency, onSelect, onClose,
}: {
  root: BrainNode;
  nodeById: Map<string, BrainNode>;
  adjacency: Map<string, Set<string>>;
  onSelect: (node: BrainNode) => void;
  onClose: () => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <motion.div
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.15 }}
      onMouseDown={stop}
      onClick={stop}
      className="absolute top-4 left-4 w-[280px] max-h-[60%] bg-zinc-950/95 backdrop-blur-xl border border-zinc-800 rounded-xl shadow-2xl flex flex-col overflow-hidden z-20"
    >
      <header className="h-10 px-3 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <Network className="w-3.5 h-3.5 text-indigo-300" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-300">Hierarchy</span>
        <button onClick={onClose} className="ml-auto p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800">
          <X className="w-3.5 h-3.5" />
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 scrollbar-hide">
        {/* key on root id so the tree fully resets when a different node is selected */}
        <TreeNode
          key={root.id}
          nodeId={root.id}
          ancestorIds={new Set()}
          depth={0}
          isRoot
          nodeById={nodeById}
          adjacency={adjacency}
          onSelect={onSelect}
        />
      </div>
    </motion.div>
  );
}

function TreeNode({
  nodeId, ancestorIds, depth, isRoot, nodeById, adjacency, onSelect,
}: {
  nodeId: string;
  ancestorIds: Set<string>;
  depth: number;
  isRoot?: boolean;
  nodeById: Map<string, BrainNode>;
  adjacency: Map<string, Set<string>>;
  onSelect: (node: BrainNode) => void;
}) {
  const [expanded, setExpanded] = useState(isRoot);
  const node = nodeById.get(nodeId);
  if (!node) return null;

  // Children = connected neurons, excluding ancestors so we don't loop back.
  const childIds = Array.from(adjacency.get(nodeId) ?? []).filter(id => !ancestorIds.has(id) && nodeById.has(id));
  childIds.sort((a, b) => (nodeById.get(a)?.label ?? '').localeCompare(nodeById.get(b)?.label ?? ''));
  const hasChildren = childIds.length > 0;
  const Icon = kindIcon(node.kind);

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-md hover:bg-zinc-800/60 ${isRoot ? 'bg-zinc-800/40' : ''}`}
        style={{ paddingLeft: depth * 12 }}
      >
        {hasChildren ? (
          <button onClick={() => setExpanded(e => !e)} className="p-1 text-zinc-500 hover:text-white shrink-0" title={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <button
          onClick={() => onSelect(node)}
          className="flex items-center gap-1.5 py-1 pr-2 min-w-0 flex-1 text-left"
          title={`${node.group} · click to focus`}
        >
          <Icon className={`w-3 h-3 shrink-0 ${isRoot ? 'text-indigo-300' : 'text-zinc-500 group-hover:text-zinc-300'}`} />
          <span className={`text-[11px] truncate ${isRoot ? 'text-zinc-100 font-semibold' : 'text-zinc-300'}`}>{node.label}</span>
          {hasChildren && <span className="ml-auto text-[9px] text-zinc-600 shrink-0">{childIds.length}</span>}
        </button>
      </div>
      {expanded && hasChildren && (
        <div>
          {childIds.map(cid => (
            <TreeNode
              key={cid}
              nodeId={cid}
              ancestorIds={new Set([...ancestorIds, nodeId])}
              depth={depth + 1}
              nodeById={nodeById}
              adjacency={adjacency}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      {isRoot && !hasChildren && (
        <p className="text-[10px] text-zinc-600 italic px-2 py-2">No connected neurons.</p>
      )}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

// ── Physics controls ─────────────────────────────────────────────────────────

interface PhysicsSettings {
  linkDistance: number;      // d3 link force distance
  linkStrength: number;      // d3 link force strength (higher = tighter clusters)
  chargeStrength: number;    // d3 charge force; negative = repulsion
  simThreshold: number;      // min cosine similarity for a semantic link (lower = more links)
  maxLinks: number;          // max semantic neighbors kept per node (top-K); also caps pulse layers
  pulseHubThreshold: number; // min connections for a node to seed the pulse (Layer 1)
}

const DEFAULT_PHYSICS: PhysicsSettings = {
  linkDistance: 100,
  linkStrength: 1,
  chargeStrength: -100,
  simThreshold: DEFAULT_SIMILARITY_THRESHOLD,
  maxLinks: DEFAULT_SIMILAR_TOP_K,
  pulseHubThreshold: DEFAULT_HUB_THRESHOLD,
};

function PhysicsPanel({
  open, onToggle, physics, setPhysics, onReset,
  unembedded, backfill, onBackfill, aiReady,
}: {
  open: boolean;
  onToggle: () => void;
  physics: PhysicsSettings;
  setPhysics: React.Dispatch<React.SetStateAction<PhysicsSettings>>;
  onReset: () => void;
  unembedded: number;
  backfill: { done: number; total: number } | null;
  onBackfill: () => void;
  aiReady: boolean;
}) {
  if (!open) {
    return (
      <button
        onClick={onToggle}
        title="Graph physics"
        className="absolute bottom-4 left-4 flex items-center gap-1.5 px-3 py-2 bg-zinc-900/80 backdrop-blur-md border border-zinc-800 rounded-lg text-[10px] uppercase tracking-widest text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors"
      >
        <Sliders className="w-3 h-3" />
        Physics
      </button>
    );
  }
  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      className="absolute bottom-4 left-4 w-64 bg-zinc-900/85 backdrop-blur-md border border-zinc-800 rounded-lg p-3 text-[11px] space-y-3"
    >
      <div className="flex items-center gap-1.5">
        <Sliders className="w-3 h-3 text-indigo-400" />
        <span className="font-bold text-zinc-300 uppercase tracking-widest text-[10px]">Physics</span>
        <button
          onClick={onReset}
          title="Reset to defaults"
          className="ml-auto p-0.5 text-zinc-500 hover:text-white"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
        <button onClick={onToggle} className="p-0.5 text-zinc-500 hover:text-white">
          <X className="w-3 h-3" />
        </button>
      </div>

      <SliderRow
        label="Distance"
        hint="how long edges are"
        value={physics.linkDistance}
        min={10} max={200} step={1}
        onChange={v => setPhysics(p => ({ ...p, linkDistance: v }))}
      />
      <SliderRow
        label="Repulsion"
        hint="how strongly nodes push apart"
        value={-physics.chargeStrength}      // display as positive
        min={0} max={400} step={5}
        onChange={v => setPhysics(p => ({ ...p, chargeStrength: -v }))}
      />
      <SliderRow
        label="Clustering"
        hint="how tightly connected nodes pull together"
        value={physics.linkStrength}
        min={0} max={2} step={0.05}
        decimals={2}
        onChange={v => setPhysics(p => ({ ...p, linkStrength: v }))}
      />

      <div className="border-t border-zinc-800 pt-2.5 mt-1 space-y-3">
        <div className="text-[9px] uppercase tracking-widest text-zinc-600 font-bold">Connections</div>
        <SliderRow
          label="Link threshold"
          hint="lower = more connections between topics"
          value={physics.simThreshold}
          min={0.4} max={0.8} step={0.01}
          decimals={2}
          onChange={v => setPhysics(p => ({ ...p, simThreshold: v }))}
        />
        <SliderRow
          label="Max links / node"
          hint="how many connections each node can form"
          value={physics.maxLinks}
          min={1} max={12} step={1}
          onChange={v => setPhysics(p => ({ ...p, maxLinks: Math.round(v) }))}
        />
        {unembedded > 0 && (
          <button
            onClick={onBackfill}
            disabled={!aiReady || !!backfill}
            title={aiReady ? 'Embed nodes that have no vector yet so they can connect' : 'Add a Gemini key in Models to enable'}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md border border-indigo-500/40 bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-[10px] font-semibold uppercase tracking-widest"
          >
            <Sparkles className="w-3 h-3" />
            {backfill ? `Connecting ${backfill.done}/${backfill.total}…` : `Connect ${unembedded} node${unembedded !== 1 ? 's' : ''}`}
          </button>
        )}
      </div>

      <div className="border-t border-zinc-800 pt-2.5 mt-1 space-y-2.5">
        <div className="text-[9px] uppercase tracking-widest text-zinc-600 font-bold">Network pulse</div>
        <SliderRow
          label="Hub threshold"
          hint="min connections for a node to start a pulse (Layer 1)"
          value={physics.pulseHubThreshold}
          min={1} max={12} step={1}
          onChange={v => setPhysics(p => ({ ...p, pulseHubThreshold: Math.round(v) }))}
        />
        <div className="text-[9px] text-zinc-600 leading-snug">
          A wave ripples outward from the busiest neurons every 5s, flowing through up to {physics.maxLinks} layer{physics.maxLinks !== 1 ? 's' : ''} (set by “Max links / node”).
        </div>
      </div>
    </div>
  );
}

function SliderRow({
  label, hint, value, min, max, step, onChange, decimals = 0,
}: {
  label: string;
  hint: string;
  value: number;
  min: number; max: number; step: number;
  decimals?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-zinc-300 font-semibold">{label}</span>
        <span className="text-zinc-500 tabular-nums">{value.toFixed(decimals)}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full mt-1 accent-indigo-500"
      />
      <div className="text-[9px] text-zinc-600">{hint}</div>
    </div>
  );
}

// ── Neuron detail overlay ────────────────────────────────────────────────────

function NeuronDetailPanel({
  node, allChunks, snippetDraft, onPersistSnippet, aiReady, categories, isElectron,
  onClose, onAsk, onDeepDive, onDelete,
}: {
  node: BrainNode;
  allChunks: ImportChunk[];
  snippetDraft: CapturedItem | null;
  onPersistSnippet: (next: CapturedItem) => void;
  aiReady: boolean;
  categories: string[];
  isElectron: boolean;
  onClose: () => void;
  onAsk: () => void;
  onDeepDive: () => void;
  onDelete: () => void;
}) {
  // Stop propagation on the panel so clicks inside it don't bubble to the
  // graph background (which would close it).
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.15 }}
      onMouseDown={stop}
      onClick={stop}
      className="absolute top-4 right-4 bottom-4 w-[400px] max-w-[40vw] bg-zinc-950/95 backdrop-blur-xl border border-zinc-800 rounded-xl shadow-2xl flex flex-col overflow-hidden z-20"
    >
      <header className="h-12 px-4 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        {node.kind === 'snippet' && <Scissors className="w-3.5 h-3.5 text-indigo-300 shrink-0" />}
        {node.kind === 'deepdive' && <Compass className="w-3.5 h-3.5 text-indigo-300 shrink-0" />}
        {node.kind === 'import' && <DownloadIcon className="w-3.5 h-3.5 text-indigo-300 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">{node.group}</div>
          <div className="text-[12px] font-semibold text-zinc-100 truncate">{node.label}</div>
        </div>
        <button onClick={onClose} className="p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800">
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-[12px] text-zinc-300 space-y-3">
        {node.kind === 'snippet'  && (
          <SnippetEditor
            item={snippetDraft ?? (node.data as CapturedItem)}
            onChange={onPersistSnippet}
            onDelete={onDelete}
            aiReady={aiReady}
            categories={categories}
            isElectron={isElectron}
            compact
          />
        )}
        {node.kind === 'deepdive' && <DeepDiveBody data={node.data} />}
        {node.kind === 'import'   && <ImportBody data={node.data} allChunks={allChunks} />}
      </div>

      <footer className="px-3 py-3 border-t border-zinc-800 bg-zinc-900/40 shrink-0 flex items-center gap-2">
        <button
          onClick={onDeepDive}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold uppercase tracking-wider transition-colors"
          title="Send this context into a new DeepDive chat"
        >
          <Compass className="w-3.5 h-3.5" />
          DeepDive
        </button>
        <button
          onClick={onAsk}
          className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-bold uppercase tracking-wider transition-colors"
          title="Pre-fill the Second Brain chat with a question about this"
        >
          Ask
        </button>
        {node.kind !== 'snippet' && (
          <button
            onClick={onDelete}
            className="px-3 py-2 rounded-md bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 text-red-400 transition-colors"
            title="Delete this neuron"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </footer>
    </motion.div>
  );
}

function DeepDiveBody({ data }: { data: any }) {
  const msgCount = (data.mainMessages?.length ?? 0) +
    (data.threads?.reduce((acc: number, t: any) => acc + (t.messages?.length ?? 0), 0) ?? 0);
  return (
    <>
      {data.description && <p className="text-zinc-300 leading-relaxed">{data.description}</p>}
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <Field label="Model" value={data.selectedModel || '—'} />
        <Field label="Messages" value={String(msgCount)} />
        <Field label="Threads" value={String(data.threads?.length ?? 0)} />
        <Field label="Updated" value={data.updatedAt ? new Date(data.updatedAt).toLocaleDateString() : '—'} />
      </div>
      {data.mainMessages?.length > 0 && (
        <details open>
          <summary className="text-[10px] uppercase tracking-wider text-zinc-500 cursor-pointer hover:text-zinc-300">Last few turns</summary>
          <div className="mt-2 space-y-2">
            {data.mainMessages.slice(-4).map((m: any, i: number) => (
              <MessageRow key={i} role={m.role} content={m.content} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function ImportBody({ data, allChunks }: { data: any; allChunks: ImportChunk[] }) {
  const indexed = allChunks.filter(c => c.conversationId === data.id).length;
  const msgs = data.messages ?? [];
  return (
    <>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <Field label="Provider" value={data.provider === 'claude' ? 'Claude' : 'ChatGPT'} />
        <Field label="Messages" value={String(msgs.length)} />
        <Field label="Created" value={data.createdAt ? new Date(data.createdAt).toLocaleDateString() : '—'} />
        <Field label="Indexed" value={indexed ? `${indexed} chunks` : 'no'} />
      </div>
      <details open>
        <summary className="text-[10px] uppercase tracking-wider text-zinc-500 cursor-pointer hover:text-zinc-300">First few turns</summary>
        <div className="mt-2 space-y-2">
          {msgs.slice(0, 6).map((m: any, i: number) => (
            <MessageRow key={i} role={m.role} content={m.content} />
          ))}
          {msgs.length > 6 && (
            <div className="text-[10px] text-zinc-500 italic">…{msgs.length - 6} more</div>
          )}
        </div>
      </details>
    </>
  );
}

function MessageRow({ role, content }: { role: string; content: string }) {
  const isUser = role === 'user' || role === 'human';
  return (
    <div className="flex gap-2">
      <div className={`shrink-0 mt-0.5 w-5 h-5 rounded flex items-center justify-center border ${
        isUser ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300' : 'bg-zinc-800 border-zinc-700 text-zinc-300'
      }`}>
        {isUser ? <UserIcon className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
      </div>
      <div className="text-[11px] text-zinc-300 leading-snug whitespace-pre-wrap break-words flex-1 min-w-0">
        {content.length > 400 ? content.slice(0, 400) + '…' : content}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2 py-1.5 rounded bg-zinc-900/60 border border-zinc-800">
      <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-[11px] text-zinc-200 truncate">{value}</div>
    </div>
  );
}

// Build the seed payload that gets handed to DeepDives.
function nodeToSeed(node: BrainNode, allChunks: ImportChunk[]) {
  if (node.kind === 'snippet') {
    const s = node.data;
    const body = [
      s.summary || '',
      s.extractedText ? `\n---\n${s.extractedText}` : '',
      s.tags?.length ? `\nTags: ${s.tags.join(', ')}` : '',
    ].filter(Boolean).join('\n').trim();
    return { title: s.title || node.label, source: 'snippet', body: body || node.label };
  }
  if (node.kind === 'deepdive') {
    const dd = node.data;
    const lastTurns = (dd.mainMessages ?? []).slice(-6)
      .map((m: any) => `${m.role}: ${m.content}`).join('\n\n');
    const body = [dd.description || '', lastTurns].filter(Boolean).join('\n\n---\n\n');
    return { title: dd.title || node.label, source: 'saved DeepDive session', body: body || node.label };
  }
  if (node.kind === 'import') {
    const im = node.data;
    const transcript = (im.messages ?? [])
      .map((m: any) => `${(m.role || '').toUpperCase()}: ${m.content}`)
      .join('\n\n');
    const indexed = allChunks.filter(c => c.conversationId === im.id).length;
    const header = `Imported ${im.provider === 'claude' ? 'Claude' : 'ChatGPT'} conversation` +
      (indexed ? ` (${indexed} indexed chunks).` : '.');
    return { title: im.title || node.label, source: header, body: transcript };
  }
  return null;
}
