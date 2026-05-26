import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type NodeObject, type LinkObject } from 'react-force-graph-2d';
import { Brain, Send, X, Sparkles, MessageSquare, Scissors, Compass } from 'lucide-react';
import * as db from '../lib/db';
import {
  embedText, cosineSimilarity, chatWithVault, isGeminiReady, onGeminiReadyChange,
  type ChatTurn, type VaultContextItem,
} from '../lib/ai';
import { buildGraph, nodeAsContextItem, type BrainNode, type BrainLink, type BrainGraph } from '../lib/graph';

interface ChatMessage extends ChatTurn { citedIds?: string[]; }

export default function SecondBrainTab() {
  const [snippets, setSnippets] = useState<any[]>([]);
  const [deepDives, setDeepDives] = useState<any[]>([]);
  const [graph, setGraph] = useState<BrainGraph>({ nodes: [], links: [] });
  const [focusedNode, setFocusedNode] = useState<BrainNode | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [citedIds, setCitedIds] = useState<Set<string>>(new Set());
  const [aiReady, setAiReady] = useState<boolean>(isGeminiReady());
  const [containerSize, setContainerSize] = useState({ w: 800, h: 600 });

  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => onGeminiReadyChange(setAiReady), []);

  // Load snippets + DeepDive sessions
  const loadData = useCallback(async () => {
    try {
      const [snips, dds] = await Promise.all([
        db.getAllSnippets<any>(),
        db.getAllThreads<any>(),
      ]);
      setSnippets(snips);
      setDeepDives(dds);
    } catch (e) { console.error('SecondBrain load failed:', e); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Rebuild graph whenever underlying data changes
  useEffect(() => {
    setGraph(buildGraph(snippets, deepDives));
  }, [snippets, deepDives]);

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

      const TOP_SNIPS = 6;
      const TOP_DDS = 3;

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
            {focusedNode && (
              <div className="mb-2 flex items-center justify-between px-2 py-1.5 bg-indigo-500/10 border border-indigo-500/30 rounded-md">
                <div className="flex items-center gap-1.5 min-w-0">
                  {focusedNode.kind === 'snippet' ? <Scissors className="w-3 h-3 text-indigo-300 shrink-0" /> : <Compass className="w-3 h-3 text-indigo-300 shrink-0" />}
                  <span className="text-[10px] text-indigo-200 truncate">{focusedNode.label}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={askAboutFocused} className="text-[9px] uppercase tracking-widest text-indigo-300 hover:text-white px-1.5">Ask</button>
                  <button onClick={() => setFocusedNode(null)} className="text-indigo-300/70 hover:text-white"><X className="w-3 h-3" /></button>
                </div>
              </div>
            )}
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

          {/* Legend */}
          {graph.nodes.length > 0 && (
            <div className="absolute bottom-4 left-4 bg-zinc-900/80 backdrop-blur-md border border-zinc-800 rounded-lg p-3 text-[10px] space-y-1.5">
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
