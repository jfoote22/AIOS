import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Save, FolderOpen, Plus, Copy, X, AlertCircle, MessageSquare, Trash2, Clock, Bot, Layers, Network, Search, Link2, Video, Loader2, RefreshCw, Brain, ArrowUp, ChevronRight, FileText, Target, Check } from 'lucide-react';
import ThreadedChat from '../components/ThreadedChat';
import * as db from '../lib/db';
import { onConfiguredChange, getConfigured, type ProviderId } from '../lib/providers';
import { consumeSeed, onSeedChange, type DeepDiveSeed } from '../lib/deepdiveSeed';
import { emitDeepDivesChange } from '../lib/deepdiveStore';
import { emitSnippetsChange } from '../lib/snippetStore';
import {
  isGeminiReady, analyzeDeepDiveUnderstanding, analyzeUnderstandingDrilldown,
  embedText, buildEmbedSource,
  type DeepDiveUnderstanding, type UnderstandingSourceInput,
} from '../lib/ai';

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
  /** Saved Understanding hierarchy (root network + drill-down sub-networks). */
  understanding?: UnderstandingTree;
}

interface UnderstandingNode {
  id: string;
  label: string;
  group: 'root' | 'topic' | 'subtopic' | 'insight' | 'source';
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
  kind: 'contains' | 'insight' | 'relates' | 'source';
  /** Relationship phrase shown on 'relates' edges (e.g. "depends on"). */
  label?: string;
  value: number;
}

interface UnderstandingGraph {
  nodes: UnderstandingNode[];
  links: UnderstandingLink[];
}

/** One network in the drill-down hierarchy. The root level maps the whole
 *  conversation; every other level zooms into one node of its parent. */
interface UnderstandingLevel {
  id: string;
  title: string;
  parentId: string | null;
  /** node.id in the PARENT level's graph that this level drills into. */
  parentNodeId: string | null;
  graph: UnderstandingGraph;
  /** node.id (in THIS level's graph) -> child level id. */
  children: Record<string, string>;
}

interface UnderstandingTree {
  rootId: string;
  levels: Record<string, UnderstandingLevel>;
}

type UnderstandingStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
type NodeChatAction = 'ask' | 'details' | 'simplify' | 'examples' | 'links' | 'videos' | 'deep';

// Same action set (and ordering) as ThreadedChat's text-selection context menu.
const NODE_CHAT_ACTIONS: { action: NodeChatAction; label: string; Icon: any; color: string }[] = [
  { action: 'details', label: 'Get more details', Icon: Search, color: 'text-emerald-400' },
  { action: 'links', label: 'Get links', Icon: Link2, color: 'text-sky-400' },
  { action: 'videos', label: 'Get videos', Icon: Video, color: 'text-yellow-400' },
  { action: 'deep', label: 'Deep Dive (autonomous research)', Icon: Brain, color: 'text-purple-400' },
  { action: 'examples', label: 'Give examples', Icon: FileText, color: 'text-violet-400' },
  { action: 'simplify', label: 'Simplify this', Icon: Target, color: 'text-orange-400' },
  { action: 'ask', label: 'Ask about this', Icon: MessageSquare, color: 'text-cyan-400' },
];

