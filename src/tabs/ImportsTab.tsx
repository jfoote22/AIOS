import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload, Download, Trash2, X, FileJson, MessageSquare, AlertCircle, CheckCircle2,
  Bot, User as UserIcon, Search,
} from 'lucide-react';
import {
  importFromFile, listImports, deleteImport,
  type ImportedConversation, type ImportProvider, type ImportResult,
} from '../lib/imports';

type FilterId = 'all' | ImportProvider;

const PROVIDER_LABEL: Record<ImportProvider, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
};

const PROVIDER_ACCENT: Record<ImportProvider, string> = {
  claude: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  chatgpt: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
};

export default function ImportsTab() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<ImportedConversation[]>([]);
  const [filter, setFilter] = useState<FilterId>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);
  const [open, setOpen] = useState<ImportedConversation | null>(null);

  useEffect(() => { refresh(); }, []);

  const refresh = async () => {
    try { setItems(await listImports()); }
    catch (e: any) { setError(e?.message ?? String(e)); }
  };

  const onPick = () => fileRef.current?.click();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(null); setLastResult(null);
    try {
      const result = await importFromFile(file);
      setLastResult(result);
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm('Delete this imported conversation?')) return;
    await deleteImport(id);
    if (open?.id === id) setOpen(null);
    await refresh();
  };

  const counts = useMemo(() => {
    const c = { all: items.length, claude: 0, chatgpt: 0 };
    for (const i of items) c[i.provider]++;
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(i => {
      if (filter !== 'all' && i.provider !== filter) return false;
      if (!q) return true;
      if (i.title.toLowerCase().includes(q)) return true;
      return i.messages.some(m => m.content.toLowerCase().includes(q));
    });
  }, [items, filter, query]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="h-14 border-b border-zinc-800 px-6 flex items-center gap-3 bg-zinc-900/10 backdrop-blur-md shrink-0">
        <div className="p-1.5 bg-zinc-800 rounded-md"><Download className="w-4 h-4 text-indigo-400" /></div>
        <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-100">Imports</h2>
        <span className="text-[11px] text-zinc-500">
          Bring in Claude and ChatGPT conversation exports
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onPick}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-[11px] font-bold uppercase tracking-wider transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            {busy ? 'Importing…' : 'Import JSON'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={e => onFile(e.target.files?.[0])}
          />
        </div>
      </header>

      <div className="px-6 py-4 border-b border-zinc-800/60 bg-zinc-900/20 text-[12px] text-zinc-400 space-y-2">
        <p>
          Export your data from{' '}
          <span className="text-zinc-200 font-semibold">claude.ai → Settings → Privacy → Export data</span>
          {' '}or{' '}
          <span className="text-zinc-200 font-semibold">chatgpt.com → Settings → Data Controls → Export</span>.
          Both providers email a ZIP. Extract it and select <code className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-200">conversations.json</code> here.
        </p>
        <p className="text-[11px] text-zinc-500">
          Grok has no export today — when xAI ships one, it will plug in here too.
        </p>
      </div>

      {(error || lastResult) && (
        <div className="px-6 pt-3">
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-300 text-[12px]">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-auto text-red-300/70 hover:text-red-200">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {lastResult && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[12px]">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                {PROVIDER_LABEL[lastResult.provider]}: added{' '}
                <strong className="text-emerald-200">{lastResult.added}</strong> new,{' '}
                skipped <strong className="text-emerald-200">{lastResult.skipped}</strong> duplicates{' '}
                out of <strong className="text-emerald-200">{lastResult.total}</strong> conversations.
              </span>
              <button onClick={() => setLastResult(null)} className="ml-auto text-emerald-300/70 hover:text-emerald-200">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      <div className="px-6 py-3 border-b border-zinc-800/60 flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-1 bg-zinc-900/60 p-1 rounded-md border border-zinc-800">
          {(['all', 'claude', 'chatgpt'] as FilterId[]).map(f => {
            const label = f === 'all' ? 'All' : PROVIDER_LABEL[f];
            const count = counts[f];
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-bold uppercase tracking-wider transition-colors ${
                  active ? 'bg-indigo-600/20 text-indigo-300' : 'text-zinc-500 hover:text-white'
                }`}
              >
                {label}
                <span className={`px-1.5 py-0.5 rounded ${active ? 'bg-indigo-500/30' : 'bg-zinc-800'} text-[10px]`}>{count}</span>
              </button>
            );
          })}
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search titles and message text…"
            className="w-full pl-8 pr-3 py-1.5 rounded-md bg-zinc-900/60 border border-zinc-800 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {visible.length === 0 ? (
          <EmptyState hasItems={items.length > 0} />
        ) : (
          <ul className="space-y-1.5">
            {visible.map(c => (
              <li
                key={c.id}
                onClick={() => setOpen(c)}
                className="group flex items-start gap-3 px-3 py-2.5 rounded-md bg-zinc-900/40 hover:bg-zinc-900/70 border border-zinc-800/60 hover:border-zinc-700 cursor-pointer transition-colors"
              >
                <span className={`shrink-0 mt-0.5 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${PROVIDER_ACCENT[c.provider]}`}>
                  {PROVIDER_LABEL[c.provider]}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-zinc-100 truncate">{c.title}</div>
                  <div className="text-[11px] text-zinc-500 flex items-center gap-3 mt-0.5">
                    <span className="flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" />
                      {c.messages.length}
                    </span>
                    <span>{formatDate(c.updatedAt)}</span>
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
                  title="Delete"
                  className="opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AnimatePresence>
        {open && (
          <ConversationViewer
            conversation={open}
            onClose={() => setOpen(null)}
            onDelete={() => onDelete(open.id)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function EmptyState({ hasItems }: { hasItems: boolean }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-16">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-indigo-500/20 animate-ping" />
        <div className="relative p-4 rounded-full bg-zinc-900 border border-zinc-800">
          <FileJson className="w-7 h-7 text-indigo-400" />
        </div>
      </div>
      <p className="mt-5 text-sm text-zinc-300">
        {hasItems ? 'Nothing matches your filter.' : 'No imports yet.'}
      </p>
      <p className="mt-1 text-[12px] text-zinc-500 max-w-sm">
        {hasItems ? 'Try clearing the search or switching providers.' : 'Drop in a conversations.json from Claude or ChatGPT to get started.'}
      </p>
    </div>
  );
}

function ConversationViewer({
  conversation, onClose, onDelete,
}: {
  conversation: ImportedConversation;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xl overflow-y-auto"
    >
      <div className="min-h-full flex items-start justify-center p-8">
        <motion.div
          initial={{ scale: 0.97, y: 12 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.97, y: 12 }}
          onClick={e => e.stopPropagation()}
          className="my-auto w-full max-w-3xl bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden"
        >
          <header className="h-14 px-5 flex items-center gap-3 border-b border-zinc-800 bg-zinc-900/30">
            <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${PROVIDER_ACCENT[conversation.provider]}`}>
              {PROVIDER_LABEL[conversation.provider]}
            </span>
            <h3 className="text-sm font-semibold text-zinc-100 truncate flex-1">{conversation.title}</h3>
            <span className="text-[11px] text-zinc-500">{formatDate(conversation.updatedAt)}</span>
            <button
              onClick={onDelete}
              title="Delete"
              className="p-1.5 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              title="Close"
              className="p-1.5 rounded text-zinc-500 hover:text-white hover:bg-zinc-800"
            >
              <X className="w-4 h-4" />
            </button>
          </header>

          <div className="max-h-[70vh] overflow-y-auto px-5 py-4 space-y-3">
            {conversation.messages.map((m, idx) => (
              <div key={idx} className="flex gap-3">
                <div className={`shrink-0 mt-0.5 w-7 h-7 rounded-md flex items-center justify-center border ${
                  m.role === 'user'
                    ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300'
                    : 'bg-zinc-800/60 border-zinc-700 text-zinc-300'
                }`}>
                  {m.role === 'user' ? <UserIcon className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                    {m.role}
                    {m.ts ? <span className="ml-2 text-zinc-600 normal-case tracking-normal">{formatDate(m.ts)}</span> : null}
                  </div>
                  <div className="text-[13px] text-zinc-200 whitespace-pre-wrap break-words">{m.content}</div>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

function formatDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
