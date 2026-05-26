import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  KanbanSquare, Sparkles, Plus, Trash2, X, Loader2, AlertCircle, Tag as TagIcon,
  Clock, Wand2, GripVertical, Bot, Play,
} from 'lucide-react';
import {
  loadBoard, saveBoard, newCard, planTasks, COLUMNS,
  type KanbanBoard, type KanbanCard, type ColumnId, type Priority,
} from '../lib/kanban';
import { type AgentDef } from '../lib/agents';
import AgentBuilder from '../components/AgentBuilder';

const PRIORITY_COLOR: Record<Priority, string> = {
  low:    'bg-zinc-700 text-zinc-300',
  medium: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  high:   'bg-red-500/20 text-red-300 border-red-500/30',
};

const SOURCE_BADGE: Record<'ai' | 'manual', string> = {
  ai:     'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  manual: 'bg-zinc-800 text-zinc-400 border-zinc-700',
};

export default function KanbanTab() {
  const [agents, setAgents] = useState<AgentDef[]>([]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center gap-4 bg-zinc-900/10 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-zinc-800 rounded-md"><KanbanSquare className="w-4 h-4 text-indigo-400" /></div>
          <h1 className="text-sm font-bold uppercase tracking-widest text-zinc-100">Orchestrator</h1>
        </div>
        <span className="text-[11px] text-zinc-500">Agent builder · task board</span>
      </header>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[38%] min-w-[380px] border-r border-zinc-800 relative">
          <AgentBuilder onAgentsChange={setAgents} />
        </div>
        <div className="flex-1 min-w-0 relative">
          <AgentBoard agents={agents} />
        </div>
      </div>
    </div>
  );
}

// ── Board ─────────────────────────────────────────────────────────────────────

