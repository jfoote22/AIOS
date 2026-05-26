import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import ForceGraph2D, { type ForceGraphMethods, type NodeObject, type LinkObject } from 'react-force-graph-2d';
import { Brain, Send, X, Sparkles, MessageSquare, Scissors, Compass, Download as DownloadIcon, Bot, User as UserIcon, Tag, Sliders, RotateCcw } from 'lucide-react';
import * as db from '../lib/db';
import {
  embedText, cosineSimilarity, chatWithVault, isGeminiReady, onGeminiReadyChange,
  type ChatTurn, type VaultContextItem,
} from '../lib/ai';
import { buildGraph, nodeAsContextItem, type BrainNode, type BrainLink, type BrainGraph } from '../lib/graph';
import { listImports, listAllChunks, onImportsChange, type ImportedConversation, type ImportChunk } from '../lib/imports';
import { setSeed as setDeepDiveSeed } from '../lib/deepdiveSeed';
import { navigateTo } from '../lib/navigate';

interface ChatMessage extends ChatTurn { citedIds?: string[]; }

export default function SecondBrainTab() {
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

  // ── Physics controls (persist to db.meta so they survive reloads) ──────────
  const [physics, setPhysics] = useState<PhysicsSettings>(DEFAULT_PHYSICS);
  const [showPhysics, setShowPhysics] = useState(false);
  useEffect(() => {
    db.getMeta<PhysicsSettings>('second-brain-physics')
      .then(p => { if (p) setPhysics({ ...DEFAULT_PHYSICS, ...p }); })
      .catch(() => {});
  }, []);
  useEffect(() => { db.setMeta('second-brain-physics', physics).catch(() => {}); }, [physics]);

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
    setGraph(buildGraph(snippets, deepDives, importsForGraph));
  }, [snippets, deepDives, imports, chunks]);

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

  // Node color: cited > focused > grouped (by category)
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
    return groupColors[node.group] || '#9ca3af';
  }, [citedIds, focusedNode, groupColors]);

  const linkColor = useCallback((l: LinkObject) => {
    const link = l as unknown as BrainLink;
    if (link.kind === 'origin') return 'rgba(124,156,255,0.55)';
    if (link.kind === 'similar') return 'rgba(94,230,176,0.25)';
    return 'rgba(255,255,255,0.12)';
  }, []);

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
        {/* Left 1/3 — chat */}
        <aside className="w-1/3 min-w-[320px] max-w-[480px] border-r border-zinc-800 flex flex-col bg-zinc-950">
          <div className="px-5 py-4 border-b border-zinc-800">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <h3 className="text-sm font-bold">Ask your Second Brain</h3>
            </div>
            <p className="text-[11px] text-zinc-500">Queries retrieve across all snippets and DeepDive sessions. Cited items light up in the graph.</p>
          </div>

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
        </aside>

        {/* Right 2/3 — force-directed graph */}
        <div ref={containerRef} className="flex-1 relative bg-gradient-to-br from-zinc-950 via-zinc-950 to-zinc-900 overflow-hidden">
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
              linkDirectionalParticles={(l) => ((l as any).kind === 'origin' ? 2 : 0)}
              linkDirectionalParticleSpeed={() => 0.006}
              linkDirectionalParticleColor={() => '#7c9cff'}
              cooldownTicks={120}
              warmupTicks={20}
              onNodeClick={onNodeClick}
              onBackgroundClick={() => setFocusedNode(null)}
              backgroundColor="rgba(0,0,0,0)"
              enableNodeDrag={true}
              minZoom={0.2}
              maxZoom={8}
            />
          )}

          <AnimatePresence>
            {focusedNode && (
              <NeuronDetailPanel
                node={focusedNode}
                allChunks={chunks}
                onClose={() => setFocusedNode(null)}
                onAsk={askAboutFocused}
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

          {/* Physics controls */}
          {graph.nodes.length > 0 && (
            <PhysicsPanel
              open={showPhysics}
              onToggle={() => setShowPhysics(o => !o)}
              physics={physics}
              setPhysics={setPhysics}
              onReset={() => setPhysics(DEFAULT_PHYSICS)}
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
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

// ── Physics controls ─────────────────────────────────────────────────────────

interface PhysicsSettings {
  linkDistance: number;   // d3 link force distance
  linkStrength: number;   // d3 link force strength (higher = tighter clusters)
  chargeStrength: number; // d3 charge force; negative = repulsion
}

const DEFAULT_PHYSICS: PhysicsSettings = {
  linkDistance: 30,
  linkStrength: 0.6,
  chargeStrength: -80,
};

function PhysicsPanel({
  open, onToggle, physics, setPhysics, onReset,
}: {
  open: boolean;
  onToggle: () => void;
  physics: PhysicsSettings;
  setPhysics: React.Dispatch<React.SetStateAction<PhysicsSettings>>;
  onReset: () => void;
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
  node, allChunks, onClose, onAsk, onDeepDive,
}: {
  node: BrainNode;
  allChunks: ImportChunk[];
  onClose: () => void;
  onAsk: () => void;
  onDeepDive: () => void;
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
        {node.kind === 'snippet'  && <SnippetBody data={node.data} />}
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
      </footer>
    </motion.div>
  );
}

function SnippetBody({ data }: { data: any }) {
  return (
    <>
      {data.imageDataUrl && (
        <img src={data.imageDataUrl} alt="" className="w-full rounded border border-zinc-800" />
      )}
      {data.summary && <p className="text-zinc-300 leading-relaxed">{data.summary}</p>}
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        {data.category && <Field label="Category" value={data.category} />}
        {data.source && <Field label="Source" value={data.source} />}
      </div>
      {data.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {data.tags.map((t: string) => (
            <span key={t} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-800/80 text-[10px] text-zinc-300">
              <Tag className="w-2.5 h-2.5 text-zinc-500" />{t}
            </span>
          ))}
        </div>
      )}
      {data.entities?.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Entities</div>
          {data.entities.map((e: any, i: number) => (
            <div key={i} className="text-[11px]">
              <span className="text-zinc-500">{e.label}:</span>{' '}
              <span className="text-zinc-200">{e.value}</span>
            </div>
          ))}
        </div>
      )}
      {data.extractedText && (
        <details>
          <summary className="text-[10px] uppercase tracking-wider text-zinc-500 cursor-pointer hover:text-zinc-300">Extracted text</summary>
          <pre className="mt-2 text-[11px] text-zinc-400 whitespace-pre-wrap break-words">{data.extractedText.slice(0, 4000)}</pre>
        </details>
      )}
    </>
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