function levelPath(tree: UnderstandingTree, levelId: string): UnderstandingLevel[] {
  const path: UnderstandingLevel[] = [];
  let cur: UnderstandingLevel | undefined = tree.levels[levelId];
  let guard = 0;
  while (cur && guard++ < 50) {
    path.unshift(cur);
    cur = cur.parentId ? tree.levels[cur.parentId] : undefined;
  }
  return path;
}

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
  const [tree, setTree] = useState<UnderstandingTree | null>(null);
  const [currentLevelId, setCurrentLevelId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<UnderstandingNode | null>(null);
  const [understandingQuery, setUnderstandingQuery] = useState('');
  const [understandingStatus, setUnderstandingStatus] = useState<UnderstandingStatus>('idle');
  const [understandingError, setUnderstandingError] = useState('');
  const [drillingNodeId, setDrillingNodeId] = useState<string | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [brainStatus, setBrainStatus] = useState<'idle' | 'sending' | 'sent'>('idle');

  const currentLevel = tree && currentLevelId ? tree.levels[currentLevelId] ?? null : null;
  const understanding: UnderstandingGraph = currentLevel?.graph ?? { nodes: [], links: [] };

  useEffect(() => onConfiguredChange(setConfigured), []);
  useEffect(() => { refresh(); }, []);

  // Consume a pending seed from Second Brain on mount, and listen for new ones.
  useEffect(() => {
    const apply = (seed: DeepDiveSeed | null) => {
      if (!seed) return;
      const prompt = buildSeedPrompt(seed);
      // Small delay so the ref is wired up when navigating from another tab.
      // Send immediately — no extra "press send" step — then focus lands back
      // in the (now empty) input, ready for a follow-up question.
      setTimeout(() => {
        const chat = threadedChatRef.current;
        if (chat?.sendMainMessage) chat.sendMainMessage(prompt);
        else chat?.setMainInput?.(prompt);
      }, 80);
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
        understanding: tree ?? undefined,
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
      // Restore the saved Understanding hierarchy (if any) so Understand opens
      // it instantly instead of re-running the analysis.
      const savedTree = record.understanding && record.understanding.rootId && record.understanding.levels?.[record.understanding.rootId]
        ? record.understanding : null;
      setTree(savedTree);
      setCurrentLevelId(savedTree?.rootId ?? null);
      setSelectedNode(null);
      setUnderstandingStatus(savedTree ? 'ready' : 'idle');
      setUnderstandingError('');
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
    setTree(null);
    setCurrentLevelId(null);
    setSelectedNode(null);
    setUnderstandingStatus('idle');
    setUnderstandingError('');
  };

  const handleCopy = () => threadedChatRef.current?.copyAllAIResponses?.();

  const runRootAnalysis = () => {
    threadedChatRef.current?.forceUpdateThreadMessages?.();
    setUnderstandingStatus('loading');
    setUnderstandingError('');
    setSelectedNode(null);
    setNodeMenu(null);
    // Small delay so forceUpdateThreadMessages has flushed before we read state.
    setTimeout(async () => {
      try {
        const state = threadedChatRef.current?.getCurrentState?.();
        const hasContent = (state?.mainMessages?.length ?? 0) > 0 || (state?.threads?.length ?? 0) > 0;
        if (!hasContent) { setUnderstandingStatus('empty'); return; }
        if (!isGeminiReady()) {
          throw new Error('Gemini API key is not configured. Open Models to add your key — it powers the topic analysis.');
        }
        const graph = await buildUnderstandingGraph(state);
        if (!graph.nodes.length) { setTree(null); setCurrentLevelId(null); setUnderstandingStatus('empty'); return; }
        const rootId = `lvl-${Date.now().toString(36)}`;
        const rootLabel = graph.nodes.find(n => n.id === 'root')?.label || 'Overview';
        setTree({
          rootId,
          levels: { [rootId]: { id: rootId, title: rootLabel, parentId: null, parentNodeId: null, graph, children: {} } },
        });
        setCurrentLevelId(rootId);
        setSelectedNode(graph.nodes[0] ?? null);
        setUnderstandingStatus('ready');
      } catch (e: any) {
        console.error('Understand failed:', e);
        setUnderstandingError(e?.message ?? String(e));
        setUnderstandingStatus('error');
      }
    }, 120);
  };

  const handleUnderstand = () => {
    setShowUnderstanding(true);
    // An existing tree (from this session or a loaded save) opens instantly;
    // Re-analyze forces a fresh run.
    if (tree && understandingStatus === 'ready') return;
    runRootAnalysis();
  };

  const handleReanalyze = () => {
    if (tree && Object.keys(tree.levels).length > 1 &&
        !confirm('Re-analyzing rebuilds the root network and discards all drill-down sub-networks. Continue?')) return;
    setTree(null);
    setCurrentLevelId(null);
    runRootAnalysis();
  };

  const navigateToLevel = (levelId: string) => {
    if (!tree || !tree.levels[levelId]) return;
    setCurrentLevelId(levelId);
    setSelectedNode(tree.levels[levelId].graph.nodes[0] ?? null);
    setUnderstandingQuery('');
    setNodeMenu(null);
  };

  // Create (or open, if it already exists) the drill-down sub-network for a node.
  const handleDrill = async (node: UnderstandingNode) => {
    if (!tree || !currentLevelId || node.group === 'root') return;
    const existing = tree.levels[currentLevelId]?.children[node.id];
    if (existing) { navigateToLevel(existing); return; }
    if (drillingNodeId) return; // one drill at a time
    setNodeMenu(null);
    setDrillingNodeId(node.id);
    const levelIdAtStart = currentLevelId;
    try {
      if (!isGeminiReady()) {
        throw new Error('Gemini API key is not configured. Open Models to add your key.');
      }
      threadedChatRef.current?.forceUpdateThreadMessages?.();
      await new Promise(r => setTimeout(r, 120));
      const state = threadedChatRef.current?.getCurrentState?.();
      const { transcript, sources } = buildAnalysisInput(
        Array.isArray(state?.mainMessages) ? state.mainMessages : [],
        Array.isArray(state?.threads) ? state.threads : [],
        Array.isArray(state?.attachments) ? state.attachments : [],
      );
      if (!transcript.trim()) throw new Error('No conversation content to analyze.');
      const path = levelPath(tree, levelIdAtStart).map(l => l.title);
      const analysis = await analyzeUnderstandingDrilldown(
        { label: node.label, detail: node.detail || '' },
        [...path, node.label],
        transcript,
        sources.map(s => ({ id: s.id, title: s.title, description: s.description })),
      );
      const graph = layoutUnderstandingGraph(graphFromAnalysis(analysis, sources));
      const levelId = `lvl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      setTree(prev => {
        if (!prev || !prev.levels[levelIdAtStart]) return prev;
        const parent = prev.levels[levelIdAtStart];
        return {
          ...prev,
          levels: {
            ...prev.levels,
            [levelIdAtStart]: { ...parent, children: { ...parent.children, [node.id]: levelId } },
            [levelId]: { id: levelId, title: node.label, parentId: levelIdAtStart, parentNodeId: node.id, graph, children: {} },
          },
        };
      });
    } catch (e: any) {
      console.error('Drill-down failed:', e);
      alert(`Sub-network failed: ${e?.message ?? e}`);
    } finally {
      setDrillingNodeId(null);
    }
  };

  // Text handed to the chat when a node is sent to a context action — the same
  // role the selected text plays in the normal selection flow.
  const nodeContextText = (node: UnderstandingNode) => {
    const detail = (node.detail || '').trim();
    return clip(detail ? `${node.label} — ${detail}` : node.label, 1500);
  };

  const spawnFromNode = (node: UnderstandingNode, action: NodeChatAction) => {
    const text = nodeContextText(node);
    setNodeMenu(null);
    setShowUnderstanding(false);
    // Let the modal close before the thread spawns so the new thread is visible.
    setTimeout(() => threadedChatRef.current?.spawnThreadFromContext?.(text, action), 150);
  };

  // Export the CURRENT network to the Second Brain as a doc cluster: one
  // overview neuron + one neuron per topic, sharing a memoryDocId so the
  // brain's existing collapse/expand switch shows them as one node (compact)
  // or one neuron per topic (expanded).
  const handleSendToBrain = async () => {
    if (!currentLevel || brainStatus !== 'idle') return;
    try {
      setBrainStatus('sending');
      if (!isGeminiReady()) {
        throw new Error('Gemini API key is not configured. Open Models to add your key.');
      }
      await exportUnderstandingToBrain(currentLevel, tree && currentLevelId ? levelPath(tree, currentLevelId).map(l => l.title) : []);
      setBrainStatus('sent');
      setTimeout(() => setBrainStatus('idle'), 2500);
    } catch (e: any) {
      console.error('Send to Brain failed:', e);
      setBrainStatus('idle');
      alert(`Send to Brain failed: ${e?.message ?? e}`);
    }
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
                      <p className="text-[11px] text-zinc-500">
                        {understandingStatus === 'loading'
                          ? 'Reading the conversation and mapping topics…'
                          : understandingStatus === 'ready'
                            ? `${understanding.nodes.filter(n => n.group === 'topic' || n.group === 'subtopic').length} topics · ${understanding.nodes.filter(n => n.group === 'insight').length} insights · ${understanding.links.length} relationships`
                            : 'Topic map of what this DeepDive is about'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSendToBrain}
                      disabled={understandingStatus !== 'ready' || brainStatus === 'sending'}
                      className={`flex items-center gap-1.5 px-3 py-1.5 border text-[10px] font-bold uppercase tracking-wider rounded-lg transition-colors disabled:opacity-50 ${
                        brainStatus === 'sent'
                          ? 'bg-emerald-600/15 border-emerald-500/40 text-emerald-300'
                          : 'bg-indigo-600/15 hover:bg-indigo-600/25 border-indigo-500/30 text-indigo-300 hover:text-indigo-200'
                      }`}
                      title="Save this network to the Second Brain (one neuron per topic, collapsible to a single cluster)"
                    >
                      {brainStatus === 'sending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : brainStatus === 'sent' ? <Check className="w-3.5 h-3.5" />
                        : <Brain className="w-3.5 h-3.5" />}
                      {brainStatus === 'sent' ? 'Sent to Brain' : 'Send to Brain'}
                    </button>
                    <button
                      onClick={handleReanalyze}
                      disabled={understandingStatus === 'loading'}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white text-[10px] font-bold uppercase tracking-wider rounded-lg transition-colors disabled:opacity-50"
                      title="Re-run the topic analysis on the current conversation"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${understandingStatus === 'loading' ? 'animate-spin' : ''}`} />Re-analyze
                    </button>
                    <button onClick={() => setShowUnderstanding(false)} className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </header>

                {/* Level breadcrumbs — visible once a hierarchy exists */}
                {understandingStatus === 'ready' && tree && currentLevel && (
                  <div className="h-10 px-5 border-b border-zinc-800 flex items-center gap-2 shrink-0 bg-zinc-950/60">
                    <button
                      onClick={() => currentLevel.parentId && navigateToLevel(currentLevel.parentId)}
                      disabled={!currentLevel.parentId}
                      className="flex items-center gap-1 px-2 py-1 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-md text-[10px] font-bold uppercase tracking-wider text-zinc-400 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-400"
                      title="Go up one level"
                    >
                      <ArrowUp className="w-3 h-3" />Up
                    </button>
                    <div className="flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-hide">
                      {levelPath(tree, currentLevel.id).map((lvl, i, arr) => (
                        <div key={lvl.id} className="flex items-center gap-1 shrink-0">
                          {i > 0 && <ChevronRight className="w-3 h-3 text-zinc-700" />}
                          <button
                            onClick={() => navigateToLevel(lvl.id)}
                            className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                              i === arr.length - 1 ? 'bg-indigo-600/15 text-indigo-300' : 'text-zinc-500 hover:text-white hover:bg-zinc-800'
                            }`}
                          >
                            {lvl.title.length > 40 ? lvl.title.slice(0, 40) + '…' : lvl.title}
                          </button>
                        </div>
                      ))}
                    </div>
                    <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
                      Right-click a node for actions · double-click outlined nodes to dive in
                    </span>
                  </div>
                )}

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

                  <main className="relative min-h-0 bg-zinc-950 overflow-hidden">
                    {understandingStatus === 'loading' ? (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-sm text-zinc-400">
                        <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
                        <div className="text-center">
                          <p className="font-semibold text-zinc-300">Reading the conversation…</p>
                          <p className="text-xs text-zinc-500 mt-1">Extracting topics, key insights, and how they relate.</p>
                        </div>
                      </div>
                    ) : understandingStatus === 'error' ? (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
                        <AlertCircle className="w-8 h-8 text-red-400" />
                        <p className="text-sm text-zinc-300 max-w-md leading-relaxed">{understandingError || 'Analysis failed.'}</p>
                        <button onClick={handleUnderstand}
                          className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold rounded-lg uppercase tracking-wider transition-colors">
                          <RefreshCw className="w-3.5 h-3.5" />Try again
                        </button>
                      </div>
                    ) : understanding.nodes.length === 0 ? (
                      <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
                        No DeepDive content to map yet. Start a conversation first.
                      </div>
                    ) : (
                      <UnderstandingMap
                        key={currentLevelId || 'root'}
                        graph={understanding}
                        selectedId={selectedNode?.id || null}
                        childNodeIds={new Set(Object.keys(currentLevel?.children ?? {}))}
                        drillingNodeId={drillingNodeId}
                        onSelect={setSelectedNode}
                        onNodeContextMenu={(node, x, y) => {
                          setSelectedNode(node);
                          setNodeMenu({ x, y, nodeId: node.id });
                        }}
                        onNodeDoubleClick={(node) => {
                          const child = currentLevel?.children[node.id];
                          if (child) navigateToLevel(child);
                        }}
                        onMoveNode={(id, x, y) => {
                          setTree(prev => {
                            if (!prev || !currentLevelId || !prev.levels[currentLevelId]) return prev;
                            const lvl = prev.levels[currentLevelId];
                            return {
                              ...prev,
                              levels: {
                                ...prev.levels,
                                [currentLevelId]: {
                                  ...lvl,
                                  graph: { ...lvl.graph, nodes: lvl.graph.nodes.map(n => (n.id === id ? { ...n, x, y } : n)) },
                                },
                              },
                            };
                          });
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
                        {selectedNode.group !== 'root' && (
                          <div className="space-y-2">
                            <button
                              onClick={() => handleDrill(selectedNode)}
                              disabled={!!drillingNodeId}
                              className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all active:scale-95 disabled:opacity-60 disabled:active:scale-100 ${
                                currentLevel?.children[selectedNode.id]
                                  ? 'bg-zinc-900 hover:bg-zinc-800 border border-indigo-500/40 text-indigo-300'
                                  : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/10'
                              }`}
                            >
                              {drillingNodeId === selectedNode.id ? (
                                <><Loader2 className="w-3.5 h-3.5 animate-spin" />Building sub-network…</>
                              ) : currentLevel?.children[selectedNode.id] ? (
                                <><Layers className="w-3.5 h-3.5" />Open sub-network</>
                              ) : (
                                <><Network className="w-3.5 h-3.5" />Create sub-network</>
                              )}
                            </button>
                            <p className="text-[10px] text-zinc-600 text-center">Right-click the node for chat actions (details, links, deep dive…)</p>
                          </div>
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
                                return <p key={idx} className="text-xs text-zinc-500"><span className="text-zinc-400">{l.label || l.kind}</span> · {other?.label || otherId}</p>;
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

                {/* Node right-click menu */}
                {nodeMenu && (() => {
                  const node = understanding.nodes.find(n => n.id === nodeMenu.nodeId);
                  if (!node) return null;
                  const left = Math.max(8, Math.min(nodeMenu.x, window.innerWidth - 280));
                  const top = Math.max(8, Math.min(nodeMenu.y, window.innerHeight - (node.group === 'root' ? 330 : 390)));
                  return (
                    <div
                      className="fixed inset-0 z-[200]"
                      onClick={() => setNodeMenu(null)}
                      onContextMenu={(e) => { e.preventDefault(); setNodeMenu(null); }}
                    >
                      <div
                        className="absolute w-64 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
                        style={{ left, top }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-950/60">
                          <p className="text-[9px] uppercase tracking-widest text-zinc-500">{node.kind}</p>
                          <p className="text-xs font-bold text-zinc-100 truncate">{node.label}</p>
                        </div>
                        <div className="py-1">
                          {NODE_CHAT_ACTIONS.map(({ action, label, Icon, color }) => (
                            <button
                              key={action}
                              onClick={() => spawnFromNode(node, action)}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                            >
                              <Icon className={`w-3.5 h-3.5 ${color}`} />{label}
                            </button>
                          ))}
                        </div>
                        {node.group !== 'root' && (
                          <div className="py-1 border-t border-zinc-800">
                            <button
                              onClick={() => handleDrill(node)}
                              disabled={!!drillingNodeId}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs font-semibold text-indigo-300 hover:bg-indigo-600/15 transition-colors disabled:opacity-50"
                            >
                              {currentLevel?.children[node.id]
                                ? <><Layers className="w-3.5 h-3.5" />Open sub-network</>
                                : <><Network className="w-3.5 h-3.5" />Create sub-network</>}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
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

// ---------- Understanding graph: semantic topic map ----------
// Collects the whole conversation (main chat + every thread + research reports
// + attachments) into a transcript, sends it to Gemini for topic/insight
// extraction, and builds a cluster graph of the SUBJECT MATTER — not the chat
// structure.

interface SourceRef extends UnderstandingSourceInput {
  url?: string;
  isVideo?: boolean;
}

const MAX_MSG_CHARS = 2500;
const MAX_REPORT_CHARS = 9000;
const MAX_TRANSCRIPT_CHARS = 90_000;
const MAX_SOURCES = 24;

function clip(text: string, max: number): string {
  const t = (text || '').trim();
  return t.length > max ? t.slice(0, max) + ' …' : t;
}

function buildAnalysisInput(mainMessages: any[], threads: any[], attachments: any[]): { transcript: string; sources: SourceRef[] } {
  const parts: string[] = [];
  const sources: SourceRef[] = [];
  let sourceN = 0;
  const pushSource = (raw: any, isVideo: boolean, description: string) => {
    if (sources.length >= MAX_SOURCES) return;
    const title = raw?.title || raw?.url || raw?.channel || 'Source';
    sourceN += 1;
    sources.push({ id: `S${sourceN}`, title, description: clip(description, 240), url: raw?.url, isVideo });
  };

  if (mainMessages.length) {
    parts.push('=== MAIN CHAT ===');
    for (const m of mainMessages) {
      const content = (m?.content || '').trim();
      if (!content) continue;
      parts.push(`${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clip(content, MAX_MSG_CHARS)}`);
    }
  }

  for (const [idx, thread] of threads.entries()) {
    parts.push(`=== THREAD: ${thread.title || `Thread ${idx + 1}`} ===`);
    if (thread.selectedContext) parts.push(`(branched from this selected text): ${clip(thread.selectedContext, 1200)}`);
    for (const m of thread.messages || []) {
      const content = (m?.content || '').trim();
      if (!content) continue;
      parts.push(`${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clip(content, MAX_MSG_CHARS)}`);
    }
    const r = thread.research;
    if (r?.intro) parts.push(`RESEARCH INTRO: ${clip(r.intro, 1500)}`);
    if (r?.kind === 'deep' && r.report) parts.push(`DEEP RESEARCH REPORT:\n${clip(r.report, MAX_REPORT_CHARS)}`);

    for (const s of r?.links || []) pushSource(s, false, s.reason || s.source || s.url || '');
    for (const v of r?.videos || []) pushSource(v, true, v.reason || v.channel || '');
    for (const s of r?.sources || []) pushSource(s, false, s.summary || s.subQuestion || s.url || '');
  }

  const readyAttachments = attachments.filter((a: any) => a?.text);
  if (readyAttachments.length) {
    parts.push('=== ATTACHED MATERIAL ===');
    for (const a of readyAttachments) {
      parts.push(`ATTACHMENT "${a.title || a.label || a.source}": ${clip(a.text, 2000)}`);
    }
  }

  let transcript = parts.join('\n\n');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n\n…(transcript truncated for length)';
  }
  return { transcript, sources };
}

async function buildUnderstandingGraph(state: any): Promise<UnderstandingGraph> {
  const mainMessages = Array.isArray(state?.mainMessages) ? state.mainMessages : [];
  const threads = Array.isArray(state?.threads) ? state.threads : [];
  const attachments = Array.isArray(state?.attachments) ? state.attachments : [];

  const { transcript, sources } = buildAnalysisInput(mainMessages, threads, attachments);
  if (!transcript.trim()) return { nodes: [], links: [] };

  const analysis = await analyzeDeepDiveUnderstanding(
    transcript,
    sources.map(s => ({ id: s.id, title: s.title, description: s.description })),
  );
  return layoutUnderstandingGraph(graphFromAnalysis(analysis, sources));
}

function graphFromAnalysis(analysis: DeepDiveUnderstanding, sources: SourceRef[]): UnderstandingGraph {
  const nodes: UnderstandingNode[] = [];
  const links: UnderstandingLink[] = [];
  const addNode = (node: UnderstandingNode) => {
    if (!nodes.some(n => n.id === node.id)) nodes.push(node);
  };
  const addLink = (link: UnderstandingLink) => {
    if (link.source !== link.target && !links.some(l => l.source === link.source && l.target === link.target && l.kind === link.kind)) links.push(link);
  };

  addNode({
    id: 'root',
    label: analysis.title || 'This DeepDive',
    group: 'root',
    kind: 'overview',
    val: 14,
    detail: analysis.summary || '',
  });

  const topicIds = new Set(analysis.topics.map(t => t.id));
  const topicNodeId = (id: string) => `topic:${id}`;
  // A subtopic whose parent the model never emitted is promoted to top-level.
  const isSub = (t: { id: string; parentId: string }) => !!t.parentId && t.parentId !== t.id && topicIds.has(t.parentId);

  for (const t of analysis.topics) {
    const sub = isSub(t);
    addNode({
      id: topicNodeId(t.id),
      label: t.label,
      group: sub ? 'subtopic' : 'topic',
      kind: sub ? 'subtopic' : 'topic',
      val: sub ? 8 : 11,
      detail: t.summary,
    });
  }
  for (const t of analysis.topics) {
    addLink({
      source: isSub(t) ? topicNodeId(t.parentId) : 'root',
      target: topicNodeId(t.id),
      kind: 'contains',
      value: isSub(t) ? 2 : 3,
    });
  }

  analysis.insights.forEach((ins, i) => {
    const id = `insight:${i}`;
    addNode({ id, label: ins.label, group: 'insight', kind: 'insight', val: 6, detail: ins.detail });
    addLink({
      source: topicIds.has(ins.topicId) ? topicNodeId(ins.topicId) : 'root',
      target: id,
      kind: 'insight',
      value: 2,
    });
  });

  for (const cl of analysis.crossLinks) {
    if (!topicIds.has(cl.fromTopicId) || !topicIds.has(cl.toTopicId)) continue;
    addLink({
      source: topicNodeId(cl.fromTopicId),
      target: topicNodeId(cl.toTopicId),
      kind: 'relates',
      label: cl.label || 'relates to',
      value: 2,
    });
  }

  const assignedTopic = new Map(analysis.sourceAssignments.map(a => [a.sourceId, a.topicId]));
  sources.forEach((s, i) => {
    const topicId = assignedTopic.get(s.id);
    if (!topicId || !topicIds.has(topicId)) return; // model judged it irrelevant
    const id = `source:${i}`;
    addNode({
      id,
      label: s.title,
      group: 'source',
      kind: s.isVideo ? 'video' : 'link',
      val: 4,
      detail: s.description,
      data: { url: s.url },
    });
    addLink({ source: topicNodeId(topicId), target: id, kind: 'source', value: 1.5 });
  });

  return { nodes, links };
}

// Radial cluster layout: the overview sits in the center, topics fan around it,
// and each topic's subtopics/insights/sources fan outward within the topic's
// angular sector — so everything about one topic stays visually together.
function layoutUnderstandingGraph(graph: UnderstandingGraph): UnderstandingGraph {
  if (!graph.nodes.length) return graph;

  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const l of graph.links) {
    if (l.kind === 'relates') continue; // cross-links don't define clusters
    if (!children.has(l.source)) children.set(l.source, []);
    children.get(l.source)!.push(l.target);
    hasParent.add(l.target);
  }

  const leafCount = (id: string): number => {
    const kids = children.get(id) || [];
    return kids.length ? kids.reduce((sum, k) => sum + leafCount(k), 0) : 1;
  };

  const RADII = [0, 540, 1010, 1400, 1720];
  const pos = new Map<string, { x: number; y: number }>();

  const place = (id: string, depth: number, a0: number, a1: number) => {
    if (depth === 0) {
      pos.set(id, { x: 0, y: 0 });
    } else {
      const mid = (a0 + a1) / 2;
      const r = RADII[Math.min(depth, RADII.length - 1)];
      pos.set(id, { x: r * Math.cos(mid), y: r * Math.sin(mid) });
    }
    const kids = children.get(id) || [];
    if (!kids.length) return;
    const total = kids.reduce((s, k) => s + leafCount(k), 0);
    let start = a0;
    for (const k of kids) {
      const span = ((a1 - a0) * leafCount(k)) / total;
      place(k, depth + 1, start, start + span);
      start += span;
    }
  };

  place('root', 0, -Math.PI / 2, (3 * Math.PI) / 2);

  // Anything not reachable from the root (shouldn't normally happen) lines up below.
  let strayX = 0;
  for (const n of graph.nodes) {
    if (!pos.has(n.id)) {
      pos.set(n.id, { x: strayX, y: RADII[RADII.length - 1] + 360 });
      strayX += cardSize(n).w + 40;
    }
  }

  const placed = graph.nodes.map(n => {
    const p = pos.get(n.id)!;
    const size = cardSize(n);
    return { ...n, x: p.x - size.w / 2, y: p.y - size.h / 2 };
  });
  const minX = Math.min(...placed.map(n => n.x!));
  const minY = Math.min(...placed.map(n => n.y!));
  return { ...graph, nodes: placed.map(n => ({ ...n, x: n.x! - minX + 80, y: n.y! - minY + 80 })) };
}

// Export one understanding network to the Second Brain as a doc cluster:
// part 1 = overview neuron, parts 2..N = one neuron per topic (carrying its
// subtopics, insights, and sources as markdown). All parts share a
// memoryDocId, so the brain's existing cluster switch collapses them to a
// single node or expands them to one neuron per topic.
async function exportUnderstandingToBrain(level: UnderstandingLevel, path: string[]): Promise<void> {
  const { nodes, links } = level.graph;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const root = nodes.find(n => n.group === 'root');
  const topics = nodes.filter(n => n.group === 'topic');
  if (!root && !topics.length) throw new Error('Nothing to export yet.');

  const childrenOf = (id: string, kinds: UnderstandingLink['kind'][]) =>
    links
      .filter(l => l.source === id && kinds.includes(l.kind))
      .map(l => byId.get(l.target))
      .filter(Boolean) as UnderstandingNode[];

  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const networkSlug = slug(level.title) || 'understanding';

  const sourceLine = (s: UnderstandingNode) =>
    `- ${s.label}${s.data?.url ? ` — ${s.data.url}` : s.detail ? ` — ${s.detail}` : ''}`;
  const insightLines = (ownerId: string) =>
    childrenOf(ownerId, ['insight']).map(i => `- **${i.label}**${i.detail ? ` — ${i.detail}` : ''}`);

  const topicMarkdown = (topic: UnderstandingNode) => {
    const md: string[] = [`# ${topic.label}`, ''];
    if (topic.detail) md.push(topic.detail, '');
    const insights = insightLines(topic.id);
    if (insights.length) md.push('## Key insights', ...insights, '');
    for (const sub of childrenOf(topic.id, ['contains']).filter(n => n.group === 'subtopic')) {
      md.push(`## ${sub.label}`, '');
      if (sub.detail) md.push(sub.detail, '');
      const subInsights = insightLines(sub.id);
      if (subInsights.length) md.push(...subInsights, '');
    }
    const topicSources = [
      ...childrenOf(topic.id, ['source']),
      ...childrenOf(topic.id, ['contains']).flatMap(sub => childrenOf(sub.id, ['source'])),
    ];
    if (topicSources.length) md.push('## Sources', ...topicSources.map(sourceLine), '');
    return md.join('\n').trim();
  };

  const overviewMd: string[] = [`# ${level.title} — Understanding Map`, ''];
  if (root?.detail) overviewMd.push(root.detail, '');
  if (path.length > 1) overviewMd.push(`Drill path: ${path.join(' → ')}`, '');
  if (topics.length) {
    overviewMd.push('## Topics');
    for (const t of topics) overviewMd.push(`- **${t.label}**${t.detail ? ` — ${t.detail}` : ''}`);
    overviewMd.push('');
  }
  const relates = links
    .filter(l => l.kind === 'relates')
    .map(l => `- ${byId.get(l.source)?.label ?? l.source} — ${l.label || 'relates to'} → ${byId.get(l.target)?.label ?? l.target}`);
  if (relates.length) overviewMd.push('## How the topics relate', ...relates, '');

  const parts = [
    {
      title: `${level.title} — Understanding Map`,
      summary: root?.detail || `Understanding map of ${level.title}.`,
      text: overviewMd.join('\n').trim(),
      extraTags: [] as string[],
    },
    ...topics.map(t => ({
      title: t.label,
      summary: t.detail || '',
      text: topicMarkdown(t),
      extraTags: [slug(t.label)].filter(Boolean),
    })),
  ];

  const exportId = `und-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const total = parts.length;
  for (let i = 0; i < total; i++) {
    const p = parts[i];
    const tags = Array.from(new Set(['understanding', networkSlug, ...p.extraTags]));
    const item: any = {
      id: i === 0 ? exportId : `${exportId}-c${i}`,
      image: '',
      subImages: [],
      timestamp: Date.now(),
      title: p.title,
      summary: p.summary,
      category: 'Understanding',
      source: 'DeepDive Understanding',
      tags,
      entities: [],
      extractedText: p.text,
      status: 'ready',
      ...(total > 1 ? { memoryDocId: exportId, memoryPart: i + 1, memoryParts: total } : {}),
    };
    const embedding = await embedText(buildEmbedSource(item));
    await db.putSnippet({ ...item, embedding });
  }
  emitSnippetsChange();
}

function UnderstandingMap({
  graph, selectedId, childNodeIds, drillingNodeId, onSelect, onMoveNode, onNodeContextMenu, onNodeDoubleClick,
}: {
  graph: UnderstandingGraph;
  selectedId: string | null;
  /** Nodes that own a drill-down sub-network (rendered with an outline + badge). */
  childNodeIds: Set<string>;
  drillingNodeId: string | null;
  onSelect: (node: UnderstandingNode) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onNodeContextMenu: (node: UnderstandingNode, x: number, y: number) => void;
  onNodeDoubleClick: (node: UnderstandingNode) => void;
}) {
  const width = Math.max(1900, ...graph.nodes.map(n => (n.x || 0) + cardSize(n).w + 120));
  const height = Math.max(1100, ...graph.nodes.map(n => (n.y || 0) + cardSize(n).h + 120));
  const byId = new Map(graph.nodes.map(n => [n.id, n]));

  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };

  const [dragging, setDragging] = useState<{ id: string; startMx: number; startMy: number; nodeX: number; nodeY: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ mx: 0, my: 0, vx: 0, vy: 0 });

  // Start fitted so the entire network is visible.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const { width: w, height: h } = sizeRef.current;
    const s = Math.max(0.1, Math.min(1, (el.clientWidth - 60) / w, (el.clientHeight - 60) / h));
    setView({ x: (el.clientWidth - w * s) / 2, y: (el.clientHeight - h * s) / 2, scale: s });
  }, []);

  // Scroll-wheel zoom toward the cursor. Attached manually so the listener is
  // non-passive — preventDefault keeps the panel from scrolling instead.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { width: w, height: h } = sizeRef.current;
      // Min zoom: just past "the whole network fits"; max: 2.5x.
      const fit = Math.min((rect.width - 60) / w, (rect.height - 60) / h);
      const minScale = Math.min(1, fit) * 0.7;
      setView(v => {
        const next = Math.min(2.5, Math.max(minScale, v.scale * Math.exp(-e.deltaY * 0.0012)));
        if (next === v.scale) return v;
        const wx = (mx - v.x) / v.scale;
        const wy = (my - v.y) / v.scale;
        return { x: mx - wx * next, y: my - wy * next, scale: next };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Middle-mouse panning.
  useEffect(() => {
    if (!panning) return;
    const onMove = (e: MouseEvent) => {
      setView(v => ({
        ...v,
        x: panStart.current.vx + (e.clientX - panStart.current.mx),
        y: panStart.current.vy + (e.clientY - panStart.current.my),
      }));
    };
    const onUp = () => setPanning(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [panning]);

  // Left-mouse card dragging, corrected for the current zoom level.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const scale = viewRef.current.scale || 1;
      onMoveNode(
        dragging.id,
        Math.max(10, dragging.nodeX + (e.clientX - dragging.startMx) / scale),
        Math.max(10, dragging.nodeY + (e.clientY - dragging.startMy) / scale),
      );
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
    <div
      ref={viewportRef}
      className="absolute inset-0 overflow-hidden"
      style={{ cursor: panning ? 'grabbing' : undefined }}
      onMouseDown={(e) => {
        if (e.button !== 1) return;
        e.preventDefault(); // suppress the browser's middle-click autoscroll
        panStart.current = { mx: e.clientX, my: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
        setPanning(true);
      }}
    >
      <div
        className="absolute left-0 top-0"
        style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: '0 0' }}
      >
      <svg className="absolute inset-0 pointer-events-none" width={width} height={height}>
        <defs>
          <marker id="arrow-understand" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L0,6 L7,3 z" fill="rgba(161,161,170,0.65)" />
          </marker>
        </defs>
        {graph.links.map((link, idx) => {
          const sourceId = typeof link.source === 'string' ? link.source : (link.source as any).id;
          const targetId = typeof link.target === 'string' ? link.target : (link.target as any).id;
          const source = byId.get(sourceId);
          const target = byId.get(targetId);
          if (!source || !target) return null;
          const sSize = cardSize(source);
          const tSize = cardSize(target);
          const x1 = (source.x || 0) + sSize.w / 2;
          const y1 = (source.y || 0) + sSize.h / 2;
          const x2 = (target.x || 0) + tSize.w / 2;
          const y2 = (target.y || 0) + tSize.h / 2;
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          const isRelates = link.kind === 'relates';
          // Cross-links bow outward so they read differently from tree edges.
          const dx = x2 - x1, dy = y2 - y1;
          const dist = Math.max(1, Math.hypot(dx, dy));
          const bow = isRelates ? Math.min(120, dist * 0.18) : 0;
          const cx = mx - (dy / dist) * bow;
          const cy = my + (dx / dist) * bow;
          const color = isRelates
            ? 'rgba(129,140,248,0.75)'
            : link.kind === 'insight'
              ? 'rgba(34,197,94,0.45)'
              : link.kind === 'source'
                ? 'rgba(245,158,11,0.4)'
                : 'rgba(113,113,122,0.4)';
          return (
            <g key={`${sourceId}-${targetId}-${idx}`}>
              <path
                d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
                fill="none"
                stroke={color}
                strokeWidth={Math.max(1, Math.min(3, link.value || 1))}
                strokeDasharray={isRelates ? '7 5' : undefined}
                markerEnd="url(#arrow-understand)"
              />
              {isRelates && link.label && (
                <text
                  x={(x1 + 2 * cx + x2) / 4}
                  y={(y1 + 2 * cy + y2) / 4}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="600"
                  fill="rgb(165,180,252)"
                  style={{ paintOrder: 'stroke', stroke: 'rgba(9,9,11,0.92)', strokeWidth: 5 }}
                >
                  {link.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {graph.nodes.map(node => {
        const size = cardSize(node);
        const hasChild = childNodeIds.has(node.id);
        const isDrilling = drillingNodeId === node.id;
        return (
          <button
            key={node.id}
            onClick={() => onSelect(node)}
            onDoubleClick={() => onNodeDoubleClick(node)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onNodeContextMenu(node, e.clientX, e.clientY);
            }}
            onMouseDown={(e) => {
              if (e.button !== 0) return; // middle button falls through to canvas panning
              if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
              onSelect(node);
              setDragging({ id: node.id, startMx: e.clientX, startMy: e.clientY, nodeX: node.x || 0, nodeY: node.y || 0 });
            }}
            className={`absolute text-left rounded-xl border bg-zinc-900/95 shadow-xl transition-all hover:-translate-y-0.5 hover:border-indigo-500/50 ${
              selectedId === node.id ? 'border-indigo-400 ring-2 ring-indigo-500/20' : 'border-zinc-800'
            } ${hasChild ? 'outline outline-2 outline-offset-4 outline-indigo-400/60' : ''}`}
            style={{ left: node.x, top: node.y, width: size.w, minHeight: size.h }}
            title={hasChild ? 'Double-click to open this node\'s sub-network' : undefined}
          >
            <div className={`h-1.5 rounded-t-xl ${node.group === 'topic' ? 'bg-indigo-500' : node.group === 'subtopic' ? 'bg-sky-500' : node.group === 'insight' ? 'bg-emerald-500' : node.group === 'source' ? 'bg-amber-500' : 'bg-zinc-400'}`} />
            <div className="p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <h3 className="text-sm font-bold text-zinc-100 leading-snug">{node.label}</h3>
                <span className="shrink-0 text-[9px] uppercase tracking-widest text-zinc-500">{node.kind}</span>
              </div>
              {node.detail && <p className="text-xs text-zinc-400 leading-relaxed line-clamp-5 whitespace-pre-wrap">{node.detail}</p>}
            </div>
            {hasChild && (
              <span className="absolute -top-2.5 -right-2.5 p-1 bg-indigo-600 rounded-full border border-indigo-300/40 shadow-lg" title="Has a sub-network">
                <Layers className="w-3 h-3 text-white" />
              </span>
            )}
            {isDrilling && (
              <span className="absolute inset-0 rounded-xl bg-zinc-950/70 flex items-center justify-center">
                <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
              </span>
            )}
          </button>
        );
      })}
      </div>

      <div className="absolute top-3 left-3 z-10 flex items-center gap-3 px-3 py-1.5 bg-zinc-950/85 border border-zinc-800 rounded-lg text-[10px] uppercase tracking-widest text-zinc-500 pointer-events-none">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-indigo-500" />Topic</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-sky-500" />Subtopic</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />Insight</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500" />Source</span>
        <span className="text-zinc-600 normal-case tracking-normal">Middle-drag to pan · Scroll to zoom</span>
      </div>
    </div>
  );
}

function cardSize(node: UnderstandingNode) {
  if (node.group === 'root') return { w: 300, h: 150 };
  if (node.group === 'topic') return { w: 260, h: 140 };
  if (node.group === 'subtopic') return { w: 240, h: 125 };
  if (node.group === 'insight') return { w: 250, h: 130 };
  return { w: 250, h: 110 };
}
