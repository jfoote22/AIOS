import { useRef, useState } from 'react';
import { X, Copy, Plus, GripVertical } from 'lucide-react';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { analyzeText, embedText, buildEmbedSource } from '../lib/ai';

// ── Shared snippet data model ────────────────────────────────────────────────
// Lives here (not in a tab) so both SnippingTab and SecondBrainTab consume the
// same shapes via the shared <SnippetEditor>.

export interface Entity { type: 'link' | 'number' | 'address' | 'info'; value: string; label: string; }

export interface ExtractedChunk {
  id: string; text: string; label: string; summary: string;
  entities: Entity[]; tags: string[]; timestamp: number;
  status: 'analyzing' | 'ready' | 'error'; error?: string;
}

/** An extra screenshot added to a snippet via "Add Shot". Each carries its own
 *  OCR'd text; its tags/entities are merged up into the parent snippet. */
export interface AddedShot {
  id: string; image: string; extractedText: string;
  status: 'analyzing' | 'ready' | 'error'; error?: string;
}

export interface CapturedItem {
  id: string; image: string; timestamp: number; tags: string[]; title: string;
  summary: string; source: string; category: string; entities: Entity[];
  subImages: string[]; extractedText: string;
  status: 'analyzing' | 'ready' | 'error'; error?: string;
  embedding?: number[]; chunks?: ExtractedChunk[]; addedShots?: AddedShot[];
  /** Optional cross-link back to a DeepDive thread when the snippet was saved from there. */
  originThreadId?: string;
}

// Shared pointer sensor: a small drag threshold so clicks on the remove/copy
// buttons still register as clicks, not drags.
function useDragSensors() {
  return useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
}

// --- Sortable tag chips (drag any chip into any slot; the rest trickle over) ---
function SortableTagChip({ id, onRemove }: { id: string; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  return (
    <span ref={setNodeRef} style={style} {...attributes} {...listeners}
      className={`group flex items-center gap-1 text-[11px] pl-1.5 pr-2 py-1 bg-indigo-600/10 border border-indigo-500/20 rounded-full text-indigo-300 cursor-grab active:cursor-grabbing select-none ${isDragging ? 'ring-1 ring-indigo-400/60' : ''}`}
      title="Drag to reorder">
      <GripVertical className="w-3 h-3 text-indigo-400/40 group-hover:text-indigo-400/80" />
      {id}
      <button onPointerDown={(e) => e.stopPropagation()} onClick={onRemove} className="text-indigo-400/60 hover:text-red-400 transition-colors" title="Remove tag"><X className="w-3 h-3" /></button>
    </span>
  );
}

export function SortableTags({ tags, onAdd, onRemove, onReorder }: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  onReorder: (from: number, to: number) => void;
}) {
  const [draft, setDraft] = useState('');
  const sensors = useDragSensors();
  const commit = () => { const t = draft.trim(); if (t) { onAdd(t); setDraft(''); } };
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) {
      onReorder(tags.indexOf(String(active.id)), tags.indexOf(String(over.id)));
    }
  };
  return (
    <div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={tags} strategy={rectSortingStrategy}>
          <div className="flex flex-wrap gap-2 mb-3">
            {tags.map(tag => <SortableTagChip key={tag} id={tag} onRemove={() => onRemove(tag)} />)}
            {tags.length === 0 && <span className="text-[11px] text-zinc-600 italic">No tags yet</span>}
          </div>
        </SortableContext>
      </DndContext>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }}
        onBlur={commit}
        placeholder="Add tag (Enter to confirm)"
        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
      />
    </div>
  );
}

