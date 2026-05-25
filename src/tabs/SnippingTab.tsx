import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Camera, X, Scissors, Copy, History, Search, Bell, PauseCircle, PlayCircle,
  MoreVertical, LayoutGrid, List, MessageSquare, Send, Sparkles, Eye
} from 'lucide-react';
import * as db from '../lib/db';
import {
  analyzeSnip, analyzeSnipWith, analyzeText, isGeminiReady, setGeminiKey, onGeminiReadyChange,
  embedText, cosineSimilarity, buildEmbedSource, chatWithVault,
  type ChatTurn, type VaultContextItem, type OcrProvider,
} from '../lib/ai';
import { getConfigured, onConfiguredChange, type ProviderId } from '../lib/providers';
import { getCachedModels, onModelsChange, type ModelSlot } from '../lib/models';

interface Region { startX: number; startY: number; width: number; height: number; }
interface Entity { type: 'link' | 'number' | 'address' | 'info'; value: string; label: string; }
interface ExtractedChunk {
  id: string; text: string; label: string; summary: string;
  entities: Entity[]; tags: string[]; timestamp: number;
  status: 'analyzing' | 'ready' | 'error'; error?: string;
}
export interface CapturedItem {
  id: string; image: string; timestamp: number; tags: string[]; title: string;
  summary: string; source: string; category: string; entities: Entity[];
  subImages: string[]; extractedText: string;
  status: 'analyzing' | 'ready' | 'error'; error?: string;
  embedding?: number[]; chunks?: ExtractedChunk[];
  /** Optional cross-link back to a DeepDive thread when the snippet was saved from there. */
  originThreadId?: string;
}

