import { useEffect, useRef, useState } from 'react';
import { Save, FolderOpen, Plus, Copy, X, AlertCircle } from 'lucide-react';
import ThreadedChat from '../components/ThreadedChat';
import * as db from '../lib/db';
import { isConfigured, onConfiguredChange, getConfigured, type ProviderId } from '../lib/providers';

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

  useEffect(() => {
    const unsub = onConfiguredChange(setConfigured);
    return unsub;
  }, []);

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

  // Warn if no chat-capable provider is configured
  const chatProviders: ProviderId[] = ['openai', 'anthropic', 'grok'];
  const hasAnyChatProvider = chatProviders.some(p => configured.has(p));

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800">
      <header className="h-14 border-b border-slate-700/50 px-6 flex items-center justify-between bg-slate-900/80 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold text-white">DeepDives</h1>
          {currentId && (
            <span className="bg-emerald-600/20 text-emerald-400 px-2.5 py-0.5 rounded-full text-[11px] border border-emerald-600/30 font-medium">
              Saved
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleNewChat}
            className="bg-indigo-600/90 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-md text-xs font-bold border border-indigo-500/60 flex items-center gap-1.5 transition-colors uppercase tracking-wider"
            title="Start a new chat (clears current conversation)">
            <Plus className="w-3.5 h-3.5" />New Chat
          </button>
          <button onClick={() => { if (!saveTitle) setSaveTitle(`DeepDive ${new Date().toLocaleDateString()}`); setShowSave(true); }}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-3 py-1.5 rounded-md text-xs font-medium border border-slate-700 flex items-center gap-1.5 transition-colors">
            <Save className="w-3.5 h-3.5" />Save
          </button>
          <button onClick={() => setShowLoad(true)}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-3 py-1.5 rounded-md text-xs font-medium border border-slate-700 flex items-center gap-1.5 transition-colors">
            <FolderOpen className="w-3.5 h-3.5" />Load ({saved.length})
          </button>
          <button onClick={handleCopy}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-3 py-1.5 rounded-md text-xs font-medium border border-slate-700 flex items-center gap-1.5 transition-colors">
            <Copy className="w-3.5 h-3.5" />Copy All
          </button>
        </div>
      </header>

      {!hasAnyChatProvider && (
        <div className="px-6 py-2.5 bg-amber-600/10 border-b border-amber-500/20 text-amber-300 text-xs flex items-center gap-2 shrink-0">
          <AlertCircle className="w-4 h-4" />
          No chat provider configured. Add an OpenAI, Anthropic, or Grok key in the <b>Models</b> tab to enable AI replies.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <ThreadedChat ref={threadedChatRef} />
      </div>

      {showSave && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-lg p-6 w-96 border border-slate-600">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white">{currentId ? 'Update DeepDive' : 'Save DeepDive'}</h2>
              <button onClick={() => setShowSave(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-white text-xs font-medium mb-1 block">Title *</label>
                <input type="text" value={saveTitle} onChange={(e) => setSaveTitle(e.target.value)} autoFocus
                  className="w-full bg-slate-900 text-white border border-slate-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                  placeholder="Title for your DeepDive..." />
              </div>
              <div>
                <label className="text-white text-xs font-medium mb-1 block">Description</label>
                <textarea value={saveDescription} onChange={(e) => setSaveDescription(e.target.value)}
                  className="w-full bg-slate-900 text-white border border-slate-700 rounded-md px-3 py-2 h-16 text-sm resize-none focus:outline-none focus:border-blue-500"
                  placeholder="Optional description..." />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowSave(false)} disabled={isSaving}
                className="px-3 py-1.5 text-sm text-slate-400 hover:text-white">Cancel</button>
              <button onClick={handleSave} disabled={isSaving || !saveTitle.trim()}
                className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-600 text-white px-4 py-1.5 rounded-md text-sm font-medium transition-colors">
                {isSaving ? 'Saving…' : currentId ? 'Update' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showLoad && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-lg p-6 w-[600px] max-h-[80vh] border border-slate-600 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white">Load Saved DeepDive</h2>
              <button onClick={() => setShowLoad(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            {saved.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-slate-400">No saved DeepDives yet.</p>
                <p className="text-xs text-slate-500 mt-1">Start a conversation and click Save.</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {saved.map(dd => (
                  <div key={dd.id} className="bg-slate-900 border border-slate-700 rounded-md p-3 hover:border-slate-500 transition-colors">
                    <div className="flex justify-between items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-white text-sm font-medium truncate">{dd.title}</h3>
                        {dd.description && <p className="text-slate-400 text-xs mt-0.5 line-clamp-2">{dd.description}</p>}
                        <div className="flex items-center gap-3 mt-1.5 text-[10px] text-slate-500">
                          <span>📝 {dd.mainMessages?.length ?? 0} msgs</span>
                          <span>🧵 {dd.threads?.length ?? 0} threads</span>
                          <span>📚 {dd.learningSnippets?.length ?? 0} snippets</span>
                          <span>🤖 {dd.selectedModel}</span>
                          <span>🕒 {formatDate(dd.updatedAt ?? dd.timestamp)}</span>
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <button onClick={() => handleLoad(dd)}
                          className="bg-purple-600 hover:bg-purple-700 text-white px-2.5 py-1 rounded text-xs font-medium transition-colors">Load</button>
                        <button onClick={() => handleDelete(dd.id, dd.title)}
                          className="bg-red-600/80 hover:bg-red-600 text-white px-2.5 py-1 rounded text-xs font-medium transition-colors">Delete</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

