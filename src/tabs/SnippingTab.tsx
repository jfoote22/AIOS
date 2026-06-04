import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Camera, X, Scissors, History, Search, Bell, PauseCircle, PlayCircle,
  MoreVertical, LayoutGrid, List, MessageSquare, Send, Sparkles,
  ChevronDown, ChevronRight, Trash2
} from 'lucide-react';
import * as db from '../lib/db';
import {
  analyzeSnip, analyzeText, isGeminiReady, onGeminiReadyChange,
  embedText, cosineSimilarity, buildEmbedSource, chatWithVault,
  type ChatTurn, type VaultContextItem,
} from '../lib/ai';
import SnippetEditor, {
  SortableTags, SortableEntities,
  type CapturedItem, type Entity, type ExtractedChunk, type AddedShot,
} from '../components/SnippetEditor';
import { emitSnippetsChange, onSnippetsChange } from '../lib/snippetStore';

interface Region { startX: number; startY: number; width: number; height: number; }
export type { CapturedItem };

export default function SnippingTab() {
  const [view, setView] = useState<'vault' | 'chat'>('vault');
  const [chatHistory, setChatHistory] = useState<(ChatTurn & { citedIds?: string[] })[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [textSelection, setTextSelection] = useState('');
  const [vaultLayout, setVaultLayout] = useState<'grid' | 'list'>('grid');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const extractedTextRef = useRef<HTMLPreElement | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<CapturedItem | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [selection, setSelection] = useState<Region | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [vault, setVault] = useState<CapturedItem[]>([]);
  // Always-fresh view of the vault for async callbacks (e.g. add-shot OCR).
  const vaultRef = useRef<CapturedItem[]>([]);
  vaultRef.current = vault;
  const [showFlash, setShowFlash] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [queryEmbedding, setQueryEmbedding] = useState<number[] | null>(null);
  const [isSemanticSearching, setIsSemanticSearching] = useState(false);
  const [aiReady, setAiReady] = useState<boolean>(isGeminiReady());

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isElectron = !!window.aios?.isElectron;
  const handleSnipImageRef = useRef<(p: { dataUrl: string; targetId: string | null }) => void>(() => {});

  useEffect(() => {
    const off = window.aios?.onSnipImage((payload) => { handleSnipImageRef.current(payload); });
    return () => { if (off) off(); };
  }, []);

  useEffect(() => { setAiReady(isGeminiReady()); const unsub = onGeminiReadyChange(setAiReady); return unsub; }, []);

  useEffect(() => {
    handleSnipImageRef.current = ({ dataUrl, targetId }) => {
      if (targetId) appendImageToItem(targetId, dataUrl);
      else processSnip(dataUrl);
    };
  });

  useEffect(() => {
    db.getAllSnippets<CapturedItem>()
      .then(items => {
        const normalized = items.map(i => ({
          ...i,
          title: i.title || '',
          extractedText: i.extractedText || '',
          status: i.status || 'ready' as const,
        }));
        setVault(normalized);
        if (!isGeminiReady()) return;
        const needEmbed = normalized.filter(i => i.status === 'ready' && (!i.embedding || !i.embedding.length));
        for (const item of needEmbed) {
          embedText(buildEmbedSource(item))
            .then(embedding => {
              const updated = { ...item, embedding };
              setVault(prev => prev.map(x => (x.id === item.id ? updated : x)));
              db.putSnippet(updated).catch(e => console.error('Failed to persist backfilled embedding:', e));
            })
            .catch(e => console.error('Backfill embedding failed for', item.id, e));
        }
      })
      .catch(err => console.error('Failed to load vault:', err));
  }, []);

  // Reload the vault when snippets change elsewhere (e.g. edited or deleted from
  // the Second Brain tab). Idempotent — just refreshes from SQLite.
  useEffect(() => onSnippetsChange(() => {
    db.getAllSnippets<CapturedItem>()
      .then(items => setVault(items.map(i => ({
        ...i,
        title: i.title || '',
        extractedText: i.extractedText || '',
        status: i.status || 'ready' as const,
      }))))
      .catch(err => console.error('Failed to reload vault:', err));
  }), []);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!aiReady || q.length < 3) { setQueryEmbedding(null); setIsSemanticSearching(false); return; }
    setIsSemanticSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      embedText(q)
        .then(vec => { if (!cancelled) { setQueryEmbedding(vec); setIsSemanticSearching(false); } })
        .catch(err => {
          if (!cancelled) { console.error('Query embedding failed:', err); setQueryEmbedding(null); setIsSemanticSearching(false); }
        });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchQuery, aiReady]);

  const startCapture = async () => {
    setSelectedItem(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', displaySurface: 'monitor' } as any,
      });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.onloadedmetadata = () => { video.play(); videoRef.current = video; setIsCapturing(true); };
      stream.getVideoTracks()[0].onended = () => { setIsCapturing(false); setIsSelecting(false); };
    } catch (err) { console.error('Error starting capture:', err); }
  };

  const deleteItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setVault(prev => prev.filter(i => i.id !== id));
    if (selectedItem?.id === id) setSelectedItem(null);
    db.removeSnippet(id).then(() => emitSnippetsChange()).catch(err => console.error('Failed to delete:', err));
  };

  const captureRegion = () => {
    if (!videoRef.current || !selection) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { startX, startY, width, height } = selection;
    const sx = width < 0 ? startX + width : startX;
    const sy = height < 0 ? startY + height : startY;
    const sw = Math.abs(width);
    const sh = Math.abs(height);
    if (sw < 5 || sh < 5) { setIsCapturing(false); setSelection(null); return; }
    const scaleX = video.videoWidth / window.innerWidth;
    const scaleY = video.videoHeight / window.innerHeight;
    canvas.width = sw * scaleX;
    canvas.height = sh * scaleY;
    ctx.drawImage(video, sx * scaleX, sy * scaleY, sw * scaleX, sh * scaleY, 0, 0, sw * scaleX, sh * scaleY);
    const dataUrl = canvas.toDataURL('image/png');
    processSnip(dataUrl);
    const stream = video.srcObject as MediaStream;
    stream.getTracks().forEach(track => track.stop());
    setIsCapturing(false); setSelection(null);
  };

  const processSnip = (dataUrl: string) => {
    const id = Math.random().toString(36).slice(2, 11);
    const placeholder: CapturedItem = {
      id, image: dataUrl, timestamp: Date.now(), tags: [],
      title: 'Analyzing…',
      summary: aiReady ? 'Gemini is processing this capture…' : 'Gemini key not set — open the Models tab to add your key.',
      source: '—', category: aiReady ? 'Pending' : 'Unprocessed',
      entities: [], subImages: [dataUrl], extractedText: '',
      status: aiReady ? 'analyzing' : 'error',
      error: aiReady ? undefined : 'Gemini key not set',
    };
    setVault(prev => [placeholder, ...prev]);
    db.putSnippet(placeholder).then(() => emitSnippetsChange()).catch(err => console.error('Failed to persist snip:', err));
    setShowFlash(true);
    setTimeout(() => setShowFlash(false), 800);

    if (!aiReady) return;

    analyzeSnip(dataUrl)
      .then(analysis => {
        const updated: CapturedItem = {
          ...placeholder,
          title: analysis.title, summary: analysis.summary, source: analysis.source,
          category: analysis.category, tags: analysis.tags, entities: analysis.entities,
          extractedText: analysis.extractedText, status: 'ready', error: undefined,
        };
        setVault(prev => prev.map(i => (i.id === id ? updated : i)));
        // Emit with the new id so Second Brain can auto-focus this freshly
        // analyzed neuron and open its editor.
        db.putSnippet(updated).then(() => emitSnippetsChange({ newId: id })).catch(err => console.error('Failed to persist analyzed snip:', err));

        embedText(buildEmbedSource(updated))
          .then(embedding => {
            const withEmbed = { ...updated, embedding };
            setVault(prev => prev.map(i => (i.id === id ? withEmbed : i)));
            db.putSnippet(withEmbed).then(() => emitSnippetsChange()).catch(e => console.error('Failed to persist embedding:', e));
          })
          .catch(e => console.error('Embedding failed:', e));
      })
      .catch(err => {
        console.error('AI analysis failed:', err);
        const failed: CapturedItem = {
          ...placeholder, title: 'Analysis failed',
          summary: `Gemini analysis failed: ${err?.message ?? String(err)}`,
          category: 'Unprocessed', status: 'error', error: err?.message ?? String(err),
        };
        setVault(prev => prev.map(i => (i.id === id ? failed : i)));
        db.putSnippet(failed).then(() => emitSnippetsChange()).catch(e => console.error('Failed to persist error state:', e));
      });
  };

  const updateItem = (id: string, patch: Partial<CapturedItem>, options: { reembed?: boolean } = {}) => {
    let updatedItem: CapturedItem | null = null;
    setVault(prev => prev.map(i => {
      if (i.id !== id) return i;
      updatedItem = { ...i, ...patch };
      return updatedItem!;
    }));
    setSelectedItem(prev => (prev && prev.id === id ? { ...prev, ...patch } : prev));
    if (!updatedItem) return;
    db.putSnippet(updatedItem).then(() => emitSnippetsChange()).catch(err => console.error('Failed to persist edit:', err));
    if (options.reembed && aiReady) {
      const target = updatedItem as CapturedItem;
      embedText(buildEmbedSource(target))
        .then(embedding => {
          const withEmbed = { ...target, embedding };
          setVault(prev => prev.map(i => (i.id === id ? withEmbed : i)));
          setSelectedItem(prev => (prev && prev.id === id ? withEmbed : prev));
          db.putSnippet(withEmbed).then(() => emitSnippetsChange()).catch(e => console.error('Failed to persist re-embed:', e));
        })
        .catch(e => console.error('Re-embed failed:', e));
    }
  };

  const addTagToItem = (id: string, raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag) return;
    const item = vault.find(i => i.id === id);
    if (!item || item.tags.includes(tag)) return;
    updateItem(id, { tags: [...item.tags, tag] }, { reembed: true });
  };

  const removeTagFromItem = (id: string, tag: string) => {
    const item = vault.find(i => i.id === id);
    if (!item) return;
    updateItem(id, { tags: item.tags.filter(t => t !== tag) }, { reembed: true });
  };

  const updateEntity = (id: string, index: number, patch: Partial<Entity>) => {
    const item = vault.find(i => i.id === id);
    if (!item) return;
    const next = item.entities.map((e, i) => (i === index ? { ...e, ...patch } : e));
    updateItem(id, { entities: next }, { reembed: true });
  };

  const removeEntity = (id: string, index: number) => {
    const item = vault.find(i => i.id === id);
    if (!item) return;
    updateItem(id, { entities: item.entities.filter((_, i) => i !== index) }, { reembed: true });
  };

  const addEntity = (id: string) => {
    const item = vault.find(i => i.id === id);
    if (!item) return;
    const blank: Entity = { type: 'info', label: 'NEW', value: '' };
    updateItem(id, { entities: [...item.entities, blank] });
  };

  // Add Shot: attach the captured image to the existing snippet as its own
  // "added shot" (shown stacked under the main image), then OCR/analyze it.
  // The shot keeps its own extracted text (rendered as a separate section),
  // while its tags + entities are merged up into the neuron. Title/summary/
  // category/source are left alone so the neuron keeps its identity.
  // Re-embeds so the new text is searchable. Does NOT create a new neuron.
  const appendImageToItem = async (id: string, dataUrl: string) => {
    const base = vaultRef.current.find(i => i.id === id);
    if (!base) return;
    const shotId = Math.random().toString(36).slice(2, 11);
    const placeholder: AddedShot = {
      id: shotId, image: dataUrl, extractedText: '',
      status: aiReady ? 'analyzing' : 'ready',
    };
    updateItem(id, { addedShots: [...(base.addedShots ?? []), placeholder] });
    if (!aiReady) return;

    try {
      const analysis = await analyzeSnip(dataUrl);
      const cur = vaultRef.current.find(i => i.id === id);
      if (!cur) return;
      const ready: AddedShot = { ...placeholder, extractedText: analysis.extractedText, status: 'ready' };
      const nextShots = (cur.addedShots ?? []).map(s => (s.id === shotId ? ready : s));
      const mergedTags = Array.from(new Set([...(cur.tags ?? []), ...analysis.tags.map(t => t.toLowerCase())]));
      const mergedEntities = [...(cur.entities ?? []), ...analysis.entities];
      updateItem(id, {
        addedShots: nextShots,
        tags: mergedTags,
        entities: mergedEntities,
      }, { reembed: true });
    } catch (err) {
      console.error('Add-shot OCR failed:', err);
      const cur = vaultRef.current.find(i => i.id === id);
      const nextShots = (cur?.addedShots ?? []).map(s => (s.id === shotId ? { ...s, status: 'error' as const, error: String((err as any)?.message ?? err) } : s));
      updateItem(id, { addedShots: nextShots });
    }
  };

  const removeSubImage = (id: string, index: number) => {
    const item = vault.find(i => i.id === id);
    if (!item) return;
    const next = item.subImages.filter((_, i) => i !== index);
    updateItem(id, { subImages: next });
  };

  const extractChunkFromItem = async (id: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const item = vault.find(i => i.id === id);
    if (!item) return;

    const chunkId = Math.random().toString(36).slice(2, 11);
    const placeholder: ExtractedChunk = {
      id: chunkId, text: trimmed,
      label: aiReady ? 'Analyzing…' : 'Saved chunk',
      summary: aiReady ? 'AI is analyzing this fragment…' : 'AI not configured.',
      entities: [], tags: [], timestamp: Date.now(),
      status: aiReady ? 'analyzing' : 'ready',
    };
    const existingChunks = item.chunks ?? [];
    updateItem(id, { chunks: [...existingChunks, placeholder] });

    if (!aiReady) return;

    try {
      const analysis = await analyzeText(trimmed);
      const ready: ExtractedChunk = {
        ...placeholder, label: analysis.label, summary: analysis.summary,
        entities: analysis.entities, tags: analysis.tags, status: 'ready',
      };
      const fresh = vault.find(i => i.id === id);
      const baseChunks = fresh?.chunks ?? existingChunks;
      const nextChunks = baseChunks.map(c => (c.id === chunkId ? ready : c)).concat(baseChunks.find(c => c.id === chunkId) ? [] : [ready]);
      const newTags = Array.from(new Set([...(fresh?.tags ?? item.tags), ...analysis.tags.map(t => t.toLowerCase())]));
      updateItem(id, { chunks: nextChunks, tags: newTags }, { reembed: true });
    } catch (err: any) {
      console.error('Chunk analysis failed:', err);
      const fresh = vault.find(i => i.id === id);
      const baseChunks = fresh?.chunks ?? existingChunks;
      const failed: ExtractedChunk = { ...placeholder, status: 'error', error: err?.message ?? String(err), label: 'Saved chunk', summary: trimmed.slice(0, 200) };
      updateItem(id, { chunks: baseChunks.map(c => (c.id === chunkId ? failed : c)) });
    }
  };

  const removeChunk = (itemId: string, chunkId: string) => {
    const item = vault.find(i => i.id === itemId);
    if (!item) return;
    const nextChunks = (item.chunks ?? []).filter(c => c.id !== chunkId);
    updateItem(itemId, { chunks: nextChunks }, { reembed: true });
  };

  const sendChat = async () => {
    const q = chatInput.trim();
    if (!q || chatBusy) return;
    if (!aiReady) {
      setChatHistory(h => [...h, { role: 'user', text: q }, { role: 'model', text: 'AI is not configured. Open the Models tab and add your Gemini key.' }]);
      setChatInput('');
      return;
    }
    setChatInput('');
    setChatBusy(true);
    const priorTurns: ChatTurn[] = chatHistory.map(({ role, text }) => ({ role, text }));
    setChatHistory(h => [...h, { role: 'user', text: q }, { role: 'model', text: '' }]);

    try {
      const queryVec = await embedText(q);
      const ranked = vault
        .filter(i => i.embedding && i.embedding.length && i.status === 'ready')
        .map(i => ({ item: i, sim: cosineSimilarity(queryVec, i.embedding!) }))
        .sort((a, b) => b.sim - a.sim);
      const TOP_K = 8;
      const topMatches = ranked.slice(0, TOP_K).filter(r => r.sim >= 0.4);
      const context: VaultContextItem[] = topMatches.map(r => ({
        id: r.item.id, title: r.item.title, summary: r.item.summary,
        category: r.item.category, source: r.item.source, tags: r.item.tags,
        extractedText: r.item.extractedText, timestamp: r.item.timestamp,
      }));
      const citedIds = context.map(c => c.id);

      let acc = '';
      for await (const chunk of chatWithVault(priorTurns, q, context)) {
        acc += chunk;
        setChatHistory(h => {
          const next = [...h];
          next[next.length - 1] = { role: 'model', text: acc, citedIds };
          return next;
        });
      }
    } catch (err: any) {
      console.error('Chat failed:', err);
      setChatHistory(h => {
        const next = [...h];
        next[next.length - 1] = { role: 'model', text: 'Error: ' + (err?.message ?? String(err)) };
        return next;
      });
    } finally { setChatBusy(false); }
  };

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chatHistory]);

  useEffect(() => {
    db.getMeta<(ChatTurn & { citedIds?: string[] })[]>('vault-chat-history')
      .then(saved => { if (saved && saved.length) setChatHistory(saved); })
      .catch(err => console.error('Failed to load chat history:', err));
  }, []);

  useEffect(() => {
    if (chatBusy) return;
    db.setMeta('vault-chat-history', chatHistory).catch(err => console.error('Failed to save chat history:', err));
  }, [chatHistory, chatBusy]);

  useEffect(() => { setTextSelection(''); }, [selectedItem?.id]);

  // Persist the chosen vault layout (grid/list) like the OCR provider.
  useEffect(() => {
    db.getMeta<'grid' | 'list'>('vault-layout')
      .then(v => { if (v === 'grid' || v === 'list') setVaultLayout(v); })
      .catch(() => {});
  }, []);
  const updateLayout = (l: 'grid' | 'list') => {
    setVaultLayout(l);
    db.setMeta('vault-layout', l).catch(err => console.error('Failed to save layout:', err));
  };
  const toggleRow = (id: string) =>
    setExpandedRows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Reorder tags within an item (drag-and-drop). Order-only, so no re-embed.
  const reorderTagsForItem = (id: string, from: number, to: number) => {
    const item = vault.find(i => i.id === id);
    if (!item) return;
    const next = [...item.tags];
    if (from < 0 || from >= next.length || to < 0 || to >= next.length) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateItem(id, { tags: next });
  };

  // Reorder entity blocks within an item. Entities aren't part of the embed
  // source, so order changes never need a re-embed.
  const reorderEntitiesForItem = (id: string, from: number, to: number) => {
    const item = vault.find(i => i.id === id);
    if (!item) return;
    const next = [...item.entities];
    if (from < 0 || from >= next.length || to < 0 || to >= next.length) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateItem(id, { entities: next });
  };

  const categories = Array.from(new Set(vault.map(item => item.category)));

  const filteredVault = (() => {
    const q = searchQuery.trim().toLowerCase();
    const inCategory = (item: CapturedItem) => activeCategory ? item.category === activeCategory : true;
    if (!q) return vault.filter(inCategory);

    const keywordMatch = (item: CapturedItem) =>
      (item.title ?? '').toLowerCase().includes(q) ||
      item.summary.toLowerCase().includes(q) ||
      (item.extractedText ?? '').toLowerCase().includes(q) ||
      item.tags.some(tag => tag.toLowerCase().includes(q));

    if (queryEmbedding && queryEmbedding.length) {
      const SIM_THRESHOLD = 0.55;
      const scored = vault
        .filter(inCategory)
        .map(item => {
          const sim = item.embedding?.length ? cosineSimilarity(queryEmbedding, item.embedding) : 0;
          const keyword = keywordMatch(item);
          return { item, sim, keyword };
        })
        .filter(x => x.sim >= SIM_THRESHOLD || x.keyword)
        .sort((a, b) => b.sim - a.sim);
      return scored.map(x => x.item);
    }
    return vault.filter(item => inCategory(item) && keywordMatch(item));
  })();

  const copyToClipboard = (text: string) => { navigator.clipboard.writeText(text); };

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <AnimatePresence>
        {showFlash && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-white z-[200] pointer-events-none" />
        )}
      </AnimatePresence>

      {/* Detail modal */}
      <AnimatePresence>
        {selectedItem && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[150] bg-black/90 backdrop-blur-xl overflow-y-auto"
            onClick={() => setSelectedItem(null)}>
            <div className="min-h-full flex items-start justify-center p-8">
            <div className="max-w-4xl w-full my-auto bg-zinc-900/50 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setSelectedItem(null)} className="absolute top-6 right-6 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors z-10"><X className="w-5 h-5" /></button>

              <div className="p-8 space-y-6">
                <div className="flex items-center gap-3">
                  <div className="px-3 py-1 bg-indigo-600/20 border border-indigo-500/30 rounded-lg text-indigo-400 font-bold text-[10px] uppercase tracking-widest">Original Capture</div>
                  <span className="text-zinc-500 text-xs font-mono">{selectedItem.id}</span>
                  {selectedItem.originThreadId && (
                    <span className="text-[10px] text-indigo-400/80 font-mono">from thread {selectedItem.originThreadId.slice(0, 8)}</span>
                  )}
                </div>
                <SnippetEditor
                  item={selectedItem}
                  aiReady={aiReady}
                  categories={categories}
                  isElectron={isElectron}
                  onChange={(next) => {
                    setVault(prev => prev.map(i => (i.id === next.id ? next : i)));
                    setSelectedItem(next);
                    db.putSnippet(next).then(() => emitSnippetsChange()).catch(err => console.error('Failed to persist edit:', err));
                  }}
                  onDelete={() => {
                    const id = selectedItem.id;
                    setVault(prev => prev.filter(i => i.id !== id));
                    setSelectedItem(null);
                    db.removeSnippet(id).then(() => emitSnippetsChange()).catch(err => console.error('Failed to delete:', err));
                  }}
                />
              </div>
            </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tab header */}
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center justify-between bg-zinc-900/10 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-zinc-900/60 p-1 rounded-lg border border-zinc-800">
            <button onClick={() => { setView('vault'); setActiveCategory(null); }} className={`px-3 py-1 rounded text-xs font-bold uppercase tracking-wider transition-colors ${view === 'vault' && !activeCategory ? 'bg-indigo-600/20 text-indigo-300' : 'text-zinc-500 hover:text-white'}`}>
              <History className="w-3.5 h-3.5 inline mr-1.5" />Vault
            </button>
            <button onClick={() => setView('chat')} className={`px-3 py-1 rounded text-xs font-bold uppercase tracking-wider transition-colors ${view === 'chat' ? 'bg-indigo-600/20 text-indigo-300' : 'text-zinc-500 hover:text-white'}`}>
              <MessageSquare className="w-3.5 h-3.5 inline mr-1.5" />Ask
            </button>
          </div>

          {activeCategory && (
            <button onClick={() => setActiveCategory(null)} className="text-xs text-zinc-500 hover:text-white">
              {activeCategory} <X className="w-3 h-3 inline ml-1" />
            </button>
          )}
        </div>

        <div className="relative w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input type="text"
            placeholder={aiReady ? "Ask in plain English: 'that thing about Houdini cameras'..." : "Search titles, summaries, tags, text..."}
            className="w-full bg-zinc-900/50 border border-zinc-800 rounded-lg py-1.5 pl-10 pr-24 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
            value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
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

        <button onClick={() => isElectron ? window.aios?.requestCapture() : startCapture()}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg transition-all active:scale-95 shadow-lg shadow-indigo-600/10 uppercase tracking-wider">
          <Scissors className="w-3.5 h-3.5" />Snip
        </button>
      </header>

      {/* Sub-sidebar for categories + main content */}
      <div className="flex-1 flex overflow-hidden">
        <aside className="w-56 border-r border-zinc-800 bg-zinc-900/30 p-4 overflow-y-auto scrollbar-hide">
          <div className="flex items-center justify-between mb-3 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
            <span>Categories</span>
            <span className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
          </div>
          <div className="space-y-1">
            <button onClick={() => { setView('vault'); setActiveCategory(null); }}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors ${view === 'vault' && !activeCategory ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'}`}>
              <span className="flex items-center gap-2"><LayoutGrid className="w-3.5 h-3.5" />All</span>
              <span className="text-[10px] bg-zinc-800 px-1.5 rounded-full text-zinc-500">{vault.length}</span>
            </button>
            {categories.length > 0 ? categories.map(cat => (
              <button key={cat} onClick={() => { setView('vault'); setActiveCategory(cat); }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors ${activeCategory === cat ? 'bg-indigo-600/20 text-indigo-400' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'}`}>
                <span className="flex items-center gap-2 truncate"><LayoutGrid className="w-3.5 h-3.5 shrink-0" />{cat}</span>
                <span className="text-[10px] bg-zinc-800 px-1.5 rounded-full text-zinc-500">{vault.filter(i => i.category === cat).length}</span>
              </button>
            )) : <p className="px-3 py-2 text-[11px] text-zinc-600 italic">No categories yet</p>}
          </div>
        </aside>

        <div className={`flex-1 ${view === 'chat' ? 'overflow-hidden flex' : 'overflow-y-auto'} p-8 scrollbar-hide`}>
          {view === 'vault' ? (
            <div className="max-w-7xl mx-auto">
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h3 className="text-2xl font-bold mb-1">{activeCategory ? `${activeCategory} Collection` : 'Collective History'}</h3>
                  <p className="text-xs text-zinc-500">{activeCategory ? `${filteredVault.length} insights in this vault.` : `Total intelligence gathered: ${vault.length} nuggets.`}</p>
                </div>
                <div className="flex items-center gap-2 bg-zinc-900 p-1 rounded-lg border border-zinc-800">
                  <button onClick={() => updateLayout('grid')} title="Grid view"
                    className={`p-1.5 rounded transition-colors ${vaultLayout === 'grid' ? 'bg-indigo-600/20 text-indigo-400' : 'text-zinc-500 hover:bg-zinc-800 hover:text-white'}`}>
                    <LayoutGrid className="w-4 h-4" />
                  </button>
                  <button onClick={() => updateLayout('list')} title="Compact list view"
                    className={`p-1.5 rounded transition-colors ${vaultLayout === 'list' ? 'bg-indigo-600/20 text-indigo-400' : 'text-zinc-500 hover:bg-zinc-800 hover:text-white'}`}>
                    <List className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {filteredVault.length > 0 ? (
                vaultLayout === 'grid' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
                  {filteredVault.map((item) => (
                    <motion.div key={item.id}
                      onClick={() => setSelectedItem(item)}
                      className="group bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden hover:border-indigo-500/50 transition-colors shadow-2xl flex flex-col cursor-pointer">
                      <div className="aspect-[16/9] relative overflow-hidden bg-zinc-800">
                        <img src={item.image} alt="Snip" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" />
                        <div className="absolute top-3 left-3 px-2 py-0.5 bg-black/60 backdrop-blur-xl rounded text-[10px] font-mono font-bold text-indigo-400 border border-white/5">{item.source}</div>
                      </div>
                      <div className="p-5 flex-1 flex flex-col justify-between">
                        <div className="space-y-3">
                          <div className="flex gap-1.5 items-center">
                            <span className="text-[9px] px-2 py-0.5 bg-indigo-600/10 text-indigo-400 rounded-full font-bold uppercase tracking-tighter border border-indigo-500/20">{item.category}</span>
                            {item.status === 'analyzing' && <span className="text-[9px] px-2 py-0.5 bg-amber-500/10 text-amber-400 rounded-full font-bold uppercase tracking-tighter border border-amber-500/20 animate-pulse">Analyzing</span>}
                            {item.status === 'error' && <span className="text-[9px] px-2 py-0.5 bg-red-500/10 text-red-400 rounded-full font-bold uppercase tracking-tighter border border-red-500/20">Error</span>}
                          </div>
                          {item.title && item.title !== 'Analyzing…' && <p className="text-sm text-zinc-100 leading-tight font-bold">{item.title}</p>}
                          <p className="text-xs text-zinc-400 leading-relaxed line-clamp-3">{item.summary}</p>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-zinc-600 pt-5 mt-4 border-t border-zinc-800/50">
                          <span className="flex items-center gap-1.5 italic"><History className="w-3 h-3" />{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          <MoreVertical className="w-3 h-3 cursor-pointer hover:text-white transition-colors" />
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
                ) : (
                <div className="space-y-2 max-w-5xl mx-auto">
                  {filteredVault.map((item) => {
                    const expanded = expandedRows.has(item.id);
                    return (
                      <motion.div key={item.id}
                        className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden hover:border-indigo-500/40 transition-colors">
                        {/* Thin row */}
                        <div className="flex items-center gap-3 p-2.5 cursor-pointer" onClick={() => toggleRow(item.id)}>
                          <span className="text-zinc-500 shrink-0">{expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</span>
                          <img src={item.image} alt="Snip" className="w-14 h-9 object-cover rounded-md bg-zinc-800 shrink-0" />
                          <span className="text-[9px] px-2 py-0.5 bg-indigo-600/10 text-indigo-400 rounded-full font-bold uppercase tracking-tighter border border-indigo-500/20 shrink-0">{item.category}</span>
                          <span className="text-sm text-zinc-100 font-semibold truncate flex-1 min-w-0">{(item.title && item.title !== 'Analyzing…') ? item.title : (item.summary || 'Untitled capture')}</span>
                          {item.status === 'analyzing' && <span className="text-[9px] px-2 py-0.5 bg-amber-500/10 text-amber-400 rounded-full font-bold uppercase border border-amber-500/20 animate-pulse shrink-0">Analyzing</span>}
                          {item.status === 'error' && <span className="text-[9px] px-2 py-0.5 bg-red-500/10 text-red-400 rounded-full font-bold uppercase border border-red-500/20 shrink-0">Error</span>}
                          {item.tags.length > 0 && <span className="hidden md:inline text-[10px] text-zinc-600 shrink-0">{item.tags.length} tag{item.tags.length === 1 ? '' : 's'}</span>}
                          <span className="text-[10px] text-zinc-600 shrink-0 flex items-center gap-1"><History className="w-3 h-3" />{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          <button onClick={(e) => deleteItem(item.id, e)} className="p-1.5 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0" title="Delete from vault"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>

                        {/* Expanded detail — reveals all data inline */}
                        <AnimatePresence initial={false}>
                          {expanded && (
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-t border-zinc-800">
                              <div className="p-4 grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-5">
                                <div className="space-y-3">
                                  <img src={item.image} alt="Capture" className="w-full rounded-lg border border-zinc-800 object-cover" />
                                  <button onClick={() => setSelectedItem(item)} className="w-full py-2 text-[10px] font-bold uppercase tracking-widest bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/30 rounded-lg text-indigo-300 transition-colors">Open full editor</button>
                                </div>
                                <div className="space-y-4 min-w-0">
                                  {item.title && item.title !== 'Analyzing…' && <p className="text-base font-bold text-zinc-100">{item.title}</p>}
                                  <p className="text-sm text-zinc-400 leading-relaxed">{item.summary}</p>

                                  {item.extractedText && (
                                    <div>
                                      <div className="flex items-center justify-between mb-1">
                                        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Extracted Text</p>
                                        <button onClick={() => copyToClipboard(item.extractedText)} className="text-[10px] text-indigo-400 hover:text-indigo-300 uppercase tracking-widest">Copy</button>
                                      </div>
                                      <pre className="text-[11px] text-zinc-300 whitespace-pre-wrap font-mono bg-black/30 border border-zinc-800 rounded-lg p-2 max-h-40 overflow-y-auto">{item.extractedText}</pre>
                                    </div>
                                  )}

                                  <div>
                                    <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Tags <span className="text-zinc-600 normal-case tracking-normal">· drag to reorder</span></p>
                                    <SortableTags
                                      key={item.id}
                                      tags={item.tags}
                                      onAdd={(t) => addTagToItem(item.id, t)}
                                      onRemove={(t) => removeTagFromItem(item.id, t)}
                                      onReorder={(from, to) => reorderTagsForItem(item.id, from, to)}
                                    />
                                  </div>

                                  {item.entities.length > 0 && (
                                    <div>
                                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Entities <span className="text-zinc-600 normal-case tracking-normal">· drag to reorder</span></p>
                                      <SortableEntities
                                        entities={item.entities}
                                        onReorder={(from, to) => reorderEntitiesForItem(item.id, from, to)}
                                        onEdit={(idx, patch) => updateEntity(item.id, idx, patch)}
                                        onRemove={(idx) => removeEntity(item.id, idx)}
                                        onCopy={copyToClipboard}
                                      />
                                    </div>
                                  )}

                                  <div className="flex flex-wrap gap-4 text-[11px] text-zinc-500 pt-1">
                                    <span>Category: <span className="text-zinc-300 font-semibold">{item.category}</span></span>
                                    <span>Source: <span className="text-zinc-300 font-semibold">{item.source}</span></span>
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    );
                  })}
                </div>
                )
              ) : (
                <div className="h-[50vh] flex flex-col items-center justify-center text-center space-y-6">
                  <div className="w-24 h-24 bg-zinc-900 rounded-full flex items-center justify-center border border-zinc-800 relative">
                    <LayoutGrid className="w-10 h-10 text-zinc-800" />
                    <div className="absolute inset-0 border-2 border-indigo-500/20 rounded-full animate-ping" />
                  </div>
                  <div className="max-w-xs">
                    <p className="text-lg font-bold text-zinc-400 mb-2">Vault Synchronizing</p>
                    <p className="text-sm text-zinc-600 leading-relaxed">{isElectron ? 'Press Ctrl+Shift+S anywhere to capture a screenshot.' : 'Click Snip to start capturing.'}</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="max-w-3xl mx-auto h-full flex flex-col">
              <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-2xl"><MessageSquare className="w-6 h-6 text-indigo-500" /></div>
                <div>
                  <h2 className="text-2xl font-bold">Ask the Vault</h2>
                  <p className="text-xs text-zinc-500">Plain-English questions across your {vault.length} captured snip{vault.length === 1 ? '' : 's'}.</p>
                </div>
              </div>

              <div ref={chatScrollRef} className="flex-1 overflow-y-auto space-y-4 pr-2 mb-4 scrollbar-hide">
                {chatHistory.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center text-center py-16 space-y-4">
                    <Sparkles className="w-10 h-10 text-indigo-500/40" />
                    <p className="text-sm text-zinc-500 max-w-sm">Ask anything you've ever captured — by topic, fragment, or vague memory.</p>
                    <div className="flex flex-wrap gap-2 justify-center max-w-md">
                      {['What was that thing about…', 'Summarize my recent snips', 'Find anything mentioning a phone number'].map(q => (
                        <button key={q} onClick={() => setChatInput(q)} className="text-[11px] px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-full hover:border-indigo-500/40 text-zinc-400 hover:text-indigo-400 transition-colors">{q}</button>
                      ))}
                    </div>
                  </div>
                )}

                {chatHistory.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${msg.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-zinc-900 border border-zinc-800 text-zinc-200'}`}>
                      <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.text || (chatBusy && i === chatHistory.length - 1 ? '…' : '')}</p>
                      {msg.role === 'model' && msg.citedIds && msg.citedIds.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-zinc-800/80 flex flex-wrap gap-2">
                          {msg.citedIds.map((id, idx) => {
                            const item = vault.find(v => v.id === id);
                            if (!item) return null;
                            return (
                              <button key={id} onClick={() => setSelectedItem(item)} className="text-[10px] px-2 py-1 bg-indigo-500/10 border border-indigo-500/20 rounded-full text-indigo-400 hover:bg-indigo-500/20 transition-colors" title={item.title || item.summary}>
                                Snip {idx + 1}: {(item.title || item.category).slice(0, 30)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-zinc-800 pt-4">
                <div className="flex gap-2 items-end">
                  <textarea value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                    rows={1} placeholder={aiReady ? 'Ask a question about your vault…' : 'AI not configured — add your Gemini key in Models tab'}
                    disabled={!aiReady || chatBusy}
                    className="flex-1 resize-none bg-zinc-900 border border-zinc-800 rounded-xl py-3 px-4 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all max-h-32 disabled:opacity-50" />
                  <button onClick={sendChat} disabled={!aiReady || chatBusy || !chatInput.trim()}
                    className="p-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-xl text-white transition-colors">
                    <Send className="w-4 h-4" />
                  </button>
                </div>
                {chatHistory.length > 0 && (
                  <button onClick={() => { setChatHistory([]); db.setMeta('vault-chat-history', []).catch(() => {}); }} className="mt-2 text-[10px] text-zinc-600 hover:text-zinc-400 uppercase tracking-widest">
                    Clear conversation
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Floating Status Bar */}
      <div className="fixed bottom-6 right-6 z-[130]">
        <div className="bg-zinc-900 border border-zinc-800 rounded-full py-2 px-4 shadow-2xl flex items-center gap-4 backdrop-blur-xl bg-opacity-80 border-indigo-500/20">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-green-500'} animate-pulse`} />
            <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">{isPaused ? 'Agent Idle' : 'Agent Guarding'}</span>
          </div>
          <div className="h-6 w-[1px] bg-zinc-800" />
          <button onClick={() => setIsPaused(!isPaused)} className="p-1 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors">
            {isPaused ? <PlayCircle className="w-5 h-5" /> : <PauseCircle className="w-5 h-5" />}
          </button>
          <button className="p-1 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors"><Bell className="w-5 h-5" /></button>
          <button onClick={startCapture} className="p-2 bg-indigo-600 hover:bg-indigo-500 rounded-full text-white transition-all shadow-lg active:scale-90"><Camera className="w-5 h-5" /></button>
        </div>
      </div>

      {/* Marquee Capture Overlay (web fallback) */}
      {isCapturing && (
        <div className="fixed inset-0 z-[140] cursor-crosshair bg-black/40 backdrop-blur-[1px]"
          onMouseDown={(e) => { setIsSelecting(true); setSelection({ startX: e.clientX, startY: e.clientY, width: 0, height: 0 }); }}
          onMouseMove={(e) => { if (!isSelecting || !selection) return; setSelection({ ...selection, width: e.clientX - selection.startX, height: e.clientY - selection.startY }); }}
          onMouseUp={() => { setIsSelecting(false); captureRegion(); }}>
          <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-black/90 backdrop-blur-md border border-indigo-500/30 px-8 py-4 rounded-full text-sm font-bold text-white pointer-events-none flex items-center gap-4 shadow-2xl">
            <div className="w-2 h-2 bg-indigo-500 rounded-full animate-ping" />
            <span className="uppercase tracking-[0.2em] text-[10px]">Intelligence Gathering Active</span>
          </div>
          {selection && (
            <div className="absolute border-2 border-indigo-500 bg-indigo-500/5 shadow-[0_0_0_9999px_rgba(0,0,0,0.6)]"
              style={{
                left: selection.width < 0 ? selection.startX + selection.width : selection.startX,
                top: selection.height < 0 ? selection.startY + selection.height : selection.startY,
                width: Math.abs(selection.width), height: Math.abs(selection.height),
              }}>
              <div className="absolute top-0 right-0 translate-y-[-100%] bg-indigo-600 text-[10px] px-2 py-0.5 font-bold text-white uppercase tracking-widest">
                {Math.abs(Math.round(selection.width))} × {Math.abs(Math.round(selection.height))}
              </div>
              <div className="absolute -top-1 -left-1 w-4 h-4 border-t-4 border-l-4 border-indigo-500" />
              <div className="absolute -top-1 -right-1 w-4 h-4 border-t-4 border-r-4 border-indigo-500" />
              <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-4 border-l-4 border-indigo-500" />
              <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-4 border-r-4 border-indigo-500" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