export default function SnippingTab() {
  const [view, setView] = useState<'vault' | 'chat'>('vault');
  const [chatHistory, setChatHistory] = useState<(ChatTurn & { citedIds?: string[] })[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [textSelection, setTextSelection] = useState('');
  const extractedTextRef = useRef<HTMLPreElement | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<CapturedItem | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [selection, setSelection] = useState<Region | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [vault, setVault] = useState<CapturedItem[]>([]);
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

  // OCR provider selection (persisted in IndexedDB meta store)
  const [ocrProvider, setOcrProvider] = useState<OcrProvider>('openai');
  const [configuredProviders, setConfiguredProviders] = useState<Set<ProviderId>>(getConfigured());
  const [configuredModels, setConfiguredModels] = useState<Record<ModelSlot, string>>(getCachedModels());
  useEffect(() => onConfiguredChange(setConfiguredProviders), []);
  useEffect(() => onModelsChange(setConfiguredModels), []);
  useEffect(() => {
    db.getMeta<OcrProvider>('snipping-ocr-provider')
      .then(saved => { if (saved === 'openai' || saved === 'gemini' || saved === 'anthropic' || saved === 'grok') setOcrProvider(saved); })
      .catch(() => {});
  }, []);
  const updateOcrProvider = (p: OcrProvider) => {
    setOcrProvider(p);
    db.setMeta('snipping-ocr-provider', p).catch(err => console.error('Failed to save OCR provider:', err));
  };
  const ocrReady = (() => {
    if (ocrProvider === 'gemini') return aiReady || configuredProviders.has('gemini');
    if (ocrProvider === 'openai') return configuredProviders.has('openai');
    return false;
  })();

  useEffect(() => {
    handleSnipImageRef.current = ({ dataUrl, targetId }) => {
      if (targetId) appendImageToItem(targetId, dataUrl);
      else processSnip(dataUrl);
    };
  });

  useEffect(() => {
    db.getAllSnippets<CapturedItem>()
      .then(items => {
        const normalized = items.map(i => ({ title: '', extractedText: '', status: 'ready' as const, ...i }));
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
    db.removeSnippet(id).catch(err => console.error('Failed to delete:', err));
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
    const providerLabel = ocrProvider === 'openai' ? 'OpenAI' : ocrProvider === 'gemini' ? 'Gemini' : ocrProvider;
    const placeholder: CapturedItem = {
      id, image: dataUrl, timestamp: Date.now(), tags: [],
      title: 'Analyzing…',
      summary: ocrReady ? `${providerLabel} is processing this capture…` : `OCR provider "${providerLabel}" not configured — open Models tab to add the key.`,
      source: '—', category: ocrReady ? 'Pending' : 'Unprocessed',
      entities: [], subImages: [dataUrl], extractedText: '',
      status: ocrReady ? 'analyzing' : 'error',
      error: ocrReady ? undefined : `${providerLabel} key not set`,
    };
    setVault(prev => [placeholder, ...prev]);
    db.putSnippet(placeholder).catch(err => console.error('Failed to persist snip:', err));
    setShowFlash(true);
    setTimeout(() => setShowFlash(false), 800);

    if (!ocrReady) return;

    analyzeSnipWith(ocrProvider, dataUrl)
      .then(analysis => {
        const updated: CapturedItem = {
          ...placeholder,
          title: analysis.title, summary: analysis.summary, source: analysis.source,
          category: analysis.category, tags: analysis.tags, entities: analysis.entities,
          extractedText: analysis.extractedText, status: 'ready', error: undefined,
        };
        setVault(prev => prev.map(i => (i.id === id ? updated : i)));
        db.putSnippet(updated).catch(err => console.error('Failed to persist analyzed snip:', err));

        embedText(buildEmbedSource(updated))
          .then(embedding => {
            const withEmbed = { ...updated, embedding };
            setVault(prev => prev.map(i => (i.id === id ? withEmbed : i)));
            db.putSnippet(withEmbed).catch(e => console.error('Failed to persist embedding:', e));
          })
          .catch(e => console.error('Embedding failed:', e));
      })
      .catch(err => {
        console.error('AI analysis failed:', err);
        const failed: CapturedItem = {
          ...placeholder, title: 'Analysis failed',
          summary: `${providerLabel} analysis failed: ${err?.message ?? String(err)}`,
          category: 'Unprocessed', status: 'error', error: err?.message ?? String(err),
        };
        setVault(prev => prev.map(i => (i.id === id ? failed : i)));
        db.putSnippet(failed).catch(e => console.error('Failed to persist error state:', e));
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
    db.putSnippet(updatedItem).catch(err => console.error('Failed to persist edit:', err));
    if (options.reembed && aiReady) {
      const target = updatedItem;
      embedText(buildEmbedSource(target))
        .then(embedding => {
          const withEmbed = { ...target, embedding };
          setVault(prev => prev.map(i => (i.id === id ? withEmbed : i)));
          setSelectedItem(prev => (prev && prev.id === id ? withEmbed : prev));
          db.putSnippet(withEmbed).catch(e => console.error('Failed to persist re-embed:', e));
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

  const appendImageToItem = (id: string, dataUrl: string) => {
    const item = vault.find(i => i.id === id);
    if (!item) return;
    updateItem(id, { subImages: [...item.subImages, dataUrl] });
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

  useEffect(() => { setTagDraft(''); setTextSelection(''); }, [selectedItem?.id]);

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
            className="fixed inset-0 z-[150] bg-black/90 backdrop-blur-xl flex items-center justify-center p-8 overflow-y-auto"
            onClick={() => setSelectedItem(null)}>
            <div className="max-w-6xl w-full grid grid-cols-1 lg:grid-cols-3 gap-8 bg-zinc-900/50 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setSelectedItem(null)} className="absolute top-6 right-6 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors z-10"><X className="w-5 h-5" /></button>

              <div className="lg:col-span-2 p-8 flex flex-col">
                <div className="flex items-center gap-3 mb-6">
                  <div className="px-3 py-1 bg-indigo-600/20 border border-indigo-500/30 rounded-lg text-indigo-400 font-bold text-[10px] uppercase tracking-widest">Original Capture</div>
                  <span className="text-zinc-500 text-xs font-mono">{selectedItem.id}</span>
                  {selectedItem.originThreadId && (
                    <span className="text-[10px] text-indigo-400/80 font-mono">from thread {selectedItem.originThreadId.slice(0, 8)}</span>
                  )}
                </div>
                <div className="flex-1 min-h-[400px] bg-zinc-800 rounded-2xl overflow-hidden border border-zinc-700 shadow-inner flex items-center justify-center">
                  <img src={selectedItem.image} alt="High resolution capture" className="max-w-full max-h-full object-contain" />
                </div>

                <div className="mt-8 grid grid-cols-4 gap-4">
                  {selectedItem.subImages.slice(1).map((img, i) => {
                    const realIndex = i + 1;
                    return (
                      <div key={realIndex} className="aspect-square bg-zinc-800 rounded-xl border border-zinc-700 overflow-hidden group relative">
                        <img src={img} alt="Extra capture" className="w-full h-full object-cover group-hover:scale-110 transition-transform" />
                        <button onClick={() => removeSubImage(selectedItem.id, realIndex)} className="absolute top-1 right-1 p-1 bg-black/60 hover:bg-red-500/80 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity" title="Remove this capture"><X className="w-3 h-3" /></button>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => {
                      if (!isElectron) { alert('Adding extra screenshots is only available in the desktop app.'); return; }
                      window.aios?.requestCaptureForItem(selectedItem.id);
                    }}
                    className="aspect-square bg-zinc-900 border border-dashed border-zinc-700 rounded-xl flex flex-col items-center justify-center text-zinc-500 hover:border-indigo-500/60 hover:text-indigo-400 transition-colors"
                    title="Add another screenshot to this snippet">
                    <LayoutGrid className="w-6 h-6 mb-1" />
                    <span className="text-[9px] uppercase tracking-widest font-bold">Add Shot</span>
                  </button>
                </div>
              </div>

              <div className="bg-zinc-950 p-8 border-l border-zinc-800 flex flex-col">
                <div className="space-y-8 flex-1">
                  <header>
                    <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Title</p>
                    <h2 className="text-xl font-bold text-zinc-100 leading-tight mb-3">{selectedItem.title || selectedItem.summary}</h2>
                    <p className="text-sm text-zinc-400 leading-relaxed">{selectedItem.summary}</p>
                    {selectedItem.status === 'analyzing' && <p className="mt-3 text-[10px] text-indigo-400 uppercase tracking-widest">Analyzing…</p>}
                    {selectedItem.status === 'error' && <p className="mt-3 text-[10px] text-red-400 uppercase tracking-widest">Error: {selectedItem.error}</p>}
                  </header>

                  {selectedItem.extractedText && (
                    <section>
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Extracted Text</p>
                      <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl max-h-48 overflow-y-auto">
                        <pre ref={extractedTextRef} className="text-xs text-zinc-300 whitespace-pre-wrap font-mono select-text" onMouseUp={() => {
                          const sel = window.getSelection();
                          const node = extractedTextRef.current;
                          if (!sel || !node || sel.isCollapsed) { setTextSelection(''); return; }
                          const text = sel.toString();
                          if (text && node.contains(sel.anchorNode) && node.contains(sel.focusNode)) setTextSelection(text);
                          else setTextSelection('');
                        }}>{selectedItem.extractedText}</pre>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <button onClick={() => copyToClipboard(selectedItem.extractedText)} className="text-[10px] text-indigo-400 hover:text-indigo-300 uppercase tracking-widest">Copy all text</button>
                        <button disabled={!textSelection.trim()} onClick={() => { const sel = textSelection; setTextSelection(''); window.getSelection()?.removeAllRanges(); extractChunkFromItem(selectedItem.id, sel); }}
                          className="text-[10px] px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-white uppercase tracking-widest font-bold transition-colors">
                          Extract Selection
                        </button>
                      </div>
                    </section>
                  )}

                  <section>
                    <div className="flex items-center justify-between mb-4">
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Extracted Entities</p>
                      <span className="text-[10px] bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded-full font-bold">SMART TAGS</span>
                    </div>
                    <div className="space-y-3">
                      {selectedItem.entities.map((ent, idx) => (
                        <div key={idx} className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl group hover:border-indigo-500/50 transition-all flex items-center justify-between">
                          <div className="space-y-1">
                            <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-tighter">{ent.label}</p>
                            <p className="text-sm font-mono text-indigo-300 truncate max-w-[180px]">{ent.value}</p>
                          </div>
                          <button onClick={() => copyToClipboard(ent.value)} className="p-2 hover:bg-indigo-600/20 rounded-lg text-zinc-500 hover:text-indigo-400 transition-colors"><Copy className="w-4 h-4" /></button>
                        </div>
                      ))}
                    </div>
                  </section>

                  {selectedItem.chunks && selectedItem.chunks.length > 0 && (
                    <section>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Saved Chunks</p>
                        <span className="text-[10px] text-zinc-600">{selectedItem.chunks.length}</span>
                      </div>
                      <div className="space-y-3">
                        {selectedItem.chunks.map(chunk => (
                          <div key={chunk.id} className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl group">
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <div className="space-y-1 min-w-0">
                                <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest truncate">
                                  {chunk.label}
                                  {chunk.status === 'analyzing' && <span className="ml-2 text-amber-400 animate-pulse">analyzing…</span>}
                                  {chunk.status === 'error' && <span className="ml-2 text-red-400">error</span>}
                                </p>
                                {chunk.summary && chunk.status !== 'analyzing' && <p className="text-[11px] text-zinc-400 leading-relaxed">{chunk.summary}</p>}
                              </div>
                              <div className="flex gap-1 shrink-0">
                                <button onClick={() => copyToClipboard(chunk.text)} className="p-1.5 hover:bg-indigo-600/20 rounded text-zinc-500 hover:text-indigo-400 transition-colors" title="Copy chunk text"><Copy className="w-3.5 h-3.5" /></button>
                                <button onClick={() => removeChunk(selectedItem.id, chunk.id)} className="p-1.5 hover:bg-red-500/20 rounded text-zinc-500 hover:text-red-400 transition-colors" title="Delete chunk"><X className="w-3.5 h-3.5" /></button>
                              </div>
                            </div>
                            <pre className="text-[11px] text-zinc-300 whitespace-pre-wrap font-mono bg-black/30 border border-zinc-800 rounded-lg p-2 max-h-24 overflow-y-auto">{chunk.text}</pre>
                            {chunk.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {chunk.tags.map(t => <span key={t} className="text-[9px] px-1.5 py-0.5 bg-indigo-500/10 border border-indigo-500/20 rounded-full text-indigo-300">{t}</span>)}
                              </div>
                            )}
                            {chunk.entities.length > 0 && (
                              <div className="mt-2 space-y-1">
                                {chunk.entities.map((ent, i) => (
                                  <div key={i} className="flex items-center justify-between gap-2 text-[10px]">
                                    <span className="text-zinc-500 uppercase tracking-tighter font-bold">{ent.label}</span>
                                    <button onClick={() => copyToClipboard(ent.value)} className="font-mono text-indigo-300 hover:text-indigo-200 truncate max-w-[140px] text-right" title="Copy">{ent.value}</button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  <section>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Tags</p>
                      <span className="text-[10px] text-zinc-600">{selectedItem.tags.length}</span>
                    </div>
                    <div className="flex flex-wrap gap-2 mb-3">
                      {selectedItem.tags.map(tag => (
                        <span key={tag} className="group flex items-center gap-1.5 text-[11px] px-2.5 py-1 bg-indigo-600/10 border border-indigo-500/20 rounded-full text-indigo-300">
                          {tag}
                          <button onClick={() => removeTagFromItem(selectedItem.id, tag)} className="text-indigo-400/60 hover:text-red-400 transition-colors" title="Remove tag"><X className="w-3 h-3" /></button>
                        </span>
                      ))}
                      {selectedItem.tags.length === 0 && <span className="text-[11px] text-zinc-600 italic">No tags yet</span>}
                    </div>
                    <input type="text" value={tagDraft} onChange={(e) => setTagDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTagToItem(selectedItem.id, tagDraft); setTagDraft(''); } }}
                      onBlur={() => { if (tagDraft.trim()) { addTagToItem(selectedItem.id, tagDraft); setTagDraft(''); } }}
                      placeholder="Add tag (Enter to confirm)"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all" />
                  </section>

                  <section>
                    <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4">Vault Classification</p>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl"><p className="text-zinc-500 mb-1">Category</p><p className="font-bold text-white">{selectedItem.category}</p></div>
                      <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl"><p className="text-zinc-500 mb-1">Source</p><p className="font-bold text-white">{selectedItem.source}</p></div>
                    </div>
                  </section>
                </div>

                <div className="mt-8 pt-8 border-t border-zinc-800">
                  <button onClick={(e) => deleteItem(selectedItem.id, e as any)} className="w-full py-4 bg-red-600/10 border border-red-500/20 rounded-xl text-red-500 text-sm font-bold uppercase tracking-widest hover:bg-red-600/20 transition-all">
                    Delete from Vault
                  </button>
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

          {/* OCR model selector — picks which provider analyzes each new snip */}
          <div className="flex items-center gap-1.5 bg-zinc-900/60 px-2 py-1 rounded-lg border border-zinc-800" title="Which AI model runs OCR on each new snip">
            <Eye className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">OCR</span>
            <select
              value={ocrProvider}
              onChange={(e) => updateOcrProvider(e.target.value as OcrProvider)}
              className="bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-[11px] font-mono text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
            >
              <option value="openai" disabled={!configuredProviders.has('openai')}>
                OpenAI · {configuredModels.openai || 'gpt-4o'}{!configuredProviders.has('openai') ? ' (no key)' : ''}
              </option>
              <option value="gemini" disabled={!configuredProviders.has('gemini')}>
                Gemini · gemini-2.5-flash{!configuredProviders.has('gemini') ? ' (no key)' : ''}
              </option>
              <option value="anthropic" disabled>
                Anthropic · {configuredModels.claude || 'claude-opus-4-7'} (soon)
              </option>
              <option value="grok" disabled>
                Grok · {configuredModels.grok || 'grok-4'} (soon)
              </option>
            </select>
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
                  <button className="p-1.5 bg-indigo-600/20 rounded text-indigo-400"><LayoutGrid className="w-4 h-4" /></button>
                  <button className="p-1.5 hover:bg-zinc-800 rounded text-zinc-500"><List className="w-4 h-4" /></button>
                </div>
              </div>

              {filteredVault.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
                  {filteredVault.map((item) => (
                    <motion.div key={item.id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                      onClick={() => setSelectedItem(item)}
                      className="group bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden hover:border-indigo-500/50 transition-all shadow-2xl flex flex-col cursor-pointer">
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
