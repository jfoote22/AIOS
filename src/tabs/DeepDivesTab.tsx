import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Save, FolderOpen, Plus, Copy, X, AlertCircle, MessageSquare, Trash2, Clock, Bot, Layers, Network, Search, Link2, Video, ArrowRight, ArrowDown } from 'lucide-react';
import ThreadedChat from '../components/ThreadedChat';
import * as db from '../lib/db';
import { onConfiguredChange, getConfigured, type ProviderId } from '../lib/providers';
import { consumeSeed, onSeedChange, type DeepDiveSeed } from '../lib/deepdiveSeed';
import { emitDeepDivesChange } from '../lib/deepdiveStore';

export interface DeepDiveRecord {
  id: string;
  title: string;
  description?: string;
  mainMessages: any[];
  threads: any[];
  selectedModel: string;
  attachments?: any[];
  embedding?: number[];   // centroid of assistant text; lets the Second Brain graph link this dive

  activeThreadId?: string | null;
  timestamp: number;
  updatedAt: number;
}

interface UnderstandingNode {
  id: string;
  label: string;
  group: 'root' | 'main' | 'thread' | 'concept' | 'source';
  kind: string;
  val: number;
  detail?: string;
  data?: any;
  x?: number;
  y?: number;
}

interface UnderstandingLink {
  source: string;
  target: string;
  kind: 'contains' | 'context' | 'parent' | 'mentions' | 'source';
  value: number;
}

interface UnderstandingGraph {
  nodes: UnderstandingNode[];
  links: UnderstandingLink[];
}

type UnderstandingLayout = 'horizontal' | 'vertical';

