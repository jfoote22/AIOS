import { motion } from 'motion/react';
import { Wand2, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import type { TriageProposal } from '../lib/runs';
import type { KanbanCard } from '../lib/kanban';
import type { AgentDef } from '../lib/agents';

export default function TriageModal({
  proposals, cards, agents, busy, error, onCancel, onApply, onRetry,
}: {
  proposals: TriageProposal[];
  cards: KanbanCard[];
  agents: AgentDef[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onApply: (overrides: Record<string, string | null>) => void;
  onRetry: () => void;
}) {
  const cardById = new Map(cards.map(c => [c.id, c]));
  const agentById = new Map(agents.map(a => [a.id, a]));

  const assigned = proposals.filter(p => p.agentId).length;
  const skipped = proposals.length - assigned;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={busy ? undefined : onCancel}
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xl overflow-y-auto"
    >
      <div className="min-h-full flex items-start justify-center p-8">
        <motion.div
          initial={{ scale: 0.97, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 12 }}
          onClick={e => e.stopPropagation()}
          className="my-auto w-full max-w-2xl bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden"
        >
          <header className="h-14 px-5 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/30">
            <Wand2 className="w-4 h-4 text-indigo-400" />
            <h3 className="text-sm font-semibold">Manager proposed assignments</h3>
            <span className="text-[11px] text-zinc-500">
              {assigned} assigned · {skipped} skipped
            </span>
            <button onClick={onCancel} disabled={busy} className="ml-auto p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800">
              <X className="w-4 h-4" />
            </button>
          </header>

          <div className="px-5 py-3 max-h-[60vh] overflow-y-auto">
            {proposals.length === 0 ? (
              <div className="py-10 text-center text-[12px] text-zinc-500">No proposals returned.</div>
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {proposals.map(p => {
                  const card = cardById.get(p.cardId);
                  if (!card) return null;
                  const agent = p.agentId ? agentById.get(p.agentId) : null;
                  return (
                    <li key={p.cardId} className="py-2.5 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-zinc-100 truncate">{card.title}</div>
                        {p.rationale && <div className="text-[11px] text-zinc-500 mt-0.5">{p.rationale}</div>}
                      </div>
                      <select
                        value={p.agentId ?? ''}
                        onChange={(e) => { p.agentId = e.target.value || null; }}
                        className="shrink-0 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-indigo-500/60"
                        title={agent?.description}
                      >
                        <option value="">(skip)</option>
                        {agents.map(a => (
                          <option key={a.id} value={a.id}>{a.name || a.slug}</option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ul>
            )}
            {error && (
              <div className="mt-3 flex items-start gap-2 p-2.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-300 text-[12px]">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span className="flex-1">{error}</span>
              </div>
            )}
          </div>

          <footer className="px-5 py-3 border-t border-zinc-800 bg-zinc-900/30 flex items-center justify-between">
            <button onClick={onRetry} disabled={busy} className="text-[11px] text-zinc-500 hover:text-white uppercase tracking-wider">Re-run triage</button>
            <div className="flex gap-2">
              <button onClick={onCancel} disabled={busy} className="px-3 py-1.5 rounded-md text-[12px] text-zinc-400 hover:text-white hover:bg-zinc-800">Cancel</button>
              <button
                onClick={() => {
                  const overrides: Record<string, string | null> = {};
                  for (const p of proposals) overrides[p.cardId] = p.agentId;
                  onApply(overrides);
                }}
                disabled={busy || assigned === 0}
                className="px-3 py-1.5 rounded-md text-[12px] font-bold uppercase tracking-wider bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white inline-flex items-center gap-1.5"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                Apply & move to Ready
              </button>
            </div>
          </footer>
        </motion.div>
      </div>
    </motion.div>
  );
}