function AgentBoard({ agents }: { agents: AgentDef[] }) {
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [planGoal, setPlanGoal] = useState('');
  const [planCount, setPlanCount] = useState(7);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [editing, setEditing] = useState<KanbanCard | null>(null);
  const [composer, setComposer] = useState<ColumnId | null>(null);
  const [composerText, setComposerText] = useState('');
  const draggedId = useRef<string | null>(null);

  useEffect(() => { loadBoard().then(setBoard); }, []);

  const persist = (next: KanbanBoard) => {
    setBoard(next);
    saveBoard(next).catch(e => console.error('kanban save failed', e));
  };

  const byColumn = useMemo(() => {
    const map: Record<ColumnId, KanbanCard[]> = { backlog: [], ready: [], running: [], review: [], done: [] };
    if (board) for (const c of board.cards) map[c.column].push(c);
    for (const col of COLUMNS) map[col.id].sort((a, b) => a.position - b.position);
    return map;
  }, [board]);

  const agentById = useMemo(() => {
    const m = new Map<string, AgentDef>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const addCard = (column: ColumnId, title: string) => {
    if (!board || !title.trim()) return;
    persist({ ...board, cards: [...board.cards, newCard({ title: title.trim(), column })] });
  };

  const updateCard = (id: string, patch: Partial<KanbanCard>) => {
    if (!board) return;
    persist({
      ...board,
      cards: board.cards.map(c => c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c),
    });
  };

  const deleteCard = (id: string) => {
    if (!board) return;
    persist({ ...board, cards: board.cards.filter(c => c.id !== id) });
  };

  const moveCard = (id: string, target: ColumnId, beforeId?: string) => {
    if (!board) return;
    const card = board.cards.find(c => c.id === id);
    if (!card) return;
    const others = board.cards.filter(c => c.id !== id);
    const targetCol = others.filter(c => c.column === target).sort((a, b) => a.position - b.position);
    let newPos: number;
    if (!beforeId) newPos = (targetCol[targetCol.length - 1]?.position ?? Date.now()) + 1000;
    else {
      const idx = targetCol.findIndex(c => c.id === beforeId);
      if (idx <= 0) newPos = (targetCol[0]?.position ?? Date.now()) - 1000;
      else newPos = (targetCol[idx - 1].position + targetCol[idx].position) / 2;
    }
    persist({
      ...board,
      cards: [...others, { ...card, column: target, position: newPos, updatedAt: Date.now() }],
    });
  };

  const runPlanner = async () => {
    if (!planGoal.trim() || !board) return;
    setPlanBusy(true); setPlanError(null);
    try {
      const { tasks } = await planTasks({ goal: planGoal, desiredCount: planCount });
      if (!tasks.length) throw new Error('Planner returned no tasks.');
      let pos = Date.now();
      const cards = tasks.map(t => newCard({
        title: t.title, description: t.description || '', tag: t.tag, estimate: t.estimate,
        source: 'ai', column: 'backlog', parentGoal: planGoal.trim(), position: pos++,
      }));
      persist({ ...board, cards: [...board.cards, ...cards] });
      setPlanGoal('');
      setPlanOpen(false);
    } catch (e: any) {
      setPlanError(e?.message ?? String(e));
    } finally {
      setPlanBusy(false);
    }
  };

  if (!board) {
    return <div className="h-full flex items-center justify-center text-zinc-500 text-sm">Loading board…</div>;
  }

  const totals = board.cards.length;
  const doneCount = byColumn.done.length;
  const unassignedCount = board.cards.filter(c => !c.assignedAgentId).length;

  return (
    <div className="h-full flex flex-col">
      <header className="h-10 px-3 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <KanbanSquare className="w-3.5 h-3.5 text-indigo-400" />
        <span className="text-[11px] uppercase tracking-widest text-zinc-300">Board</span>
        <span className="text-[10px] text-zinc-500">
          {totals} card{totals === 1 ? '' : 's'} · {unassignedCount} unassigned · {doneCount} done
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => setPlanOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold uppercase tracking-wider transition-colors"
          >
            <Wand2 className="w-3 h-3" />
            Plan with AI
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        <div className="h-full flex gap-2 px-3 py-3 min-w-max">
          {COLUMNS.map(col => (
            <Column
              key={col.id}
              column={col}
              cards={byColumn[col.id]}
              agents={agents}
              agentById={agentById}
              isComposing={composer === col.id}
              composerText={composerText}
              onStartCompose={() => { setComposer(col.id); setComposerText(''); }}
              onCancelCompose={() => { setComposer(null); setComposerText(''); }}
              onSubmitCompose={() => { addCard(col.id, composerText); setComposer(null); setComposerText(''); }}
              onComposerTextChange={setComposerText}
              onCardClick={setEditing}
              onAssign={(cardId, agentId) => {
                updateCard(cardId, {
                  assignedAgentId: agentId || undefined,
                  column: agentId && (byColumn.backlog.find(c => c.id === cardId)) ? 'ready' : undefined as any,
                });
              }}
              onDragStart={(id) => { draggedId.current = id; }}
              onDropOnColumn={(target, beforeId) => {
                const id = draggedId.current; draggedId.current = null;
                if (id) moveCard(id, target, beforeId);
              }}
            />
          ))}
        </div>
      </div>

      <AnimatePresence>
        {planOpen && (
          <PlanModal
            goal={planGoal} setGoal={setPlanGoal}
            count={planCount} setCount={setPlanCount}
            busy={planBusy} error={planError}
            onCancel={() => { setPlanOpen(false); setPlanError(null); }}
            onRun={runPlanner}
          />
        )}
        {editing && (
          <CardModal
            card={editing}
            agents={agents}
            onClose={() => setEditing(null)}
            onSave={patch => { updateCard(editing.id, patch); setEditing({ ...editing, ...patch }); }}
            onDelete={() => { deleteCard(editing.id); setEditing(null); }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function Column({
  column, cards, agents, agentById, isComposing, composerText,
  onStartCompose, onCancelCompose, onSubmitCompose, onComposerTextChange,
  onCardClick, onAssign, onDragStart, onDropOnColumn,
}: {
  column: { id: ColumnId; label: string; hint: string };
  cards: KanbanCard[];
  agents: AgentDef[];
  agentById: Map<string, AgentDef>;
  isComposing: boolean;
  composerText: string;
  onStartCompose: () => void;
  onCancelCompose: () => void;
  onSubmitCompose: () => void;
  onComposerTextChange: (s: string) => void;
  onCardClick: (c: KanbanCard) => void;
  onAssign: (cardId: string, agentId: string) => void;
  onDragStart: (id: string) => void;
  onDropOnColumn: (target: ColumnId, beforeId?: string) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => { e.preventDefault(); setHover(false); onDropOnColumn(column.id); }}
      className={`w-64 shrink-0 flex flex-col rounded-lg border ${hover ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-zinc-800 bg-zinc-900/30'} transition-colors`}
    >
      <header className="px-2.5 py-1.5 flex items-center gap-2 border-b border-zinc-800/60" title={column.hint}>
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-300">{column.label}</span>
        <span className="text-[9px] text-zinc-500 px-1 py-0.5 rounded bg-zinc-800">{cards.length}</span>
        <button
          onClick={onStartCompose}
          title="Add card"
          className="ml-auto p-0.5 rounded text-zinc-500 hover:text-white hover:bg-zinc-800"
        >
          <Plus className="w-3 h-3" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1.5">
        {cards.map(card => (
          <CardItem
            key={card.id}
            card={card}
            agents={agents}
            agent={card.assignedAgentId ? agentById.get(card.assignedAgentId) : undefined}
            onClick={() => onCardClick(card)}
            onAssign={(agentId) => onAssign(card.id, agentId)}
            onDragStart={() => onDragStart(card.id)}
            onDropBefore={() => onDropOnColumn(column.id, card.id)}
          />
        ))}
        {isComposing && (
          <div className="rounded-md border border-indigo-500/50 bg-zinc-950 p-2">
            <textarea
              autoFocus
              value={composerText}
              onChange={e => onComposerTextChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmitCompose(); }
                else if (e.key === 'Escape') { e.preventDefault(); onCancelCompose(); }
              }}
              placeholder="Card title…"
              rows={2}
              className="w-full bg-transparent text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none resize-none"
            />
            <div className="flex justify-end gap-1 mt-1">
              <button onClick={onCancelCompose} className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-white">Cancel</button>
              <button onClick={onSubmitCompose} className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded bg-indigo-600 hover:bg-indigo-500 text-white">Add</button>
            </div>
          </div>
        )}
        {!isComposing && cards.length === 0 && (
          <button
            onClick={onStartCompose}
            className="w-full py-4 text-[10px] text-zinc-600 hover:text-zinc-300 hover:bg-zinc-900/40 rounded transition-colors"
          >
            + Add a card
          </button>
        )}
      </div>
    </div>
  );
}

function CardItem({
  card, agents, agent, onClick, onAssign, onDragStart, onDropBefore,
}: {
  card: KanbanCard;
  agents: AgentDef[];
  agent?: AgentDef;
  onClick: () => void;
  onAssign: (agentId: string) => void;
  onDragStart: () => void;
  onDropBefore: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropBefore(); }}
      onClick={onClick}
      className="group rounded-md bg-zinc-900 hover:bg-zinc-900/80 border border-zinc-800 hover:border-zinc-700 p-2 cursor-pointer transition-colors"
    >
      <div className="flex items-start gap-1">
        <GripVertical className="w-3 h-3 text-zinc-600 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-zinc-100 leading-snug">{card.title}</div>

          {/* Agent assignment row */}
          <div className="flex items-center gap-1 mt-1.5" onClick={e => e.stopPropagation()}>
            <Bot className="w-3 h-3 text-zinc-600 shrink-0" />
            <select
              value={card.assignedAgentId ?? ''}
              onChange={(e) => onAssign(e.target.value)}
              className="flex-1 min-w-0 bg-transparent border border-zinc-800 hover:border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-300 focus:outline-none focus:border-indigo-500/60"
              title={agent?.description || 'Assign an agent'}
            >
              <option value="">(unassigned)</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name || a.slug}</option>
              ))}
            </select>
            <button
              disabled
              title="Run agent on this card — coming in Phase 1C"
              className="p-0.5 rounded text-zinc-700 cursor-not-allowed"
            >
              <Play className="w-3 h-3" />
            </button>
          </div>

          {(card.tag || card.estimate || card.priority) && (
            <div className="flex flex-wrap items-center gap-1 mt-1.5">
              {card.tag && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider bg-zinc-800 text-zinc-400">
                  <TagIcon className="w-2 h-2" />{card.tag}
                </span>
              )}
              {card.estimate && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-zinc-800 text-zinc-400">
                  <Clock className="w-2 h-2" />{card.estimate}
                </span>
              )}
              {card.priority && (
                <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border ${PRIORITY_COLOR[card.priority]}`}>
                  {card.priority}
                </span>
              )}
              <span className={`ml-auto px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border ${SOURCE_BADGE[card.source]}`}>
                {card.source === 'ai' ? 'AI' : 'Manual'}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanModal({
  goal, setGoal, count, setCount, busy, error, onCancel, onRun,
}: {
  goal: string; setGoal: (s: string) => void;
  count: number; setCount: (n: number) => void;
  busy: boolean; error: string | null;
  onCancel: () => void; onRun: () => void;
}) {
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
          className="my-auto w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden"
        >
          <header className="h-14 px-5 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/30">
            <Sparkles className="w-4 h-4 text-indigo-400" />
            <h3 className="text-sm font-semibold">Plan with AI</h3>
          </header>
          <div className="px-5 py-4 space-y-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Goal</label>
              <textarea
                autoFocus value={goal} onChange={e => setGoal(e.target.value)} disabled={busy} rows={5}
                placeholder='e.g. "Add Stripe checkout to the pricing page and persist subscription tier"'
                className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 resize-none"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-[10px] uppercase tracking-wider text-zinc-500">Target count</label>
              <input
                type="number" min={2} max={20} value={count}
                onChange={e => setCount(parseInt(e.target.value || '7', 10))} disabled={busy}
                className="w-16 bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1 text-[12px] text-zinc-100 tabular-nums focus:outline-none focus:border-indigo-500/60"
              />
              <span className="text-[11px] text-zinc-500">cards (soft hint)</span>
            </div>
            <p className="text-[11px] text-zinc-500">
              Generated cards land in <span className="text-zinc-300">Backlog</span>. Assign agents to move them to <span className="text-zinc-300">Ready</span>.
            </p>
            {error && (
              <div className="flex items-start gap-2 p-2.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-300 text-[12px]">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
          <footer className="px-5 py-3 border-t border-zinc-800 bg-zinc-900/30 flex justify-end gap-2">
            <button onClick={onCancel} disabled={busy} className="px-3 py-1.5 rounded-md text-[12px] text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-50">Cancel</button>
            <button
              onClick={onRun} disabled={busy || !goal.trim()}
              className="px-3 py-1.5 rounded-md text-[12px] font-bold uppercase tracking-wider bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white inline-flex items-center gap-1.5"
            >
              {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Planning…</> : <><Wand2 className="w-3.5 h-3.5" /> Generate cards</>}
            </button>
          </footer>
        </motion.div>
      </div>
    </motion.div>
  );
}

function CardModal({
  card, agents, onClose, onSave, onDelete,
}: {
  card: KanbanCard;
  agents: AgentDef[];
  onClose: () => void;
  onSave: (patch: Partial<KanbanCard>) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [tag, setTag] = useState(card.tag ?? '');
  const [estimate, setEstimate] = useState(card.estimate ?? '');
  const [priority, setPriority] = useState<Priority | ''>(card.priority ?? '');
  const [assignedAgentId, setAssignedAgentId] = useState(card.assignedAgentId ?? '');

  const dirty =
    title !== card.title ||
    description !== card.description ||
    (tag || '') !== (card.tag || '') ||
    (estimate || '') !== (card.estimate || '') ||
    (priority || '') !== (card.priority || '') ||
    (assignedAgentId || '') !== (card.assignedAgentId || '');

  const apply = () => onSave({
    title: title.trim() || card.title,
    description: description.trim(),
    tag: tag.trim() || undefined,
    estimate: estimate.trim() || undefined,
    priority: priority || undefined,
    assignedAgentId: assignedAgentId || undefined,
  });

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xl overflow-y-auto"
    >
      <div className="min-h-full flex items-start justify-center p-8">
        <motion.div
          initial={{ scale: 0.97, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 12 }}
          onClick={e => e.stopPropagation()}
          className="my-auto w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden"
        >
          <header className="h-14 px-5 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/30">
            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${SOURCE_BADGE[card.source]}`}>
              {card.source === 'ai' ? 'AI' : 'Manual'}
            </span>
            <span className="text-[11px] text-zinc-500">{COLUMNS.find(c => c.id === card.column)?.label}</span>
            <button onClick={onDelete} title="Delete" className="ml-auto p-1 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10">
              <Trash2 className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800">
              <X className="w-4 h-4" />
            </button>
          </header>

          <div className="px-5 py-4 space-y-3">
            <input
              value={title} onChange={e => setTitle(e.target.value)}
              className="w-full bg-transparent text-base font-semibold text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
            />
            <textarea
              value={description} onChange={e => setDescription(e.target.value)} rows={5}
              placeholder="Description…"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 resize-none"
            />

            <div>
              <div className="text-[9px] uppercase tracking-wider text-zinc-500 mb-1">Assigned agent</div>
              <select
                value={assignedAgentId}
                onChange={e => setAssignedAgentId(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-100 focus:outline-none focus:border-indigo-500/60"
              >
                <option value="">(unassigned)</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name || a.slug}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Field label="Tag">
                <input
                  value={tag} onChange={e => setTag(e.target.value)} placeholder="e.g. ui"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60"
                />
              </Field>
              <Field label="Estimate">
                <input
                  value={estimate} onChange={e => setEstimate(e.target.value)} placeholder="30 min"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60"
                />
              </Field>
              <Field label="Priority">
                <select
                  value={priority} onChange={e => setPriority(e.target.value as Priority | '')}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-indigo-500/60"
                >
                  <option value="">—</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </Field>
            </div>
            {card.parentGoal && (
              <div className="text-[11px] text-zinc-500">
                <span className="uppercase tracking-wider text-[9px]">From goal: </span>
                <span className="text-zinc-400">{card.parentGoal}</span>
              </div>
            )}
          </div>

          <footer className="px-5 py-3 border-t border-zinc-800 bg-zinc-900/30 flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-md text-[12px] text-zinc-400 hover:text-white hover:bg-zinc-800">Close</button>
            <button
              onClick={() => { apply(); onClose(); }} disabled={!dirty}
              className="px-3 py-1.5 rounded-md text-[12px] font-bold uppercase tracking-wider bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white"
            >
              Save
            </button>
          </footer>
        </motion.div>
      </div>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
      {children}
    </div>
  );
}