// --- Sortable entity "value" blocks — drag any block into any slot in the grid ---
function SortableEntityCard({ id, ent, onEdit, onRemove, onCopy }: {
  id: string; ent: Entity;
  onEdit: (patch: Partial<Entity>) => void;
  onRemove: () => void;
  onCopy: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 10 : undefined };
  return (
    <div ref={setNodeRef} style={style}
      className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl group hover:border-indigo-500/50 transition-colors flex items-center gap-2">
      <button {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-zinc-600 hover:text-indigo-400 transition-colors shrink-0 touch-none" title="Drag to reorder"><GripVertical className="w-4 h-4" /></button>
      <div className="space-y-1 min-w-0 flex-1">
        <input type="text" value={ent.label} onChange={(e) => onEdit({ label: e.target.value })} placeholder="LABEL"
          className="w-full bg-transparent text-[9px] font-bold text-zinc-500 uppercase tracking-tighter focus:outline-none focus:text-indigo-400" />
        <input type="text" value={ent.value} onChange={(e) => onEdit({ value: e.target.value })} placeholder="value"
          className="w-full bg-transparent text-sm font-mono text-indigo-300 focus:outline-none focus:text-indigo-200" />
      </div>
      <button onClick={onCopy} className="p-2 hover:bg-indigo-600/20 rounded-lg text-zinc-500 hover:text-indigo-400 transition-colors shrink-0" title="Copy value"><Copy className="w-4 h-4" /></button>
      <button onClick={onRemove} className="p-2 hover:bg-red-500/20 rounded-lg text-zinc-500 hover:text-red-400 transition-colors shrink-0" title="Remove entity"><X className="w-4 h-4" /></button>
    </div>
  );
}

export function SortableEntities({ entities, onReorder, onEdit, onRemove, onCopy, columns = 2 }: {
  entities: Entity[];
  onReorder: (from: number, to: number) => void;
  onEdit: (index: number, patch: Partial<Entity>) => void;
  onRemove: (index: number) => void;
  onCopy: (value: string) => void;
  columns?: 1 | 2;
}) {
  const sensors = useDragSensors();
  // Positional ids — stable for the duration of a single drag (the list only
  // changes on drop), which is all dnd-kit needs.
  const ids = entities.map((_, i) => `ent-${i}`);
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) {
      onReorder(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    }
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div className={`grid grid-cols-1 ${columns === 2 ? 'sm:grid-cols-2' : ''} gap-3`}>
          {entities.map((ent, idx) => (
            <SortableEntityCard key={ids[idx]} id={ids[idx]} ent={ent}
              onEdit={(patch) => onEdit(idx, patch)} onRemove={() => onRemove(idx)} onCopy={() => onCopy(ent.value)} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

const copyToClipboard = (text: string) => { navigator.clipboard.writeText(text); };

// ── Editable snippet body ────────────────────────────────────────────────────
// Controlled component: every edit calls `onChange(nextItem)` and the parent is
// responsible for persisting (db.putSnippet) + mirroring + emitting the change.
// Re-embedding and chunk analysis are async side-effects owned here; they call
// `onChange` again once the result arrives, merging onto the latest item.

export default function SnippetEditor({
  item, onChange, onDelete, aiReady, categories, isElectron, compact = false,
}: {
  item: CapturedItem;
  onChange: (next: CapturedItem) => void;
  onDelete: () => void;
  aiReady: boolean;
  categories: string[];
  isElectron: boolean;
  compact?: boolean;
}) {
  // Latest item, so async callbacks (embed/analyze) merge onto fresh data.
  const itemRef = useRef(item);
  itemRef.current = item;
  const extractedTextRef = useRef<HTMLPreElement | null>(null);
  const [textSelection, setTextSelection] = useState('');

  const patch = (partial: Partial<CapturedItem>, options: { reembed?: boolean } = {}) => {
    const next = { ...itemRef.current, ...partial };
    onChange(next);
    if (options.reembed && aiReady) {
      embedText(buildEmbedSource(next))
        .then(embedding => onChange({ ...itemRef.current, embedding }))
        .catch(e => console.error('Re-embed failed:', e));
    }
  };

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag || itemRef.current.tags.includes(tag)) return;
    patch({ tags: [...itemRef.current.tags, tag] }, { reembed: true });
  };
  const removeTag = (tag: string) => patch({ tags: itemRef.current.tags.filter(t => t !== tag) }, { reembed: true });
  const reorderTags = (from: number, to: number) => {
    const next = [...itemRef.current.tags];
    if (from < 0 || from >= next.length || to < 0 || to >= next.length) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    patch({ tags: next }); // order-only → no re-embed
  };

  const updateEntity = (index: number, p: Partial<Entity>) =>
    patch({ entities: itemRef.current.entities.map((e, i) => (i === index ? { ...e, ...p } : e)) }, { reembed: true });
  const removeEntity = (index: number) =>
    patch({ entities: itemRef.current.entities.filter((_, i) => i !== index) }, { reembed: true });
  const addEntity = () =>
    patch({ entities: [...itemRef.current.entities, { type: 'info', label: 'NEW', value: '' } as Entity] });
  const reorderEntities = (from: number, to: number) => {
    const next = [...itemRef.current.entities];
    if (from < 0 || from >= next.length || to < 0 || to >= next.length) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    patch({ entities: next }); // entities aren't part of the embed source → no re-embed
  };

  const removeSubImage = (index: number) =>
    patch({ subImages: itemRef.current.subImages.filter((_, i) => i !== index) });

  const removeAddedShot = (shotId: string) =>
    patch({ addedShots: (itemRef.current.addedShots ?? []).filter(s => s.id !== shotId) }, { reembed: true });

  const requestAddShot = () => {
    if (!isElectron) { alert('Adding extra screenshots is only available in the desktop app.'); return; }
    window.aios?.requestCaptureForItem(item.id);
  };

  const removeChunk = (chunkId: string) =>
    patch({ chunks: (itemRef.current.chunks ?? []).filter(c => c.id !== chunkId) }, { reembed: true });

  const extractChunk = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const chunkId = Math.random().toString(36).slice(2, 11);
    const placeholder: ExtractedChunk = {
      id: chunkId, text: trimmed,
      label: aiReady ? 'Analyzing…' : 'Saved chunk',
      summary: aiReady ? 'AI is analyzing this fragment…' : 'AI not configured.',
      entities: [], tags: [], timestamp: Date.now(),
      status: aiReady ? 'analyzing' : 'ready',
    };
    patch({ chunks: [...(itemRef.current.chunks ?? []), placeholder] });
    if (!aiReady) return;
    try {
      const analysis = await analyzeText(trimmed);
      const ready: ExtractedChunk = {
        ...placeholder, label: analysis.label, summary: analysis.summary,
        entities: analysis.entities, tags: analysis.tags, status: 'ready',
      };
      const baseChunks = itemRef.current.chunks ?? [];
      const nextChunks = baseChunks.map(c => (c.id === chunkId ? ready : c));
      const newTags = Array.from(new Set([...itemRef.current.tags, ...analysis.tags.map(t => t.toLowerCase())]));
      patch({ chunks: nextChunks, tags: newTags }, { reembed: true });
    } catch (err: any) {
      console.error('Chunk analysis failed:', err);
      const baseChunks = itemRef.current.chunks ?? [];
      const failed: ExtractedChunk = { ...placeholder, status: 'error', error: err?.message ?? String(err), label: 'Saved chunk', summary: trimmed.slice(0, 200) };
      patch({ chunks: baseChunks.map(c => (c.id === chunkId ? failed : c)) });
    }
  };

  return (
    <div className="space-y-8">
      <header>
        <input
          type="text"
          value={item.title}
          onChange={(e) => patch({ title: e.target.value }, { reembed: true })}
          placeholder="Untitled capture"
          className={`w-full bg-transparent font-bold text-zinc-100 leading-tight mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-500 rounded px-1 -mx-1 ${compact ? 'text-base' : 'text-xl'}`}
        />
        <textarea
          value={item.summary}
          onChange={(e) => patch({ summary: e.target.value }, { reembed: true })}
          rows={2}
          placeholder="No summary"
          className="w-full resize-none bg-transparent text-sm text-zinc-400 leading-relaxed focus:outline-none focus:ring-1 focus:ring-indigo-500 rounded px-1 -mx-1"
        />
        {item.status === 'analyzing' && <p className="mt-3 text-[10px] text-indigo-400 uppercase tracking-widest">Analyzing…</p>}
        {item.status === 'error' && <p className="mt-3 text-[10px] text-red-400 uppercase tracking-widest">Error: {item.error}</p>}
      </header>

      {/* 1. Images, stacked top-to-bottom (main first, then each added shot) */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Images</p>
          <button
            onClick={requestAddShot}
            className="text-[9px] px-2 py-1 bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/30 rounded-md text-indigo-300 font-bold uppercase tracking-widest inline-flex items-center gap-1 transition-colors"
            title="Capture another screenshot into this snippet">
            <Plus className="w-3 h-3" />Add Shot
          </button>
        </div>
        <div className="space-y-3">
          {/* Main capture */}
          <div className="bg-zinc-800 rounded-2xl overflow-hidden border border-zinc-700 shadow-inner flex items-center justify-center max-h-[60vh]">
            <img src={item.image} alt="High resolution capture" className="max-w-full max-h-[60vh] object-contain" />
          </div>

          {/* Legacy extra captures (older snippets stored shots here, no text) */}
          {item.subImages.slice(1).map((img, i) => {
            const realIndex = i + 1;
            return (
              <div key={`sub-${realIndex}`} className="relative group bg-zinc-800 rounded-2xl overflow-hidden border border-zinc-700 shadow-inner flex items-center justify-center max-h-[60vh]">
                <img src={img} alt="Extra capture" className="max-w-full max-h-[60vh] object-contain" />
                <button onClick={() => removeSubImage(realIndex)} className="absolute top-2 right-2 p-1 bg-black/60 hover:bg-red-500/80 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity" title="Remove this capture"><X className="w-3.5 h-3.5" /></button>
              </div>
            );
          })}

          {/* Added shots (each OCR'd; text shown in the Extracted Text section) */}
          {(item.addedShots ?? []).map((shot) => (
            <div key={shot.id} className="relative group bg-zinc-800 rounded-2xl overflow-hidden border border-zinc-700 shadow-inner flex items-center justify-center max-h-[60vh]">
              <img src={shot.image} alt="Added capture" className="max-w-full max-h-[60vh] object-contain" />
              {shot.status === 'analyzing' && (
                <span className="absolute top-2 left-2 text-[9px] px-2 py-0.5 bg-black/70 rounded-full text-amber-400 uppercase tracking-widest animate-pulse">Analyzing…</span>
              )}
              {shot.status === 'error' && (
                <span className="absolute top-2 left-2 text-[9px] px-2 py-0.5 bg-black/70 rounded-full text-red-400 uppercase tracking-widest">OCR failed</span>
              )}
              <button onClick={() => removeAddedShot(shot.id)} className="absolute top-2 right-2 p-1 bg-black/60 hover:bg-red-500/80 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity" title="Remove this shot"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      </section>

      {/* 2. Extracted text — main capture first, then one block per added shot */}
      {(item.extractedText || (item.addedShots ?? []).some(s => s.extractedText || s.status !== 'ready')) && (
        <section>
          <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Extracted Text</p>
          {item.extractedText && (
            <>
              <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl max-h-64 overflow-y-auto">
                <pre ref={extractedTextRef} className="text-xs text-zinc-300 whitespace-pre-wrap font-mono select-text" onMouseUp={() => {
                  const sel = window.getSelection();
                  const node = extractedTextRef.current;
                  if (!sel || !node || sel.isCollapsed) { setTextSelection(''); return; }
                  const text = sel.toString();
                  if (text && node.contains(sel.anchorNode) && node.contains(sel.focusNode)) setTextSelection(text);
                  else setTextSelection('');
                }}>{item.extractedText}</pre>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <button onClick={() => copyToClipboard(item.extractedText)} className="text-[10px] text-indigo-400 hover:text-indigo-300 uppercase tracking-widest">Copy all text</button>
                <button disabled={!textSelection.trim()} onClick={() => { const sel = textSelection; setTextSelection(''); window.getSelection()?.removeAllRanges(); extractChunk(sel); }}
                  className="text-[10px] px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-white uppercase tracking-widest font-bold transition-colors">
                  Extract Selection
                </button>
              </div>
            </>
          )}

          {/* One section per added shot */}
          {(item.addedShots ?? []).map((shot, i) => (
            (shot.extractedText || shot.status !== 'ready') && (
              <div key={shot.id} className={item.extractedText || i > 0 ? 'mt-4' : ''}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[10px] font-bold text-indigo-400/80 uppercase tracking-widest">
                    Added shot {i + 1}
                    {shot.status === 'analyzing' && <span className="ml-2 text-amber-400 animate-pulse normal-case">analyzing…</span>}
                    {shot.status === 'error' && <span className="ml-2 text-red-400 normal-case">OCR failed</span>}
                  </p>
                  {shot.extractedText && (
                    <button onClick={() => copyToClipboard(shot.extractedText)} className="text-[10px] text-indigo-400 hover:text-indigo-300 uppercase tracking-widest">Copy</button>
                  )}
                </div>
                <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl max-h-64 overflow-y-auto">
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono select-text">{shot.extractedText || (shot.status === 'analyzing' ? 'Reading text from this shot…' : 'No text found in this shot.')}</pre>
                </div>
              </div>
            )
          ))}
        </section>
      )}

      {/* 3. Tags — drag chips to reorder */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Tags <span className="text-zinc-600 normal-case tracking-normal">· drag to reorder</span></p>
          <span className="text-[10px] text-zinc-600">{item.tags.length}</span>
        </div>
        <SortableTags
          key={item.id}
          tags={item.tags}
          onAdd={addTag}
          onRemove={removeTag}
          onReorder={reorderTags}
        />
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Extracted Entities</p>
          <button onClick={addEntity} className="text-[10px] px-2 py-1 bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/30 rounded-lg text-indigo-300 font-bold uppercase tracking-widest transition-colors">+ Add</button>
        </div>
        {item.entities.length > 0 ? (
          <SortableEntities
            entities={item.entities}
            columns={compact ? 1 : 2}
            onReorder={reorderEntities}
            onEdit={updateEntity}
            onRemove={removeEntity}
            onCopy={copyToClipboard}
          />
        ) : (
          <p className="text-[11px] text-zinc-600 italic">No entities yet — click "Add" to create one.</p>
        )}
      </section>

      {item.chunks && item.chunks.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Saved Chunks</p>
            <span className="text-[10px] text-zinc-600">{item.chunks.length}</span>
          </div>
          <div className="space-y-3">
            {item.chunks.map(chunk => (
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
                    <button onClick={() => removeChunk(chunk.id)} className="p-1.5 hover:bg-red-500/20 rounded text-zinc-500 hover:text-red-400 transition-colors" title="Delete chunk"><X className="w-3.5 h-3.5" /></button>
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
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Vault Classification</p>
        <div className={`grid gap-3 text-xs ${compact ? 'grid-cols-1' : 'grid-cols-2'}`}>
          <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl">
            <p className="text-zinc-500 mb-1">Category</p>
            <input
              type="text"
              list="category-suggestions"
              value={item.category}
              onChange={(e) => patch({ category: e.target.value }, { reembed: true })}
              className="w-full bg-transparent font-bold text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 rounded px-1 -mx-1"
            />
            <datalist id="category-suggestions">
              {categories.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-xl">
            <p className="text-zinc-500 mb-1">Source</p>
            <input
              type="text"
              value={item.source}
              onChange={(e) => patch({ source: e.target.value }, { reembed: true })}
              className="w-full bg-transparent font-bold text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 rounded px-1 -mx-1"
            />
          </div>
        </div>
      </section>

      <div className="pt-6 border-t border-zinc-800">
        <button onClick={onDelete} className="w-full py-4 bg-red-600/10 border border-red-500/20 rounded-xl text-red-500 text-sm font-bold uppercase tracking-widest hover:bg-red-600/20 transition-all">
          Delete from Vault
        </button>
      </div>
    </div>
  );
}
