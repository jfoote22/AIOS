import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CreditCard, Plus, X, Pencil, Trash2, Calendar, DollarSign, Tag, RefreshCw, AlertTriangle } from 'lucide-react';
import * as db from '../lib/db';

interface Subscription {
  id: string;
  name: string;
  category: string;
  cost: number;
  currency: string;
  cycle: 'monthly' | 'yearly';
  nextRenewal?: string; // YYYY-MM-DD
  notes?: string;
  createdAt: number;
}

const STORAGE_KEY = 'subscriptions:list';

function emptyDraft(): Subscription {
  return {
    id: '',
    name: '',
    category: 'AI',
    cost: 0,
    currency: 'USD',
    cycle: 'monthly',
    nextRenewal: '',
    notes: '',
    createdAt: Date.now(),
  };
}

function fmtCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function monthlyEquivalent(sub: Subscription): number {
  if (!sub.cost || !isFinite(sub.cost)) return 0;
  return sub.cycle === 'yearly' ? sub.cost / 12 : sub.cost;
}

function daysUntil(iso?: string): number | null {
  if (!iso) return null;
  const target = new Date(iso + 'T00:00:00');
  if (isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function renewalLabel(iso?: string): { text: string; tone: 'normal' | 'soon' | 'overdue' | 'none' } {
  const d = daysUntil(iso);
  if (d === null) return { text: 'No renewal set', tone: 'none' };
  if (d < 0) return { text: `Overdue by ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'}`, tone: 'overdue' };
  if (d === 0) return { text: 'Renews today', tone: 'soon' };
  if (d === 1) return { text: 'Renews tomorrow', tone: 'soon' };
  if (d <= 7) return { text: `Renews in ${d} days`, tone: 'soon' };
  return { text: `Renews in ${d} days`, tone: 'normal' };
}

export default function SubscriptionsTab() {
  const [items, setItems] = useState<Subscription[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Subscription | null>(null);

  useEffect(() => {
    db.getMeta<Subscription[]>(STORAGE_KEY)
      .then(saved => { setItems(Array.isArray(saved) ? saved : []); })
      .catch(err => console.error('Failed to load subscriptions:', err))
      .finally(() => setLoaded(true));
  }, []);

  const persist = (next: Subscription[]) => {
    setItems(next);
    db.setMeta(STORAGE_KEY, next).catch(err => console.error('Failed to save subscriptions:', err));
  };

  const upsert = (sub: Subscription) => {
    const exists = items.some(i => i.id === sub.id);
    persist(exists ? items.map(i => (i.id === sub.id ? sub : i)) : [...items, sub]);
    setEditing(null);
  };

  const remove = (id: string) => {
    const sub = items.find(i => i.id === id);
    if (!sub) return;
    if (!confirm(`Remove "${sub.name}" from your subscriptions?`)) return;
    persist(items.filter(i => i.id !== id));
  };

  const startAdd = () => setEditing({ ...emptyDraft(), id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  const startEdit = (sub: Subscription) => setEditing({ ...sub });

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const da = daysUntil(a.nextRenewal);
      const db_ = daysUntil(b.nextRenewal);
      if (da === null && db_ === null) return a.name.localeCompare(b.name);
      if (da === null) return 1;
      if (db_ === null) return -1;
      return da - db_;
    });
  }, [items]);

  const totals = useMemo(() => {
    const byCurrency: Record<string, number> = {};
    for (const sub of items) {
      const monthly = monthlyEquivalent(sub);
      if (!monthly) continue;
      byCurrency[sub.currency] = (byCurrency[sub.currency] || 0) + monthly;
    }
    return byCurrency;
  }, [items]);

  const categories = useMemo(() => Array.from(new Set(items.map(i => i.category).filter(Boolean))), [items]);

  return (
    <div className="flex-1 overflow-y-auto p-8 scrollbar-hide">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-2xl"><CreditCard className="w-6 h-6 text-indigo-500" /></div>
            <div>
              <h2 className="text-3xl font-bold">Subscriptions</h2>
              <p className="text-xs text-zinc-500">Track what you pay for monthly — AI services, tools, anything with a renewal date.</p>
            </div>
          </div>
          <button
            onClick={startAdd}
            className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold uppercase tracking-wider rounded-lg transition-all active:scale-95 shadow-lg shadow-indigo-600/10"
          >
            <Plus className="w-3.5 h-3.5" />Add subscription
          </button>
        </div>

        {/* Totals strip */}
        {Object.keys(totals).length > 0 && (
          <div className="mb-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-2xl">
              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Monthly total</p>
              <div className="space-y-1">
                {Object.entries(totals).map(([cur, total]) => (
                  <p key={cur} className="text-xl font-bold text-zinc-100 font-mono">{fmtCurrency(total, cur)}</p>
                ))}
              </div>
            </div>
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-2xl">
              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Annual run-rate</p>
              <div className="space-y-1">
                {Object.entries(totals).map(([cur, total]) => (
                  <p key={cur} className="text-xl font-bold text-zinc-100 font-mono">{fmtCurrency(total * 12, cur)}</p>
                ))}
              </div>
            </div>
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-2xl">
              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Active subscriptions</p>
              <p className="text-xl font-bold text-zinc-100 font-mono">{items.length}</p>
            </div>
          </div>
        )}

        {/* List */}
        {loaded && sorted.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center space-y-4">
            <div className="w-20 h-20 bg-zinc-900 rounded-full flex items-center justify-center border border-zinc-800 relative">
              <CreditCard className="w-8 h-8 text-zinc-800" />
              <div className="absolute inset-0 border-2 border-indigo-500/20 rounded-full animate-ping" />
            </div>
            <div className="max-w-sm">
              <p className="text-sm font-bold text-zinc-400 mb-1">No subscriptions tracked yet</p>
              <p className="text-xs text-zinc-600 leading-relaxed">Add your AI services (Claude Pro, ChatGPT Plus, Cursor, etc.) along with anything else you pay for monthly. AIOS keeps the data local — nothing leaves this machine.</p>
            </div>
            <button onClick={startAdd} className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-[11px] font-bold uppercase tracking-wider rounded-lg transition-colors">
              <Plus className="w-3.5 h-3.5" />Add your first
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {sorted.map(sub => {
              const r = renewalLabel(sub.nextRenewal);
              const monthly = monthlyEquivalent(sub);
              return (
                <div key={sub.id} className="group p-4 bg-zinc-900 border border-zinc-800 rounded-2xl hover:border-indigo-500/40 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                        <h3 className="text-sm font-bold text-zinc-100 truncate">{sub.name || 'Untitled'}</h3>
                        {sub.category && (
                          <span className="text-[9px] px-1.5 py-0.5 bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 rounded-full font-bold uppercase tracking-widest flex items-center gap-1">
                            <Tag className="w-2.5 h-2.5" />{sub.category}
                          </span>
                        )}
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-widest flex items-center gap-1 ${
                          r.tone === 'overdue' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                          r.tone === 'soon'    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                          r.tone === 'none'    ? 'bg-zinc-800 text-zinc-500 border border-zinc-700' :
                                                 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                        }`}>
                          {r.tone === 'overdue' ? <AlertTriangle className="w-2.5 h-2.5" /> : <Calendar className="w-2.5 h-2.5" />}
                          {r.text}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
                        <span className="flex items-center gap-1 font-mono">
                          <DollarSign className="w-3 h-3 text-zinc-500" />
                          {fmtCurrency(sub.cost, sub.currency)}
                          <span className="text-zinc-600">/ {sub.cycle === 'yearly' ? 'yr' : 'mo'}</span>
                        </span>
                        {sub.cycle === 'yearly' && monthly > 0 && (
                          <span className="text-zinc-600 font-mono">≈ {fmtCurrency(monthly, sub.currency)}/mo</span>
                        )}
                        {sub.nextRenewal && (
                          <span className="flex items-center gap-1 text-zinc-500">
                            <RefreshCw className="w-3 h-3" />{sub.nextRenewal}
                          </span>
                        )}
                      </div>
                      {sub.notes && <p className="mt-2 text-[11px] text-zinc-500 leading-relaxed line-clamp-2">{sub.notes}</p>}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => startEdit(sub)}
                        className="p-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-indigo-500/30 rounded-lg text-zinc-500 hover:text-indigo-400 transition-colors"
                        title="Edit"
                      ><Pencil className="w-3.5 h-3.5" /></button>
                      <button
                        onClick={() => remove(sub.id)}
                        className="p-2 bg-zinc-900 hover:bg-red-600/20 border border-zinc-800 hover:border-red-500/40 rounded-lg text-zinc-500 hover:text-red-400 transition-colors"
                        title="Remove"
                      ><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="mt-8 text-[10px] text-zinc-600 leading-relaxed">
          Subscription data is stored locally in this app's IndexedDB. Nothing is uploaded. Later phases can layer in usage tracking from provider billing APIs, but for now this is a manual ledger.
        </p>
      </div>

      <SubscriptionEditor
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={upsert}
        existingCategories={categories}
      />
    </div>
  );
}

interface EditorProps {
  editing: Subscription | null;
  onClose: () => void;
  onSave: (sub: Subscription) => void;
  existingCategories: string[];
}

function SubscriptionEditor({ editing, onClose, onSave, existingCategories }: EditorProps) {
  const [draft, setDraft] = useState<Subscription | null>(null);

  useEffect(() => { setDraft(editing ? { ...editing } : null); }, [editing]);

  if (!draft) return null;

  const isNew = !editing?.name && !editing?.cost;
  const update = (patch: Partial<Subscription>) => setDraft(d => (d ? { ...d, ...patch } : d));

  const canSave = !!draft.name.trim();

  const submit = () => {
    if (!canSave || !draft) return;
    onSave({
      ...draft,
      name: draft.name.trim(),
      category: draft.category.trim() || 'Other',
      cost: Number(draft.cost) || 0,
      currency: (draft.currency || 'USD').toUpperCase(),
      nextRenewal: draft.nextRenewal?.trim() || undefined,
      notes: draft.notes?.trim() || undefined,
    });
  };

  return (
    <AnimatePresence>
      {draft && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[150] bg-black/90 backdrop-blur-xl overflow-y-auto"
          onClick={onClose}
        >
          <div className="min-h-full flex items-start justify-center p-8">
            <div className="max-w-lg w-full my-auto bg-zinc-900/50 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
              <button onClick={onClose} className="absolute top-6 right-6 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors z-10"><X className="w-5 h-5" /></button>

              <div className="p-8 space-y-5">
                <header>
                  <div className="px-3 py-1 inline-block bg-indigo-600/20 border border-indigo-500/30 rounded-lg text-indigo-400 font-bold text-[10px] uppercase tracking-widest mb-3">
                    {isNew ? 'New subscription' : 'Edit subscription'}
                  </div>
                  <h2 className="text-xl font-bold text-zinc-100 leading-tight">Track a recurring charge</h2>
                </header>

                <div className="space-y-4">
                  <div>
                    <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Name *</p>
                    <input
                      type="text" autoFocus value={draft.name}
                      onChange={(e) => update({ name: e.target.value })}
                      placeholder="Claude Pro, ChatGPT Plus, Cursor…"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Cost</p>
                      <input
                        type="number" min={0} step="0.01" value={draft.cost}
                        onChange={(e) => update({ cost: parseFloat(e.target.value) || 0 })}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                      />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Currency</p>
                      <input
                        type="text" maxLength={3} value={draft.currency}
                        onChange={(e) => update({ currency: e.target.value.toUpperCase() })}
                        placeholder="USD"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm font-mono uppercase focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Billing cycle</p>
                      <div className="grid grid-cols-2 gap-1 p-1 bg-zinc-900 border border-zinc-800 rounded-lg">
                        {(['monthly', 'yearly'] as const).map(c => (
                          <button
                            key={c}
                            onClick={() => update({ cycle: c })}
                            className={`px-2 py-1.5 rounded text-[11px] font-bold uppercase tracking-wider transition-colors ${
                              draft.cycle === c ? 'bg-indigo-600/20 text-indigo-300' : 'text-zinc-500 hover:text-white'
                            }`}
                          >{c}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Next renewal</p>
                      <input
                        type="date" value={draft.nextRenewal || ''}
                        onChange={(e) => update({ nextRenewal: e.target.value })}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                      />
                    </div>
                  </div>

                  <div>
                    <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Category</p>
                    <input
                      type="text" list="subscription-categories" value={draft.category}
                      onChange={(e) => update({ category: e.target.value })}
                      placeholder="AI, Productivity, Music…"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                    />
                    <datalist id="subscription-categories">
                      {['AI', 'Productivity', 'Development', 'Music', 'Video', 'Cloud', 'Other', ...existingCategories].map(c => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </div>

                  <div>
                    <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Notes</p>
                    <textarea
                      value={draft.notes || ''}
                      onChange={(e) => update({ notes: e.target.value })}
                      placeholder="Plan tier, account email, anything worth remembering…"
                      rows={2}
                      className="w-full resize-none bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                  <button onClick={onClose} className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-zinc-400 hover:text-white transition-colors">Cancel</button>
                  <button
                    onClick={submit} disabled={!canSave}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-[11px] font-bold rounded-lg uppercase tracking-wider transition-all active:scale-95 shadow-lg shadow-indigo-600/10"
                  >Save</button>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
