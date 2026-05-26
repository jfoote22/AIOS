import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Save, FolderOpen, Plus, Copy, X, AlertCircle, MessageSquare, Trash2, Clock, Bot, Layers, BookOpen } from 'lucide-react';
import ThreadedChat from '../components/ThreadedChat';
import * as db from '../lib/db';
import { onConfiguredChange, getConfigured, type ProviderId } from '../lib/providers';

export interface DeepDiveRecord {
  id: string;
  title: string;
  description?: string;
  mainMessages: any[];
  threads: any[];
  selectedModel: string;
  learningSnippets?: any[];
  activeThreadId?: string | null;
  timestamp: number;
  updatedAt: number;
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

  useEffect(() => onConfiguredChange(setConfigured), []);
  useEffect(() => { refresh(); }, []);

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
        learningSnippets: state.learningSnippets ?? [],
        activeThreadId: state.activeThreadId ?? null,
        timestamp: currentId ? (saved.find(s => s.id === currentId)?.timestamp ?? Date.now()) : Date.now(),
        updatedAt: Date.now(),
      };
      await db.putThread(record);
      setCurrentId(id);
      await refresh();
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
        learningSnippets: record.learningSnippets ?? [],
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
    } catch (e: any) {
      console.error('Delete failed:', e);
      alert(`Delete failed: ${e?.message ?? e}`);
    }
  };

  const handleNewChat = () => {
    const state = threadedChatRef.current?.getCurrentState?.();
    const hasContent = (state?.mainMessages?.length ?? 0) > 0 || (state?.threads?.length ?? 0) > 0;
    if (hasContent && !confirm('Start a new chat? The current conversation will be cleared. Saved DeepDives are kept — Save first if you want to keep this session.')) return;
    threadedChatRef.current?.clearAllAndStartFresh?.();
    setCurrentId(null);
    setSaveTitle('');
    setSaveDescription('');
  };

  const handleCopy = () => threadedChatRef.current?.copyAllAIResponses?.();

  const formatDate = (ts: number) => {
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
  };

  const chatProviders: ProviderId[] = ['openai', 'anthropic', 'grok'];
  const hasAnyChatProvider = chatProviders.some(p => configured.has(p));

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Tab header — matches SnippingTab rhythm */}
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center justify-between bg-zinc-900/10 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-zinc-800 rounded-md"><MessageSquare className="w-4 h-4 text-indigo-400" /></div>
            <h1 className="text-sm font-bold uppercase tracking-widest text-zinc-100">DeepDives</h1>
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
                                <span className="flex items-center gap-1"><BookOpen className="w-3 h-3" />{dd.learningSnippets?.length ?? 0} snippets</span>
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
    </div>
  );
}