export default function DeepDivesTab() {
  const threadedChatRef = useRef<any>(null);
  const [saved, setSaved] = useState<DeepDiveRecord[]>([]);
  const [showSave, setShowSave] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [saveDescription, setSaveDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [configured, setConfigured] = useState<Set<ProviderId>>(getConfigured());
  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);
  const [showUnderstanding, setShowUnderstanding] = useState(false);
  const [understanding, setUnderstanding] = useState<UnderstandingGraph>({ nodes: [], links: [] });
  const [selectedNode, setSelectedNode] = useState<UnderstandingNode | null>(null);
  const [understandingQuery, setUnderstandingQuery] = useState('');
  const [understandingLayout, setUnderstandingLayout] = useState<UnderstandingLayout>('horizontal');

  useEffect(() => onConfiguredChange(setConfigured), []);
  useEffect(() => { refresh(); }, []);

  // Consume a pending seed from Second Brain on mount, and listen for new ones.
  useEffect(() => {
    const apply = (seed: DeepDiveSeed | null) => {
      if (!seed) return;
      const prompt = buildSeedPrompt(seed);
      // Small delay so the ref is wired up when navigating from another tab
      setTimeout(() => threadedChatRef.current?.setMainInput?.(prompt), 80);
    };
    apply(consumeSeed());
    return onSeedChange(s => { apply(s); consumeSeed(); });
  }, []);

  const refresh = async () => {
    try {
      const all = await db.getAllThreads<DeepDiveRecord>();
      all.sort((a, b) => (b.updatedAt ?? b.timestamp) - (a.updatedAt ?? a.timestamp));
      setSaved(all);
    } catch (e) { console.error('Failed to load DeepDives:', e); }
  };

  const handleSave = async () => {
    if (!saveTitle.trim()) { alert('Please enter a title.'); return; }
    try {
      setIsSaving(true);
      threadedChatRef.current?.forceUpdateThreadMessages?.();
      await new Promise(r => setTimeout(r, 100));
      const state = threadedChatRef.current?.getCurrentState?.();
      if (!state) throw new Error('Could not read chat state.');

      const hasContent = (state.mainMessages?.length ?? 0) > 0 || (state.threads?.length ?? 0) > 0;
      if (!hasContent) { alert('No conversation data to save. Start a chat first.'); return; }

      const id = currentId ?? `dd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const record: DeepDiveRecord = {
        id,
        title: saveTitle.trim(),
        description: saveDescription.trim(),
        mainMessages: state.mainMessages ?? [],
        threads: state.threads ?? [],
        selectedModel: state.selectedModel ?? 'anthropic',
        attachments: state.attachments ?? [],
        activeThreadId: state.activeThreadId ?? null,
        timestamp: currentId ? (saved.find(s => s.id === currentId)?.timestamp ?? Date.now()) : Date.now(),
        updatedAt: Date.now(),
      };
      // Best-effort: embed the session's assistant text so it joins the Second
      // Brain semantic graph as a connectable node (non-fatal if Gemini is off).
      try {
        const { isGeminiReady, embedText } = await import('../lib/ai');
        const { deepDiveEmbedSource } = await import('../lib/graph');
        if (isGeminiReady()) {
          const src = deepDiveEmbedSource(record as any);
          if (src) {
            const emb = await embedText(src);
            if (emb.length) record.embedding = emb;
          }
        }
      } catch (e) { console.error('DeepDive embedding failed (non-fatal):', e); }
      await db.putThread(record);
      setCurrentId(id);
      await refresh();
      emitDeepDivesChange(); // let Second Brain pick up the new/updated dive
      setShowSave(false);
    } catch (e: any) {
      console.error('Save failed:', e);
      alert(`Save failed: ${e?.message ?? e}`);
    } finally { setIsSaving(false); }
  };

  const handleLoad = (record: DeepDiveRecord) => {
    try {
      threadedChatRef.current?.loadState?.({
        mainMessages: record.mainMessages ?? [],
        threads: record.threads ?? [],
        selectedModel: record.selectedModel ?? 'anthropic',
        activeThreadId: record.activeThreadId ?? null,
        attachments: record.attachments ?? [],
      });
      setCurrentId(record.id);
      setSaveTitle(record.title);
      setSaveDescription(record.description ?? '');
      setShowLoad(false);
    } catch (e: any) {
      console.error('Load failed:', e);
      alert(`Load failed: ${e?.message ?? e}`);
    }
  };

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`Delete "${title}"?`)) return;
    try {
      await db.removeThread(id);
      if (currentId === id) setCurrentId(null);
      await refresh();
      emitDeepDivesChange(); // let Second Brain drop the deleted dive
    } catch (e: any) {
      console.error('Delete failed:', e);
      alert(`Delete failed: ${e?.message ?? e}`);
    }
  };

  const handleNewChat = () => {
    const state = threadedChatRef.current?.getCurrentState?.();
    const hasContent = (state?.mainMessages?.length ?? 0) > 0 || (state?.threads?.length ?? 0) > 0;
    if (hasContent) { setShowNewChatConfirm(true); return; }
    doNewChat();
  };

  const doNewChat = () => {
    threadedChatRef.current?.clearAllAndStartFresh?.();
    setCurrentId(null);
    setSaveTitle('');
    setSaveDescription('');
    setShowNewChatConfirm(false);
  };

  const handleCopy = () => threadedChatRef.current?.copyAllAIResponses?.();

  const handleUnderstand = () => {
    threadedChatRef.current?.forceUpdateThreadMessages?.();
    setTimeout(() => {
      const state = threadedChatRef.current?.getCurrentState?.();
      const graph = buildUnderstandingGraph(state, understandingLayout);
      setUnderstanding(graph);
      setSelectedNode(graph.nodes[0] ?? null);
      setShowUnderstanding(true);
    }, 120);
  };

  const relayoutUnderstanding = (layout: UnderstandingLayout) => {
    setUnderstandingLayout(layout);
    setUnderstanding(prev => layoutUnderstandingGraph({
      ...prev,
      nodes: prev.nodes.map(n => ({ ...n, x: undefined, y: undefined })),
    }, layout));
  };

  const formatDate = (ts: number) => {
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
  };

  const chatProviders: ProviderId[] = ['openai', 'anthropic', 'grok'];
  const hasAnyChatProvider = chatProviders.some(p => configured.has(p));
  const filteredUnderstandingNodes = useMemo(() => {
    const q = understandingQuery.trim().toLowerCase();
    if (!q) return understanding.nodes;
    return understanding.nodes.filter(n =>
      n.label.toLowerCase().includes(q) ||
      n.kind.toLowerCase().includes(q) ||
      (n.detail || '').toLowerCase().includes(q)
    );
  }, [understanding.nodes, understandingQuery]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Tab header — matches SnippingTab rhythm */}
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center justify-between bg-zinc-900/10 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-zinc-800 rounded-md"><MessageSquare className="w-4 h-4 text-indigo-400" /></div>
            <h1 className="text-sm font-bold uppercase tracking-widest text-zinc-100">DeepDive</h1>
            {currentId && (
              <span className="ml-1 text-[10px] px-2 py-0.5 bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 rounded-full font-bold uppercase tracking-widest">
                Saved
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setShowLoad(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white text-[11px] font-bold uppercase tracking-wider rounded-lg transition-colors">
            <FolderOpen className="w-3.5 h-3.5" />Load
            <span className="text-[10px] bg-zinc-800 px-1.5 rounded-full text-zinc-500">{saved.length}</span>
          </button>
          <button onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white text-[11px] font-bold uppercase tracking-wider rounded-lg transition-colors">
            <Copy className="w-3.5 h-3.5" />Copy All
          </button>
          <button onClick={() => { if (!saveTitle) setSaveTitle(`DeepDive ${new Date().toLocaleDateString()}`); setShowSave(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white text-[11px] font-bold uppercase tracking-wider rounded-lg transition-colors">
            <Save className="w-3.5 h-3.5" />Save
          </button>
          <button onClick={handleUnderstand}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white text-[11px] font-bold uppercase tracking-wider rounded-lg transition-colors"
            title="Generate an understanding graph from the current DeepDive">
            <Network className="w-3.5 h-3.5" />Understand
          </button>
          <button onClick={handleNewChat}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold rounded-lg transition-all active:scale-95 shadow-lg shadow-indigo-600/10 uppercase tracking-wider"
            title="Start a new chat (clears current conversation)">
            <Plus className="w-3.5 h-3.5" />New Chat
          </button>
        </div>
      </header>

      {!hasAnyChatProvider && (
        <div className="px-6 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-[11px] flex items-center gap-2 shrink-0 uppercase tracking-wider font-bold">
          <AlertCircle className="w-3.5 h-3.5" />
          No chat provider configured — open the <b className="text-amber-300">Models</b> tab to add an OpenAI, Anthropic, or Grok key.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <ThreadedChat ref={threadedChatRef} />
      </div>

      {/* Save modal */}
      <AnimatePresence>
        {showSave && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[150] bg-black/90 backdrop-blur-xl overflow-y-auto"
            onClick={() => !isSaving && setShowSave(false)}>
            <div className="min-h-full flex items-start justify-center p-8">
              <div className="max-w-md w-full my-auto bg-zinc-900/50 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => !isSaving && setShowSave(false)} className="absolute top-6 right-6 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors z-10"><X className="w-5 h-5" /></button>

                <div className="p-8 space-y-6">
                  <header>
                    <div className="px-3 py-1 inline-block bg-indigo-600/20 border border-indigo-500/30 rounded-lg text-indigo-400 font-bold text-[10px] uppercase tracking-widest mb-3">
                      {currentId ? 'Update DeepDive' : 'Save DeepDive'}
                    </div>
                    <h2 className="text-xl font-bold text-zinc-100 leading-tight">Snapshot this conversation</h2>
                    <p className="text-sm text-zinc-400 mt-1">Persist the main thread, side threads, and snippets so you can return later.</p>
                  </header>

                  <section className="space-y-4">
                    <div>
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Title *</p>
                      <input type="text" value={saveTitle} onChange={(e) => setSaveTitle(e.target.value)} autoFocus
                        placeholder="Title for your DeepDive…"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Description</p>
                      <textarea value={saveDescription} onChange={(e) => setSaveDescription(e.target.value)}
                        placeholder="Optional description…" rows={3}
                        className="w-full resize-none bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all" />
                    </div>
                  </section>

                  <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                    <button onClick={() => setShowSave(false)} disabled={isSaving}
                      className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-zinc-400 hover:text-white transition-colors">
                      Cancel
                    </button>
                    <button onClick={handleSave} disabled={isSaving || !saveTitle.trim()}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-[11px] font-bold rounded-lg transition-all active:scale-95 shadow-lg shadow-indigo-600/10 uppercase tracking-wider">
                      {isSaving ? 'Saving…' : currentId ? 'Update' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Understanding graph modal */}
      <AnimatePresence>
        {showUnderstanding && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[155] bg-black/90 backdrop-blur-xl overflow-hidden"
            onClick={() => setShowUnderstanding(false)}>
            <div className="h-full w-full p-6">
              <div className="h-full bg-zinc-950/95 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
                <header className="h-16 px-5 border-b border-zinc-800 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-indigo-600/10 border border-indigo-500/20 rounded-lg"><Network className="w-4 h-4 text-indigo-400" /></div>
                    <div>
                      <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-100">DeepDive Understanding</h2>
                      <p className="text-[11px] text-zinc-500">{understanding.nodes.length} nodes · {understanding.links.length} relationships</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
                      <button
                        onClick={() => relayoutUnderstanding('horizontal')}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${understandingLayout === 'horizontal' ? 'bg-indigo-600/20 text-indigo-300' : 'text-zinc-500 hover:text-white hover:bg-zinc-800'}`}
                        title="Lay out left to right"
                      >
                        <ArrowRight className="w-3.5 h-3.5" />Left to Right
                      </button>
                      <button
                        onClick={() => relayoutUnderstanding('vertical')}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${understandingLayout === 'vertical' ? 'bg-indigo-600/20 text-indigo-300' : 'text-zinc-500 hover:text-white hover:bg-zinc-800'}`}
                        title="Lay out top to bottom"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />Top to Bottom
                      </button>
                    </div>
                    <button onClick={() => setShowUnderstanding(false)} className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </header>

                <div className="flex-1 min-h-0 grid grid-cols-[320px_minmax(0,1fr)_360px]">
                  <aside className="border-r border-zinc-800 p-4 overflow-y-auto">
                    <div className="relative mb-3">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600" />
                      <input
                        value={understandingQuery}
                        onChange={(e) => setUnderstandingQuery(e.target.value)}
                        placeholder="Search graph..."
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 pl-9 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>
                    <div className="space-y-2">
                      {filteredUnderstandingNodes.map(node => (
                        <button
                          key={node.id}
                          onClick={() => {
                            setSelectedNode(node);
                          }}
                          className={`w-full text-left rounded-lg border p-3 transition-colors ${selectedNode?.id === node.id ? 'bg-indigo-600/10 border-indigo-500/40' : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'}`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-sm font-semibold text-zinc-100 truncate">{node.label}</span>
                            <span className="text-[9px] uppercase tracking-widest text-zinc-500">{node.kind}</span>
                          </div>
                          {node.detail && <p className="text-[11px] text-zinc-500 line-clamp-2">{node.detail}</p>}
                        </button>
                      ))}
                    </div>
                  </aside>

                  <main className="relative min-h-0 bg-zinc-950 overflow-auto">
                    {understanding.nodes.length === 0 ? (
                      <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
                        No DeepDive content to map yet.
                      </div>
                    ) : (
                      <UnderstandingMap
                        graph={understanding}
                        layout={understandingLayout}
                        selectedId={selectedNode?.id || null}
                        onSelect={setSelectedNode}
                        onMoveNode={(id, x, y) => {
                          setUnderstanding(prev => ({
                            ...prev,
                            nodes: prev.nodes.map(n => (n.id === id ? { ...n, x, y } : n)),
                          }));
                          setSelectedNode(prev => (prev?.id === id ? { ...prev, x, y } : prev));
                        }}
                      />
                    )}
                  </main>

                  <aside className="border-l border-zinc-800 p-5 overflow-y-auto bg-zinc-950/70">
                    {selectedNode ? (
                      <div className="space-y-4">
                        <div>
                          <p className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">{selectedNode.kind}</p>
                          <h3 className="text-xl font-bold text-zinc-100 leading-tight">{selectedNode.label}</h3>
                        </div>
                        {selectedNode.detail && (
                          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                            <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{selectedNode.detail}</p>
                          </div>
                        )}
                        {selectedNode.group === 'source' && selectedNode.data?.url && (
                          <a href={selectedNode.data.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-xs text-indigo-300 hover:text-indigo-200">
                            {selectedNode.kind === 'video' ? <Video className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
                            Open source
                          </a>
                        )}
                        <div className="border-t border-zinc-800 pt-4">
                          <p className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Connected relationships</p>
                          <div className="space-y-1">
                            {understanding.links
                              .filter(l => String(l.source) === selectedNode.id || String(l.target) === selectedNode.id || (l.source as any)?.id === selectedNode.id || (l.target as any)?.id === selectedNode.id)
                              .slice(0, 12)
                              .map((l, idx) => {
                                const sourceId = typeof l.source === 'string' ? l.source : (l.source as any).id;
                                const targetId = typeof l.target === 'string' ? l.target : (l.target as any).id;
                                const otherId = sourceId === selectedNode.id ? targetId : sourceId;
                                const other = understanding.nodes.find(n => n.id === otherId);
                                return <p key={idx} className="text-xs text-zinc-500"><span className="text-zinc-400">{l.kind}</span> · {other?.label || otherId}</p>;
                              })}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-sm text-zinc-500 text-center">
                        Select a node to inspect context, findings, and sources.
                      </div>
                    )}
                  </aside>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Load modal */}
      <AnimatePresence>
        {showLoad && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[150] bg-black/90 backdrop-blur-xl overflow-y-auto"
            onClick={() => setShowLoad(false)}>
            <div className="min-h-full flex items-start justify-center p-8">
              <div className="max-w-3xl w-full my-auto bg-zinc-900/50 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => setShowLoad(false)} className="absolute top-6 right-6 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors z-10"><X className="w-5 h-5" /></button>

                <div className="p-8 space-y-6">
                  <header>
                    <div className="px-3 py-1 inline-block bg-indigo-600/20 border border-indigo-500/30 rounded-lg text-indigo-400 font-bold text-[10px] uppercase tracking-widest mb-3">Saved DeepDives</div>
                    <h2 className="text-xl font-bold text-zinc-100 leading-tight">Load a previous session</h2>
                    <p className="text-sm text-zinc-400 mt-1">{saved.length} saved DeepDive{saved.length === 1 ? '' : 's'} in your vault.</p>
                  </header>

                  {saved.length === 0 ? (
                    <div className="py-16 flex flex-col items-center justify-center text-center space-y-4">
                      <div className="w-20 h-20 bg-zinc-900 rounded-full flex items-center justify-center border border-zinc-800 relative">
                        <FolderOpen className="w-8 h-8 text-zinc-800" />
                        <div className="absolute inset-0 border-2 border-indigo-500/20 rounded-full animate-ping" />
                      </div>
                      <div className="max-w-xs">
                        <p className="text-sm font-bold text-zinc-400 mb-1">No saved DeepDives yet</p>
                        <p className="text-xs text-zinc-600 leading-relaxed">Start a conversation and click Save to keep it.</p>
                      </div>
                    </div>
                  ) : (
                    <div className="max-h-[55vh] overflow-y-auto scrollbar-hide space-y-3 pr-1">
                      {saved.map(dd => (
                        <motion.div key={dd.id} layout initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}
                          className="group bg-zinc-900 border border-zinc-800 rounded-2xl p-4 hover:border-indigo-500/50 transition-all">
                          <div className="flex justify-between items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <h3 className="text-sm font-bold text-zinc-100 truncate">{dd.title}</h3>
                                {currentId === dd.id && (
                                  <span className="text-[9px] px-1.5 py-0.5 bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 rounded-full font-bold uppercase tracking-widest">Current</span>
                                )}
                              </div>
                              {dd.description && <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2 leading-relaxed">{dd.description}</p>}
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2.5 text-[10px] text-zinc-500">
                                <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{dd.mainMessages?.length ?? 0} msgs</span>
                                <span className="flex items-center gap-1"><Layers className="w-3 h-3" />{dd.threads?.length ?? 0} threads</span>
                                <span className="flex items-center gap-1"><Bot className="w-3 h-3" />{dd.selectedModel}</span>
                                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDate(dd.updatedAt ?? dd.timestamp)}</span>
                              </div>
                            </div>
                            <div className="flex gap-1.5 shrink-0">
                              <button onClick={() => handleLoad(dd)}
                                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold rounded-lg uppercase tracking-wider transition-colors">
                                Load
                              </button>
                              <button onClick={() => handleDelete(dd.id, dd.title)}
                                className="p-1.5 bg-zinc-900 hover:bg-red-600/20 border border-zinc-800 hover:border-red-500/40 rounded-lg text-zinc-500 hover:text-red-400 transition-colors"
                                title="Delete DeepDive">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* New Chat confirmation — styled to match AIOS (replaces native confirm) */}
      <AnimatePresence>
        {showNewChatConfirm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[160] bg-black/90 backdrop-blur-xl flex items-center justify-center p-8"
            onClick={() => setShowNewChatConfirm(false)}>
            <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
              className="max-w-md w-full bg-zinc-900/60 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl relative"
              onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setShowNewChatConfirm(false)} className="absolute top-6 right-6 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors z-10"><X className="w-5 h-5" /></button>

              <div className="p-8 space-y-6">
                <header>
                  <div className="px-3 py-1 inline-block bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-400 font-bold text-[10px] uppercase tracking-widest mb-3">
                    Start a new chat
                  </div>
                  <h2 className="text-xl font-bold text-zinc-100 leading-tight">Clear the current conversation?</h2>
                  <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
                    The current conversation will be cleared. Saved DeepDives are kept — Save first if you want to keep this session.
                  </p>
                </header>

                <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                  <button onClick={() => setShowNewChatConfirm(false)}
                    className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-zinc-400 hover:text-white transition-colors">
                    Cancel
                  </button>
                  <button onClick={doNewChat}
                    className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold rounded-lg transition-all active:scale-95 shadow-lg shadow-indigo-600/10 uppercase tracking-wider">
                    <Plus className="w-3.5 h-3.5" />New Chat
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

function buildSeedPrompt(seed: DeepDiveSeed): string {
  const body = seed.body.length > 6000 ? seed.body.slice(0, 6000) + '\n\n…(truncated)' : seed.body;
  return [
    `I'd like to do a deep dive starting from this ${seed.source}:`,
    '',
    `### ${seed.title}`,
    body,
    '',
    '---',
    'Help me drill into this. What are the most interesting angles to explore?',
  ].join('\n');
}

function buildUnderstandingGraph(state: any, layout: UnderstandingLayout = 'horizontal'): UnderstandingGraph {
  const nodes: UnderstandingNode[] = [];
  const links: UnderstandingLink[] = [];
  const addNode = (node: UnderstandingNode) => {
    if (!nodes.some(n => n.id === node.id)) nodes.push(node);
  };
  const addLink = (link: UnderstandingLink) => {
    if (link.source !== link.target && !links.some(l => l.source === link.source && l.target === link.target && l.kind === link.kind)) links.push(link);
  };

  const mainMessages = Array.isArray(state?.mainMessages) ? state.mainMessages : [];
  const threads = Array.isArray(state?.threads) ? state.threads : [];
  const attachments = Array.isArray(state?.attachments) ? state.attachments : [];

  if (!mainMessages.length && !threads.length && !attachments.length) return { nodes, links };

  addNode({
    id: 'root',
    label: 'Current DeepDive',
    group: 'root',
    kind: 'overview',
    val: 14,
    detail: `${mainMessages.length} main messages, ${threads.length} context threads, ${attachments.length} attachments.`,
  });

  if (mainMessages.length) {
    const assistantText = mainMessages.filter((m: any) => m?.role === 'assistant').map((m: any) => m.content || '').join('\n\n');
    addNode({
      id: 'main',
      label: 'Main Chat',
      group: 'main',
      kind: 'conversation',
      val: 10,
      detail: summarizeText(assistantText || mainMessages.map((m: any) => m.content || '').join('\n\n')),
    });
    addLink({ source: 'root', target: 'main', kind: 'contains', value: 3 });
  }

  const conceptCounts = new Map<string, { count: number; threadIds: Set<string>; samples: string[] }>();

  for (const [idx, thread] of threads.entries()) {
    const threadId = `thread:${thread.id || idx}`;
    const label = thread.title || `${actionLabel(thread.actionType)} ${idx + 1}`;
    const isDeep = thread.research?.kind === 'deep';
    const threadText = [
      thread.selectedContext || '',
      ...(thread.messages || []).map((m: any) => m?.content || ''),
      thread.research?.intro || '',
      isDeep ? (thread.research?.report || '') : '',
    ].join('\n\n');

    addNode({
      id: threadId,
      label,
      group: 'thread',
      kind: actionLabel(thread.actionType),
      val: 8 + Math.min(8, (thread.messages?.length || 0) * 1.2),
      detail: [
        thread.selectedContext ? `Context:\n${thread.selectedContext}` : '',
        summarizeText(threadText) ? `\nSummary:\n${summarizeText(threadText)}` : '',
      ].filter(Boolean).join('\n').trim(),
      data: thread,
    });
    addLink({ source: 'root', target: threadId, kind: 'context', value: 2 });

    if (thread.parentThreadId) {
      addLink({ source: `thread:${thread.parentThreadId}`, target: threadId, kind: 'parent', value: 4 });
    } else if (thread.sourceType === 'main' && mainMessages.length) {
      addLink({ source: 'main', target: threadId, kind: 'context', value: 2 });
    }

    for (const concept of extractConcepts(threadText)) {
      const current = conceptCounts.get(concept) || { count: 0, threadIds: new Set<string>(), samples: [] };
      current.count += 1;
      current.threadIds.add(threadId);
      if (current.samples.length < 3 && thread.selectedContext) current.samples.push(thread.selectedContext.slice(0, 180));
      conceptCounts.set(concept, current);
    }

    // Deep Research threads: render the planner's real decomposition —
    // sub-questions become concept nodes, and each read source attaches to the
    // sub-question it answered. This replaces the regex heuristics with the
    // agent's actual research tree.
    if (isDeep) {
      const plan: string[] = thread.research?.plan || [];
      const planNodeId = (qi: number) => `deepq:${thread.id || idx}:${qi}`;
      plan.forEach((q, qi) => {
        addNode({
          id: planNodeId(qi),
          label: `Q${qi + 1}. ${q.length > 70 ? q.slice(0, 70) + '…' : q}`,
          group: 'concept',
          kind: 'question',
          val: 7,
          detail: q,
        });
        addLink({ source: threadId, target: planNodeId(qi), kind: 'mentions', value: 2 });
      });

      const deepSources: any[] = thread.research?.sources || [];
      for (const [sourceIdx, source] of deepSources.slice(0, 16).entries()) {
        const sourceId = `deepsrc:${thread.id || idx}:${sourceIdx}`;
        addNode({
          id: sourceId,
          label: source.title || source.url || 'Source',
          group: 'source',
          kind: 'link',
          val: 4,
          detail: source.summary || source.url || '',
          data: { url: source.url },
        });
        const matchedQ = plan.findIndex(q => q === source.subQuestion);
        addLink({
          source: matchedQ >= 0 ? planNodeId(matchedQ) : threadId,
          target: sourceId,
          kind: 'source',
          value: 1.5,
        });
      }
      continue;
    }

    const researchLinks = thread.research?.links || [];
    const researchVideos = thread.research?.videos || [];
    for (const [sourceIdx, source] of [...researchLinks, ...researchVideos].slice(0, 8).entries()) {
      const isVideo = !!source.videoId;
      const sourceId = `source:${thread.id || idx}:${sourceIdx}`;
      addNode({
        id: sourceId,
        label: source.title || source.url || source.channel || 'Source',
        group: 'source',
        kind: isVideo ? 'video' : 'link',
        val: 4,
        detail: source.reason || source.channel || source.source || source.url || '',
        data: source,
      });
      addLink({ source: threadId, target: sourceId, kind: 'source', value: 1.5 });
    }
  }

  const topConcepts = Array.from(conceptCounts.entries())
    .filter(([, info]) => info.count >= 2 || info.threadIds.size >= 2)
    .sort((a, b) => (b[1].threadIds.size - a[1].threadIds.size) || (b[1].count - a[1].count))
    .slice(0, 24);

  for (const [concept, info] of topConcepts) {
    const conceptId = `concept:${concept.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    addNode({
      id: conceptId,
      label: concept,
      group: 'concept',
      kind: 'concept',
      val: 5 + Math.min(10, info.threadIds.size * 2),
      detail: `Appears across ${info.threadIds.size} thread${info.threadIds.size === 1 ? '' : 's'}.`,
      data: { samples: info.samples },
    });
    for (const threadId of info.threadIds) {
      addLink({ source: threadId, target: conceptId, kind: 'mentions', value: 1 + info.count * 0.2 });
    }
  }

  return layoutUnderstandingGraph({ nodes, links }, layout);
}

function layoutUnderstandingGraph(graph: UnderstandingGraph, layout: UnderstandingLayout): UnderstandingGraph {
  const columns: UnderstandingNode['group'][] = ['root', 'main', 'thread', 'concept', 'source'];
  const xByGroup: Record<string, number> = {};
  const yByGroup: Record<string, number> = {};
  const nextOffset: Record<string, number> = {};
  for (const [idx, group] of columns.entries()) {
    xByGroup[group] = layout === 'horizontal' ? 80 + idx * 340 : 100;
    yByGroup[group] = layout === 'horizontal' ? 80 : 80 + idx * 260;
    nextOffset[group] = 0;
  }

  const nodes = graph.nodes.map(node => {
    const group = node.group;
    const size = cardSize(node);
    const gap = group === 'thread' ? 36 : 26;
    const x = layout === 'horizontal'
      ? xByGroup[group] ?? 760
      : (xByGroup[group] ?? 100) + nextOffset[group];
    const y = layout === 'horizontal'
      ? (yByGroup[group] ?? 80) + nextOffset[group]
      : yByGroup[group] ?? 80;
    nextOffset[group] += layout === 'horizontal' ? size.h + gap : size.w + gap;
    return { ...node, x, y };
  });
  return { ...graph, nodes };
}

function UnderstandingMap({
  graph, layout, selectedId, onSelect, onMoveNode,
}: {
  graph: UnderstandingGraph;
  layout: UnderstandingLayout;
  selectedId: string | null;
  onSelect: (node: UnderstandingNode) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
}) {
  const width = Math.max(1900, ...graph.nodes.map(n => (n.x || 0) + cardSize(n).w + 120));
  const height = Math.max(900, ...graph.nodes.map(n => (n.y || 0) + cardSize(n).h + 120));
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const columns = [
    { id: 'root', label: 'Overview', x: 80 },
    { id: 'main', label: 'Main Chat', x: 420 },
    { id: 'thread', label: 'Context Threads', x: 760 },
    { id: 'concept', label: 'Concepts', x: 1120 },
    { id: 'source', label: 'Sources', x: 1480 },
  ];
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      onMoveNode(dragging.id, Math.max(20, e.clientX + dragging.dx), Math.max(45, e.clientY + dragging.dy));
    };
    const onUp = () => setDragging(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onMoveNode]);

  return (
    <div className="relative" style={{ width, height }}>
      <svg className="absolute inset-0 pointer-events-none" width={width} height={height}>
        <defs>
          <marker id="arrow-understand" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L0,6 L7,3 z" fill="rgba(161,161,170,0.65)" />
          </marker>
        </defs>
        {columns.map((col, idx) => layout === 'horizontal' ? (
          <line key={col.id} x1={80 + idx * 340 - 24} y1={0} x2={80 + idx * 340 - 24} y2={height} stroke="rgba(39,39,42,0.55)" strokeDasharray="6 8" />
        ) : (
          <line key={col.id} x1={0} y1={80 + idx * 260 - 30} x2={width} y2={80 + idx * 260 - 30} stroke="rgba(39,39,42,0.55)" strokeDasharray="6 8" />
        ))}
        {graph.links.map((link, idx) => {
          const sourceId = typeof link.source === 'string' ? link.source : (link.source as any).id;
          const targetId = typeof link.target === 'string' ? link.target : (link.target as any).id;
          const source = byId.get(sourceId);
          const target = byId.get(targetId);
          if (!source || !target) return null;
          const sSize = cardSize(source);
          const tSize = cardSize(target);
          const x1 = (source.x || 0) + sSize.w;
          const y1 = (source.y || 0) + sSize.h / 2;
          const x2 = target.x || 0;
          const y2 = (target.y || 0) + tSize.h / 2;
          const mid = layout === 'horizontal'
            ? Math.max(60, Math.abs(x2 - x1) / 2)
            : Math.max(60, Math.abs(y2 - y1) / 2);
          const color = link.kind === 'parent' ? 'rgba(129,140,248,0.7)' : link.kind === 'mentions' ? 'rgba(34,197,94,0.45)' : 'rgba(113,113,122,0.42)';
          return (
            <path
              key={`${sourceId}-${targetId}-${idx}`}
              d={layout === 'horizontal'
                ? `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`
                : `M ${x1} ${y1} C ${x1} ${y1 + mid}, ${x2} ${y2 - mid}, ${x2} ${y2}`}
              fill="none"
              stroke={color}
              strokeWidth={Math.max(1, Math.min(3, link.value || 1))}
              markerEnd="url(#arrow-understand)"
            />
          );
        })}
      </svg>

      {columns.map((col, idx) => (
        <div
          key={col.id}
          className="absolute text-[10px] uppercase tracking-widest text-zinc-600 font-bold"
          style={layout === 'horizontal' ? { left: 80 + idx * 340, top: 20 } : { left: 24, top: 80 + idx * 260 - 22 }}
        >
          {col.label}
        </div>
      ))}

      {graph.nodes.map(node => {
        const size = cardSize(node);
        return (
          <button
            key={node.id}
            onClick={() => onSelect(node)}
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
              onSelect(node);
              setDragging({ id: node.id, dx: (node.x || 0) - e.clientX, dy: (node.y || 0) - e.clientY });
            }}
            className={`absolute text-left rounded-xl border bg-zinc-900/95 shadow-xl transition-all hover:-translate-y-0.5 hover:border-indigo-500/50 ${
              selectedId === node.id ? 'border-indigo-400 ring-2 ring-indigo-500/20' : 'border-zinc-800'
            }`}
            style={{ left: node.x, top: node.y, width: size.w, minHeight: size.h }}
          >
            <div className={`h-1.5 rounded-t-xl ${node.group === 'thread' ? 'bg-indigo-500' : node.group === 'concept' ? 'bg-emerald-500' : node.group === 'source' ? 'bg-amber-500' : node.group === 'main' ? 'bg-sky-500' : 'bg-zinc-500'}`} />
            <div className="p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <h3 className="text-sm font-bold text-zinc-100 leading-snug">{node.label}</h3>
                <span className="shrink-0 text-[9px] uppercase tracking-widest text-zinc-500">{node.kind}</span>
              </div>
              {node.detail && <p className="text-xs text-zinc-400 leading-relaxed line-clamp-5 whitespace-pre-wrap">{node.detail}</p>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function cardSize(node: UnderstandingNode) {
  if (node.group === 'thread') return { w: 290, h: 170 };
  if (node.group === 'concept') return { w: 230, h: 115 };
  if (node.group === 'source') return { w: 270, h: 120 };
  return { w: 270, h: 135 };
}

function actionLabel(action?: string) {
  switch (action) {
    case 'details': return 'Details';
    case 'simplify': return 'Simplify';
    case 'examples': return 'Examples';
    case 'links': return 'Links';
    case 'videos': return 'Videos';
    case 'deep': return 'Deep Dive';
    default: return 'Ask';
  }
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'being', 'between', 'could', 'every', 'first', 'from', 'have', 'into',
  'just', 'like', 'more', 'most', 'other', 'should', 'some', 'than', 'that', 'their', 'there', 'these', 'thing', 'this',
  'those', 'through', 'under', 'using', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your',
  'please', 'provide', 'related', 'context', 'thread', 'response', 'example', 'examples',
]);

function extractConcepts(text: string): string[] {
  const cleaned = (text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_#>()[\]{}]/g, ' ')
    .replace(/[^\w\s.-]/g, ' ');
  const phrases = new Map<string, number>();
  const add = (value: string) => {
    const words = value.split(/\s+/).map(w => w.trim()).filter(Boolean);
    if (!words.length || words.length > 4) return;
    const normalized = words.join(' ');
    const key = normalized.toLowerCase();
    if (key.length < 4 || STOP_WORDS.has(key)) return;
    phrases.set(titleCase(normalized), (phrases.get(titleCase(normalized)) || 0) + 1);
  };

  for (const match of cleaned.matchAll(/\b[A-Z][A-Za-z0-9.-]*(?:\s+[A-Z][A-Za-z0-9.-]*){0,3}\b/g)) {
    add(match[0]);
  }

  const words = cleaned.toLowerCase().split(/\s+/).filter(w => w.length > 4 && !STOP_WORDS.has(w));
  const freq = new Map<string, number>();
  for (const word of words) freq.set(word, (freq.get(word) || 0) + 1);
  for (const [word, count] of freq) {
    if (count >= 2) add(word);
  }

  return Array.from(phrases.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([value]) => value);
}

function summarizeText(text: string) {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const sentences = compact.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.slice(0, 3).join(' ').slice(0, 900);
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, ch => ch.toUpperCase());
}
