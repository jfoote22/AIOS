import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  KanbanSquare, Sparkles, Plus, Trash2, X, Loader2, AlertCircle, Tag as TagIcon,
  Clock, Wand2, GripVertical, Bot, Play, CheckCircle2, Square as StopSquare,
  FolderOpen, Folder, Music, MousePointer2, Users, PlayCircle, Save, FolderInput,
} from 'lucide-react';
import {
  loadBoard, saveBoard, newCard, planTasks, assistPlanBrief, resolveWorkingDir, COLUMNS,
  type KanbanBoard, type KanbanCard, type ColumnId, type Priority,
} from '../lib/kanban';
import { REVIEW_WATCHER_AGENT_SLUG, type AgentDef } from '../lib/agents';
import { saveProject, loadProjectFromFolder, applyProject } from '../lib/project';
import {
  startRun, cancelRun, recordRun, parseRunStream, listRuns,
  type AgentRun,
} from '../lib/runs';
import {
  loadMaestroState, saveMaestroState, ensureMaestroAgent, tick as maestroTick,
  reviewCard, DEFAULT_MAESTRO, type MaestroState,
} from '../lib/maestro';
import AgentBuilder from '../components/AgentBuilder';
import AgentRunDrawer from '../components/AgentRunDrawer';
import MaestroControls from '../components/MaestroControls';

const PRIORITY_COLOR: Record<Priority, string> = {
  low:    'bg-zinc-700 text-zinc-300',
  medium: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  high:   'bg-red-500/20 text-red-300 border-red-500/30',
};

const SOURCE_BADGE: Record<'ai' | 'manual', string> = {
  ai:     'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  manual: 'bg-zinc-800 text-zinc-400 border-zinc-700',
};

const COLUMN_IDS = new Set<ColumnId>(COLUMNS.map(c => c.id));

function normalizeBoard(board: KanbanBoard): KanbanBoard {
  let changed = false;
  const cards = board.cards.map(card => {
    if (COLUMN_IDS.has(card.column)) return card;
    changed = true;
    return { ...card, column: 'backlog' as ColumnId, updatedAt: Date.now() };
  });
  return changed ? { ...board, cards } : board;
}

export default function KanbanTab() {
  const [agents, setAgents] = useState<AgentDef[]>([]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center gap-4 bg-zinc-900/10 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-zinc-800 rounded-md"><KanbanSquare className="w-4 h-4 text-indigo-400" /></div>
          <h1 className="text-sm font-bold uppercase tracking-widest text-zinc-100">Orchestra</h1>
        </div>
        <span className="text-[11px] text-zinc-500">Agent builder · task board · Maestro</span>
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
  const [planContext, setPlanContext] = useState('');
  const [planConstraints, setPlanConstraints] = useState('');
  const [planAcceptance, setPlanAcceptance] = useState('');
  const [planQuestions, setPlanQuestions] = useState('');
  const [planCount, setPlanCount] = useState(7);
  const [planBusy, setPlanBusy] = useState(false);
  const [planAssistBusy, setPlanAssistBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [editing, setEditing] = useState<KanbanCard | null>(null);
  const [composer, setComposer] = useState<ColumnId | null>(null);
  const [composerText, setComposerText] = useState('');
  const draggedId = useRef<string | null>(null);

  // Run state: one run per card-in-flight. The drawer renders the run for
  // whichever card is currently focused via openRunCardId.
  const [runs, setRuns] = useState<Map<string, AgentRun>>(new Map());     // cardId -> latest run
  const [openRunCardId, setOpenRunCardId] = useState<string | null>(null);
  const boardRef = useRef<KanbanBoard | null>(null);
  boardRef.current = board;

  // Project save/load
  const [clearPromptOpen, setClearPromptOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  };

  // Maestro state
  const [maestro, setMaestro] = useState<MaestroState>(DEFAULT_MAESTRO);
  const maestroRef = useRef<MaestroState>(maestro);
  maestroRef.current = maestro;
  const [selectedReviewIds, setSelectedReviewIds] = useState<Set<string>>(new Set());
  const [reviewBusy, setReviewBusy] = useState(false);
  const [maestroActivity, setMaestroActivity] = useState({ backlog: false, running: false, review: false });
  const [maestroBootstrapped, setMaestroBootstrapped] = useState(false);
  const reviewedRef = useRef<Set<string>>(new Set()); // run ids we've already auto-reviewed

  useEffect(() => {
    loadBoard().then(loaded => {
      const normalized = normalizeBoard(loaded);
      setBoard(normalized);
      if (normalized !== loaded) saveBoard(normalized).catch(e => console.error('kanban repair save failed', e));
    });
  }, []);
  useEffect(() => {
    hydrateLatestRuns().catch(e => console.warn('load runs failed', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { loadMaestroState().then(setMaestro); }, []);
  // Bootstrap Maestro agent record once agents have loaded
  useEffect(() => {
    if (maestroBootstrapped || !agents) return;
    ensureMaestroAgent(agents).catch(e => console.warn('ensureMaestroAgent', e)).finally(() => setMaestroBootstrapped(true));
  }, [agents, maestroBootstrapped]);

  const updateMaestro = (next: MaestroState) => {
    let resolved = next;
    if (next.reviewMode === 'reviewer-agent' && !next.reviewerAgentId) {
      const reviewer = agents.find(a => a.slug === REVIEW_WATCHER_AGENT_SLUG) || agents.find(a => a.role === 'reviewer');
      if (reviewer) resolved = { ...next, reviewerAgentId: reviewer.id };
    }
    setMaestro(resolved);
    saveMaestroState(resolved).catch(e => console.error('maestro save failed', e));
  };

  // Workers only: Maestro, Reviewer, and Watcher agents are hidden from card assignment.
  const workerAgents = useMemo(() => agents.filter(a => a.role !== 'maestro' && a.role !== 'reviewer' && a.role !== 'watcher'), [agents]);
  const agentsRef = useRef(agents); agentsRef.current = agents;
  const runsRef = useRef(runs); runsRef.current = runs;

  useEffect(() => {
    if (!maestro.enabled || maestro.reviewMode !== 'reviewer-agent' || maestro.reviewerAgentId) return;
    const reviewer = agents.find(a => a.slug === REVIEW_WATCHER_AGENT_SLUG) || agents.find(a => a.role === 'reviewer');
    if (reviewer) updateMaestro({ ...maestro, reviewerAgentId: reviewer.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, maestro.enabled, maestro.reviewMode, maestro.reviewerAgentId]);

  const persist = (next: KanbanBoard) => {
    boardRef.current = next;
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
    const current = boardRef.current;
    if (!current) return;
    persist({
      ...current,
      cards: current.cards.map(c => c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c),
    });
  };

  const deleteCard = (id: string) => {
    if (!board) return;
    persist({ ...board, cards: board.cards.filter(c => c.id !== id) });
  };

  const deleteDoneCards = () => {
    if (!board) return;
    persist({ ...board, cards: board.cards.filter(c => c.column !== 'done') });
  };

  // Save the active board (+ agents, Maestro, run summary) to its project
  // folder. Prompts for a folder if none is set yet. Returns whether it saved.
  const saveProjectNow = async (): Promise<boolean> => {
    let b = boardRef.current;
    if (!b) return false;
    if (!b.projectRoot?.trim()) {
      const picked = await window.aios?.pickFolder({ title: 'Pick a folder to save this project in' });
      if (!picked) return false;
      persist({ ...b, projectRoot: picked }); // updates boardRef synchronously
      b = boardRef.current;
    }
    setProjectBusy(true);
    try {
      const { path } = await saveProject(boardRef.current!);
      showNotice(`Saved project to ${path.replace(/\\/g, '/')}`);
      return true;
    } catch (e: any) {
      showNotice(`Save failed: ${e?.message ?? e}`);
      return false;
    } finally {
      setProjectBusy(false);
    }
  };

  // Load the saved project at `folder` and make it the active board. If there's
  // no project there, just adopt the folder as the project root.
  const loadProjectFrom = async (folder: string, opts?: { confirmReplace?: boolean }) => {
    setProjectBusy(true);
    try {
      const project = await loadProjectFromFolder(folder);
      if (!project) {
        const b = boardRef.current;
        if (b) persist({ ...b, projectRoot: folder });
        showNotice('No saved AIOS project in that folder — set it as the project root.');
        return;
      }
      if (opts?.confirmReplace && (boardRef.current?.cards.length ?? 0) > 0) {
        const ok = window.confirm(
          'Load this project? It replaces the current board. Unsaved changes to the current board will be lost.',
        );
        if (!ok) return;
      }
      const loaded = await applyProject(project, folder);
      boardRef.current = loaded;
      setBoard(loaded);
      setMaestro(await loadMaestroState());
      await hydrateLatestRuns().catch(() => {});
      showNotice(`Loaded project — ${loaded.cards.length} card${loaded.cards.length === 1 ? '' : 's'}.`);
    } catch (e: any) {
      showNotice(`Load failed: ${e?.message ?? e}`);
    } finally {
      setProjectBusy(false);
    }
  };

  const openProject = async () => {
    const picked = await window.aios?.pickFolder({
      title: 'Open an AIOS project folder',
      defaultPath: boardRef.current?.projectRoot,
    });
    if (picked) await loadProjectFrom(picked, { confirmReplace: true });
  };

  // Clear opens a prompt offering to save first; doClear does the wipe.
  const clearBoard = () => {
    if (!board || board.cards.length === 0) return;
    setClearPromptOpen(true);
  };

  const doClear = async (save: boolean) => {
    if (save) {
      const ok = await saveProjectNow();
      if (!ok) return; // save failed or was cancelled — keep the board intact
    }
    // Stop any in-flight runs before wiping the cards they belong to.
    await Promise.all(
      Array.from(runsRef.current.values())
        .filter(r => r.status === 'running')
        .map(r => cancelRun(r.id).catch(e => console.error('clear board: cancel run failed', e))),
    );
    const b = boardRef.current;
    if (b) persist({ ...b, cards: [] });
    setClearPromptOpen(false);
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

  // Update the runs map + persist
  const setRun = (cardId: string, next: AgentRun) => {
    setRuns(prev => { const m = new Map(prev); m.set(cardId, next); return m; });
    recordRun(next).catch(e => console.error('persist run failed', e));
  };

  const hydrateLatestRuns = async (): Promise<Map<string, AgentRun>> => {
    const allRuns = await listRuns();
    const latestByCard = new Map<string, AgentRun>();
    for (const run of allRuns) {
      const existing = latestByCard.get(run.cardId);
      if (!existing || run.startedAt > existing.startedAt) latestByCard.set(run.cardId, run);
    }
    runsRef.current = latestByCard;
    setRuns(latestByCard);
    return latestByCard;
  };

  const runAgentOnCard = async (card: KanbanCard) => {
    if (!card.assignedAgentId) return;
    const agent = agentById.get(card.assignedAgentId);
    const currentBoard = boardRef.current;
    if (!agent || !currentBoard) return;

    // Resolve effective working dir (card override → agent → board project root).
    // Refuse the run if nothing is set, rather than silently leaking files into
    // whatever folder AIOS was launched from.
    const effectiveCwd = resolveWorkingDir(card, agent, currentBoard);
    if (!effectiveCwd) {
      setRun(card.id, {
        id: `run-no-cwd-${Date.now()}`,
        cardId: card.id,
        agentId: agent.id,
        agentSlug: agent.slug,
        status: 'failed',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        transcript: '',
        error: 'No working directory. Set a project root in the Orchestra header (📁), give the agent a working dir, or add a card override.',
      });
      setOpenRunCardId(card.id);
      return;
    }

    // Move card to Running immediately so the board reflects intent
    if (card.column !== 'running') {
      updateCard(card.id, { column: 'running' });
    }

    setOpenRunCardId(card.id);

    let run: AgentRun;
    // Per-stream throttle: the transcript grows with every token, and each
    // setRun both re-renders the board and writes the full transcript to SQLite
    // over IPC. Coalesce live updates to ~7/sec; the terminal setRun below
    // always flushes the complete run. These are locals (not component state)
    // so concurrent swarm streams don't clobber each other's timer.
    let liveTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEmit = 0;
    const LIVE_THROTTLE_MS = 150;
    const clearLive = () => { if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; } };
    try {
      const result = await startRun({
        card: { id: card.id, title: card.title, description: card.description },
        agent: { ...agent, workingDir: effectiveCwd },
      });
      run = result.run;
      setRun(card.id, run);

      // Throttled live update: emit immediately if enough time has passed,
      // otherwise schedule a trailing emit so the last token is never dropped.
      const emitLive = () => {
        const sinceLast = Date.now() - lastEmit;
        if (sinceLast >= LIVE_THROTTLE_MS) {
          lastEmit = Date.now();
          setRun(card.id, run);
        } else if (!liveTimer) {
          liveTimer = setTimeout(() => {
            liveTimer = null;
            lastEmit = Date.now();
            setRun(card.id, run);
          }, LIVE_THROTTLE_MS - sinceLast);
        }
      };

      let acc = '';
      let finalReason: string | undefined;
      let streamError: string | undefined;
      for await (const evt of parseRunStream(result.stream)) {
        if (evt.type === 'text') {
          acc += evt.value;
          run = { ...run, transcript: acc };
          emitLive();
        } else if (evt.type === 'finish') {
          finalReason = evt.reason;
        } else if (evt.type === 'error') {
          streamError = evt.value;
        }
      }

      clearLive(); // cancel any pending throttled write before the final flush
      const ok = !streamError && finalReason !== 'error';
      const canceled = finalReason === 'canceled';
      const final: AgentRun = {
        ...run,
        status: canceled ? 'canceled' : ok ? 'succeeded' : 'failed',
        finishedAt: Date.now(),
        error: streamError,
      };
      setRun(card.id, final);

      // Auto-progress: success → Review; canceled or failed → stay in Running
      // so the user can decide to retry, drag, or open the drawer.
      if (final.status === 'succeeded') updateCard(card.id, { column: 'review' });
    } catch (e: any) {
      clearLive();
      console.error('runAgentOnCard error', e);
      const errMsg = e?.message ?? String(e);
      setRun(card.id, {
        id: `run-err-${Date.now()}`,
        cardId: card.id,
        agentId: agent.id,
        agentSlug: agent.slug,
        status: 'failed',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        transcript: '',
        error: errMsg,
      });
    }
  };

  const cancelCardRun = async (cardId: string) => {
    const run = runs.get(cardId);
    if (!run) return;
    await cancelRun(run.id);
  };

  // Manual swarm: start agents on every assigned Ready (or assigned Backlog)
  // card, up to the parallelism cap. Mirrors what Maestro does on a tick, but
  // fires on demand so you don't need autonomous mode to run things in parallel.
  const runAllReady = () => {
    const b = boardRef.current;
    if (!b) return;
    const cap = maestroRef.current.parallelism;
    let runningNow = Array.from(runsRef.current.values()).filter(r => r.status === 'running').length;
    const candidates = b.cards
      .filter(c => (c.column === 'ready' || c.column === 'backlog')
        && !!c.assignedAgentId
        && runsRef.current.get(c.id)?.status !== 'running')
      .sort((a, z) => a.position - z.position);
    for (const c of candidates) {
      if (runningNow >= cap) break;
      runAgentOnCard(c);
      runningNow++;
    }
  };

  const sendCardBackToPlanning = (card: KanbanCard, feedback: string, runId?: string) => {
    const cleanFeedback = feedback.trim() || 'Review Watcher marked this card as needing more planning.';
    const existing = card.description || '';
    const nextDescription = existing.includes(cleanFeedback)
      ? existing
      : [existing, `Review feedback (${new Date().toLocaleString()}): ${cleanFeedback}`].filter(Boolean).join('\n\n');
    updateCard(card.id, {
      column: 'backlog',
      assignedAgentId: undefined,
      description: nextDescription,
      reviewState: 'needs-work',
      reviewMessage: cleanFeedback,
      reviewedRunId: runId,
      reviewedAt: Date.now(),
    });
  };

  // ── Maestro tick controller ────────────────────────────────────────────────
  // Runs the deterministic state machine and applies whatever actions it
  // emits. Reads through refs so we always see the latest board/runs even
  // when triggered from a useEffect that runs in a slightly stale closure.

  const runTick = async () => {
    const b = boardRef.current;
    const s = maestroRef.current;
    if (!b || !s.enabled) return;
    const hydratedRuns = await hydrateLatestRuns().catch(() => runsRef.current);
    const actions = maestroTick({ board: b, agents: agentsRef.current, runs: hydratedRuns, state: s });
    if (!actions.some(a => a.type === 'request-review') && (s.reviewMode === 'self' || s.reviewMode === 'reviewer-agent')) {
      for (const card of b.cards) {
        if (card.column !== 'review') continue;
        const run = hydratedRuns.get(card.id);
        if (!run || run.status !== 'succeeded' || !run.transcript) {
          sendCardBackToPlanning(
            card,
            run ? `Latest run is ${run.status}; Review Watcher needs a successful run transcript.` : 'No run transcript found for Review Watcher.',
            run?.id,
          );
        }
      }
    }
    // Sweep: older cards may already be parked with needs-work. Done must mean
    // passed, so send those back to planning instead of treating them as complete.
    for (const card of b.cards) {
      if (card.reviewState !== 'needs-work') continue;
      sendCardBackToPlanning(card, card.reviewMessage || 'Review Watcher marked this card as needing work.', card.reviewedRunId);
    }
    if (!actions.length) return;
    setMaestroActivity({
      backlog: actions.some(a => a.type === 'promote-to-ready'),
      running: actions.some(a => a.type === 'assign-agent' || a.type === 'start-run'),
      review: actions.some(a => a.type === 'request-review'),
    });
    for (const action of actions) {
      if (action.type === 'promote-to-ready') {
        updateCard(action.cardId, { column: 'ready' });
      } else if (action.type === 'assign-agent') {
        updateCard(action.cardId, { assignedAgentId: action.agentId });
      } else if (action.type === 'start-run') {
        // Fire and forget — runAgentOnCard handles its own state.
        runAgentOnCard(action.card);
        } else if (action.type === 'request-review') {
          const runId = hydratedRuns.get(action.cardId)?.id;
          if (runId && reviewedRef.current.has(runId)) continue;
          const card = b.cards.find(c => c.id === action.cardId);
          if (!card) continue;
          updateCard(card.id, {
            reviewState: 'reviewing',
            reviewMessage: action.reviewer ? `${action.reviewer.name} is reviewing this card.` : 'Maestro is reviewing this card.',
            reviewedRunId: runId,
            reviewedAt: Date.now(),
          });
          try {
            const verdict = await reviewCard({
              card: { id: card.id, title: card.title, description: card.description },
              transcript: action.transcript,
              reviewer: action.reviewer,
            });
            if (runId) reviewedRef.current.add(runId);
            if (verdict.pass) {
              updateCard(card.id, {
                column: 'done',
                reviewState: 'passed',
                reviewMessage: verdict.rationale,
                reviewedRunId: runId,
                reviewedAt: Date.now(),
              });
            } else {
              sendCardBackToPlanning(card, verdict.rationale || 'Review Watcher marked this card as needing work.', runId);
            }
          } catch (e) {
            console.warn('review failed', e);
            updateCard(card.id, {
              reviewState: 'error',
              reviewMessage: e instanceof Error ? e.message : String(e),
              reviewedAt: Date.now(),
            });
          }
        }
    }
    window.setTimeout(() => {
      setMaestroActivity({ backlog: false, running: false, review: false });
    }, 700);
  };

  // Approve selected Review cards using the chosen reviewer agent.
  const approveSelectedReview = async () => {
    if (reviewBusy) return;
    const s = maestroRef.current;
    if (s.reviewMode !== 'reviewer-agent') return;
    const reviewer = agentsRef.current.find(a => a.id === s.reviewerAgentId);
    if (!reviewer) return;
    const ids = Array.from(selectedReviewIds);
    if (!ids.length) return;
    setReviewBusy(true);
    try {
      for (const id of ids) {
        const card = boardRef.current?.cards.find(c => c.id === id);
        const run = runsRef.current.get(id);
        if (!card || !run?.transcript) continue;
        try {
          const verdict = await reviewCard({
            card: { id: card.id, title: card.title, description: card.description },
            transcript: run.transcript,
            reviewer,
          });
          if (verdict.pass) updateCard(card.id, { column: 'done' });
          else sendCardBackToPlanning(card, verdict.rationale || 'Reviewer marked this card as needing more planning.', run.id);
        } catch (e) {
          console.warn('reviewer-agent review failed for', id, e);
        }
      }
      setSelectedReviewIds(new Set());
    } finally {
      setReviewBusy(false);
    }
  };

  // ── Tick triggers ──────────────────────────────────────────────────────────
  // Cadence: manual = button only; on-change = board+run terminal events;
  // heartbeat = interval.

  const runTerminalSignature = useMemo(() => {
    const parts: string[] = [];
    for (const r of runs.values()) {
      if (r.status !== 'running') parts.push(`${r.id}:${r.status}`);
    }
    return parts.sort().join(',');
  }, [runs]);
  const cardSignature = useMemo(() => {
    if (!board) return '';
    return board.cards.map(c => `${c.id}:${c.column}:${c.assignedAgentId ?? ''}`).sort().join('|');
  }, [board]);

  useEffect(() => {
    if (!maestro.enabled || maestro.cadence !== 'on-change') return;
    runTick();
    // runTick reads refs; safe to depend only on signatures + cadence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardSignature, runTerminalSignature, maestro.enabled, maestro.cadence]);

  useEffect(() => {
    if (!maestro.enabled || maestro.cadence !== 'heartbeat') return;
    const ms = Math.max(5, maestro.heartbeatSec) * 1000;
    const id = setInterval(runTick, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maestro.enabled, maestro.cadence, maestro.heartbeatSec]);

  const runPlanner = async () => {
    if (!planGoal.trim() || !board) return;
    setPlanBusy(true); setPlanError(null);
    try {
      const { tasks } = await planTasks({
        goal: planGoal,
        context: planContext,
        constraints: planConstraints,
        acceptance: planAcceptance,
        questions: planQuestions,
        desiredCount: planCount,
      });
      if (!tasks.length) throw new Error('Planner returned no tasks.');
      let pos = Date.now();
      const cards = tasks.map(t => newCard({
        title: t.title,
        description: [
          t.description || '',
          t.dependsOn?.length ? `Depends on: ${t.dependsOn.join(', ')}` : '',
        ].filter(Boolean).join('\n\n'),
        tag: t.tag,
        estimate: t.estimate,
        source: 'ai', column: 'backlog', parentGoal: planGoal.trim(), position: pos++,
      }));
      persist({ ...board, cards: [...board.cards, ...cards] });
      setPlanGoal('');
      setPlanContext('');
      setPlanConstraints('');
      setPlanAcceptance('');
      setPlanQuestions('');
      setPlanOpen(false);
    } catch (e: any) {
      setPlanError(e?.message ?? String(e));
    } finally {
      setPlanBusy(false);
    }
  };

  const askClaudeForPlan = async () => {
    setPlanAssistBusy(true); setPlanError(null);
    try {
      const next = await assistPlanBrief({
        goal: planGoal,
        context: planContext,
        constraints: planConstraints,
        acceptance: planAcceptance,
        questions: planQuestions,
        desiredCount: planCount,
      });
      setPlanGoal(next.goal || planGoal);
      setPlanContext(next.context || '');
      setPlanConstraints(next.constraints || '');
      setPlanAcceptance(next.acceptance || '');
      setPlanQuestions(next.questions || '');
      if (next.desiredCount) setPlanCount(next.desiredCount);
    } catch (e: any) {
      setPlanError(e?.message ?? String(e));
    } finally {
      setPlanAssistBusy(false);
    }
  };

  if (!board) {
    return <div className="h-full flex items-center justify-center text-zinc-500 text-sm">Loading board…</div>;
  }

  const totals = board.cards.length;
  const doneCount = byColumn.done.length;
  const unassignedCount = board.cards.filter(c => !c.assignedAgentId).length;
  const activeRunCount = Array.from(runs.values()).filter(r => r.status === 'running').length;
  const anyAgentActive = activeRunCount > 0 || reviewBusy || maestroActivity.backlog || maestroActivity.running || maestroActivity.review;

  // Swarm bar data: one "lane" per currently-running card, plus the worker
  // agents that aren't busy, plus how many more we could start right now.
  const activeLanes = board.cards
    .filter(c => runs.get(c.id)?.status === 'running')
    .map(c => ({ card: c, agent: c.assignedAgentId ? agentById.get(c.assignedAgentId) : undefined }));
  const busyAgentIds = new Set(activeLanes.map(l => l.agent?.id).filter(Boolean) as string[]);
  const idleWorkerAgents = workerAgents.filter(a => !busyAgentIds.has(a.id));
  const runnableCount = board.cards.filter(c =>
    (c.column === 'ready' || c.column === 'backlog') && !!c.assignedAgentId && runs.get(c.id)?.status !== 'running').length;
  const willStartCount = Math.min(Math.max(0, maestro.parallelism - activeRunCount), runnableCount);

  return (
    <div className="h-full flex flex-col">
      <header className="relative h-10 px-3 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <KanbanSquare className="w-3.5 h-3.5 text-indigo-400" />
        <span className="text-[11px] uppercase tracking-widest text-zinc-300">Board</span>

        {/* Project root inline — picking a folder auto-loads a saved project if one is there */}
        <button
          onClick={async () => {
            const picked = await window.aios?.pickFolder({ title: 'Pick the project folder for this board', defaultPath: board.projectRoot });
            if (picked) await loadProjectFrom(picked, { confirmReplace: true });
          }}
          title={board.projectRoot ? `Project root: ${board.projectRoot} — click to change` : 'No project root set — agents will refuse to run. Click to pick.'}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] min-w-0 max-w-[44ch] border transition-colors ${
            board.projectRoot
              ? 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-700'
              : 'bg-amber-500/10 border-amber-500/40 text-amber-300 hover:bg-amber-500/15'
          }`}
        >
          <Folder className="w-3 h-3 shrink-0" />
          <span className="font-mono truncate">
            {board.projectRoot ? board.projectRoot.replace(/\\/g, '/') : 'Pick project folder'}
          </span>
          <FolderOpen className="w-3 h-3 shrink-0 opacity-60" />
        </button>

        {/* Project save / open */}
        <button
          onClick={saveProjectNow}
          disabled={projectBusy}
          title="Save this board, its agents, and Maestro settings into the project folder (.aios/project.json)"
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {projectBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          Save
        </button>
        <button
          onClick={openProject}
          disabled={projectBusy}
          title="Open a saved project from another folder (replaces the current board)"
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <FolderInput className="w-3 h-3" />
          Open
        </button>

        <span className="text-[10px] text-zinc-500">
          {totals} card{totals === 1 ? '' : 's'} · {unassignedCount} unassigned · {doneCount} done
        </span>

        {anyAgentActive && (
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 text-indigo-200 text-[10px] uppercase tracking-wider pointer-events-none">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>
              {maestroActivity.review || reviewBusy
                ? 'Review Watcher working'
                : activeRunCount > 0
                  ? `${activeRunCount} agent${activeRunCount === 1 ? '' : 's'} running`
                  : maestroActivity.backlog
                    ? 'Backlog Watcher working'
                    : 'Maestro thinking'}
            </span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={clearBoard}
            disabled={board.cards.length === 0}
            title="Delete every card and reset the board. The project folder is kept."
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-colors bg-red-600/15 text-red-300 border-red-500/30 hover:bg-red-600/25 hover:text-red-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-3 h-3" />
            Clear Board
          </button>
          <button
            onClick={() => updateMaestro({ ...maestro, enabled: !maestro.enabled })}
            title={maestro.enabled ? 'Maestro is on — autonomous mode. Click to switch to manual.' : 'Manual mode — you assign and run cards. Click to enable Maestro.'}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-colors ${
              maestro.enabled
                ? 'bg-indigo-500/25 text-indigo-100 border-indigo-400/60 shadow-[0_0_0_1px_rgba(99,102,241,0.25)_inset]'
                : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-zinc-200 hover:border-zinc-600'
            }`}
          >
            {maestro.enabled ? <Music className="w-3 h-3" /> : <MousePointer2 className="w-3 h-3" />}
            {maestro.enabled ? 'Maestro' : 'Manual'}
          </button>
          <button
            onClick={() => setPlanOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold uppercase tracking-wider transition-colors"
          >
            <Wand2 className="w-3 h-3" />
            Plan with AI
          </button>
        </div>
      </header>

      {maestro.enabled && (
        <MaestroControls
          state={maestro}
          agents={agents}
          onChange={updateMaestro}
          onTickNow={runTick}
        />
      )}

      <SwarmBar
        lanes={activeLanes}
        idleAgents={idleWorkerAgents}
        parallelism={maestro.parallelism}
        activeCount={activeRunCount}
        willStart={willStartCount}
        onChangeParallelism={(n) => updateMaestro({ ...maestro, parallelism: n })}
        onRunReady={runAllReady}
        onOpenRun={setOpenRunCardId}
        onCancelRun={cancelCardRun}
      />

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        <div className="h-full flex gap-2 px-3 py-3 min-w-max">
          {COLUMNS.map(col => (
            <Column
              key={col.id}
              column={col}
              cards={byColumn[col.id]}
              agents={workerAgents}
              agentById={agentById}
              runs={runs}
              activityLabel={
                col.id === 'backlog' && maestroActivity.backlog ? 'Backlog Watcher' :
                col.id === 'running' && (activeRunCount > 0 || maestroActivity.running) ? 'Maestro' :
                col.id === 'review' && (maestroActivity.review || reviewBusy) ? 'Review Watcher' :
                undefined
              }
              reviewerMode={maestro.enabled && maestro.reviewMode === 'reviewer-agent' && col.id === 'review'}
              selectedReviewIds={selectedReviewIds}
              onToggleReviewSelect={(id) => setSelectedReviewIds(prev => {
                const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next;
              })}
              onApproveSelected={col.id === 'review' ? approveSelectedReview : undefined}
              reviewBusy={reviewBusy}
              isComposing={composer === col.id}
              composerText={composerText}
              onStartCompose={() => { setComposer(col.id); setComposerText(''); }}
              onCancelCompose={() => { setComposer(null); setComposerText(''); }}
              onSubmitCompose={() => { addCard(col.id, composerText); setComposer(null); setComposerText(''); }}
              onComposerTextChange={setComposerText}
              onCardClick={setEditing}
              onAssign={(cardId, agentId) => {
                const card = board.cards.find(c => c.id === cardId);
                const patch: Partial<KanbanCard> = {
                  assignedAgentId: agentId || undefined,
                };
                if (agentId && card?.column === 'backlog') {
                  patch.column = 'ready';
                }
                if (agentId && card?.reviewState === 'needs-work') {
                  patch.reviewState = 'pending';
                  patch.reviewMessage = undefined;
                  patch.reviewedRunId = undefined;
                  patch.reviewedAt = undefined;
                }
                updateCard(cardId, {
                  ...patch,
                });
              }}
              onRun={runAgentOnCard}
              onCancelRun={cancelCardRun}
              onOpenRun={setOpenRunCardId}
              onDeleteCard={col.id === 'done' ? deleteCard : undefined}
              onClearColumn={col.id === 'done' ? deleteDoneCards : undefined}
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
            context={planContext} setContext={setPlanContext}
            constraints={planConstraints} setConstraints={setPlanConstraints}
            acceptance={planAcceptance} setAcceptance={setPlanAcceptance}
            questions={planQuestions} setQuestions={setPlanQuestions}
            count={planCount} setCount={setPlanCount}
            busy={planBusy} assistBusy={planAssistBusy} error={planError}
            onCancel={() => { setPlanOpen(false); setPlanError(null); }}
            onAssist={askClaudeForPlan}
            onRun={runPlanner}
          />
        )}
        {editing && (
          <CardModal
            card={editing}
            agents={workerAgents}
            onClose={() => setEditing(null)}
            onSave={patch => {
              const clearsReview = editing.reviewState === 'needs-work' && (
                typeof patch.title === 'string' ||
                typeof patch.description === 'string' ||
                !!patch.assignedAgentId
              );
              const nextPatch = clearsReview
                ? { ...patch, reviewState: 'pending' as const, reviewMessage: undefined, reviewedRunId: undefined, reviewedAt: undefined }
                : patch;
              updateCard(editing.id, nextPatch);
              setEditing({ ...editing, ...nextPatch });
            }}
            onDelete={() => { deleteCard(editing.id); setEditing(null); }}
          />
        )}
        {openRunCardId && runs.get(openRunCardId) && (
          <AgentRunDrawer
            run={runs.get(openRunCardId)!}
            cardTitle={board.cards.find(c => c.id === openRunCardId)?.title ?? '(unknown card)'}
            onClose={() => setOpenRunCardId(null)}
            onCancel={() => cancelCardRun(openRunCardId)}
          />
        )}
        {clearPromptOpen && (
          <ClearBoardModal
            cardCount={board.cards.length}
            hasProjectRoot={!!board.projectRoot?.trim()}
            busy={projectBusy}
            onCancel={() => setClearPromptOpen(false)}
            onClear={doClear}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50 max-w-[80%] px-3 py-1.5 rounded-md border border-zinc-700 bg-zinc-900/95 text-zinc-200 text-[11px] shadow-lg truncate"
          >
            {notice}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Swarm bar: a board-wide, mode-agnostic strip that makes parallel agent work
// visible and launchable. Shows the concurrency cap, one live "lane" per
// running card, the idle worker agents (available capacity), and a one-click
// "Run Ready" button that fans agents out across assigned cards up to the cap.
function SwarmBar({
  lanes, idleAgents, parallelism, activeCount, willStart,
  onChangeParallelism, onRunReady, onOpenRun, onCancelRun,
}: {
  lanes: Array<{ card: KanbanCard; agent?: AgentDef }>;
  idleAgents: AgentDef[];
  parallelism: number;
  activeCount: number;
  willStart: number;
  onChangeParallelism: (n: number) => void;
  onRunReady: () => void;
  onOpenRun: (cardId: string) => void;
  onCancelRun: (cardId: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-950/50 shrink-0">
      <div className="flex items-center gap-1.5 shrink-0">
        <Users className="w-3 h-3 text-indigo-400" />
        <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">Swarm</span>
      </div>

      <div
        className="flex items-center gap-1 shrink-0"
        title="Max agents working at once — applies to Maestro and to the Run Ready button"
      >
        <input
          type="number" min={1} max={10} value={parallelism}
          onChange={e => onChangeParallelism(Math.max(1, Math.min(10, parseInt(e.target.value || '1', 10) || 1)))}
          className="w-11 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 tabular-nums focus:outline-none focus:border-indigo-500/60"
        />
        <span className="text-[9px] uppercase tracking-wider text-zinc-500">lanes</span>
      </div>

      <span className={`text-[10px] tabular-nums shrink-0 ${activeCount > 0 ? 'text-indigo-300' : 'text-zinc-600'}`}>
        {activeCount}/{parallelism} active
      </span>

      <div className="h-4 w-px bg-zinc-800 shrink-0" />

      {/* Live lanes + idle agents */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto">
        {lanes.length === 0 && idleAgents.length === 0 && (
          <span className="text-[10px] text-zinc-600">No worker agents yet — build one on the left.</span>
        )}
        {lanes.map(({ card, agent }) => (
          <div
            key={card.id}
            className="flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 text-indigo-200 shrink-0 max-w-[220px]"
          >
            <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />
            <button
              onClick={() => onOpenRun(card.id)}
              title={`${agent?.name || agent?.slug || 'agent'} · ${card.title} — open transcript`}
              className="flex items-center gap-1 min-w-0"
            >
              <span className="text-[9px] font-bold uppercase tracking-wider shrink-0">{agent?.name || agent?.slug || 'agent'}</span>
              <span className="text-[10px] text-indigo-100/70 truncate">{card.title}</span>
            </button>
            <button
              onClick={() => onCancelRun(card.id)}
              title="Cancel run"
              className="p-0.5 rounded text-indigo-300/70 hover:text-red-300 hover:bg-red-500/10 shrink-0"
            >
              <StopSquare className="w-2.5 h-2.5" />
            </button>
          </div>
        ))}
        {idleAgents.map(a => (
          <span
            key={a.id}
            title={`${a.name || a.slug} — idle`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-zinc-800 bg-zinc-900/40 text-zinc-500 shrink-0"
          >
            <Bot className="w-2.5 h-2.5" />
            <span className="text-[9px] uppercase tracking-wider">{a.name || a.slug}</span>
          </span>
        ))}
      </div>

      <button
        onClick={onRunReady}
        disabled={willStart === 0}
        title={willStart === 0
          ? 'Nothing to start — assign an agent to a Ready/Backlog card, or wait for a lane to free up'
          : `Start ${willStart} agent${willStart === 1 ? '' : 's'} on Ready cards in parallel`}
        className="ml-auto shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 hover:text-emerald-200 border-emerald-500/30"
      >
        <PlayCircle className="w-3 h-3" />
        Run Ready{willStart > 0 ? ` (${willStart})` : ''}
      </button>
    </div>
  );
}

function Column({
  column, cards, agents, agentById, runs, isComposing, composerText,
  activityLabel,
  onStartCompose, onCancelCompose, onSubmitCompose, onComposerTextChange,
  onCardClick, onAssign, onRun, onCancelRun, onOpenRun, onDeleteCard, onClearColumn,
  onDragStart, onDropOnColumn,
  reviewerMode, selectedReviewIds, onToggleReviewSelect, onApproveSelected, reviewBusy,
}: {
  column: { id: ColumnId; label: string; hint: string };
  cards: KanbanCard[];
  agents: AgentDef[];
  agentById: Map<string, AgentDef>;
  runs: Map<string, AgentRun>;
  activityLabel?: string;
  isComposing: boolean;
  composerText: string;
  onStartCompose: () => void;
  onCancelCompose: () => void;
  onSubmitCompose: () => void;
  onComposerTextChange: (s: string) => void;
  onCardClick: (c: KanbanCard) => void;
  onAssign: (cardId: string, agentId: string) => void;
  onRun: (card: KanbanCard) => void;
  onCancelRun: (cardId: string) => void;
  onOpenRun: (cardId: string) => void;
  onDeleteCard?: (cardId: string) => void;
  onClearColumn?: () => void;
  onDragStart: (id: string) => void;
  onDropOnColumn: (target: ColumnId, beforeId?: string) => void;
  reviewerMode?: boolean;
  selectedReviewIds?: Set<string>;
  onToggleReviewSelect?: (id: string) => void;
  onApproveSelected?: () => void;
  reviewBusy?: boolean;
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
        {activityLabel && (
          <span
            title={`${activityLabel} is working`}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/25 text-[9px] uppercase tracking-wider text-indigo-200"
          >
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
            {activityLabel}
          </span>
        )}
        {reviewerMode && onApproveSelected && (
          <button
            onClick={onApproveSelected}
            disabled={reviewBusy || !selectedReviewIds || selectedReviewIds.size === 0}
            title="Run the reviewer agent on all selected cards"
            className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 hover:text-emerald-200 border border-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {reviewBusy ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <CheckCircle2 className="w-2.5 h-2.5" />}
            Approve ({selectedReviewIds?.size ?? 0})
          </button>
        )}
        {onClearColumn && (
          <button
            onClick={onClearColumn}
            disabled={cards.length === 0}
            title="Delete all done cards"
            className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider bg-red-600/15 text-red-300 hover:bg-red-600/25 hover:text-red-200 border border-red-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-2.5 h-2.5" />
            Clear
          </button>
        )}
        <button
          onClick={onStartCompose}
          title="Add card"
          className={`${reviewerMode || onClearColumn ? '' : 'ml-auto'} p-0.5 rounded text-zinc-500 hover:text-white hover:bg-zinc-800`}
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
            run={runs.get(card.id)}
            onClick={() => onCardClick(card)}
            onAssign={(agentId) => onAssign(card.id, agentId)}
            onRun={() => onRun(card)}
            onCancelRun={() => onCancelRun(card.id)}
            onOpenRun={() => onOpenRun(card.id)}
            onDragStart={() => onDragStart(card.id)}
            onDropBefore={() => onDropOnColumn(column.id, card.id)}
            onDelete={onDeleteCard ? () => onDeleteCard(card.id) : undefined}
            selectable={!!reviewerMode}
            selected={!!selectedReviewIds?.has(card.id)}
            onToggleSelect={() => onToggleReviewSelect?.(card.id)}
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
  card, agents, agent, run, onClick, onAssign, onRun, onCancelRun, onOpenRun, onDragStart, onDropBefore,
  onDelete, selectable, selected, onToggleSelect,
}: {
  card: KanbanCard;
  agents: AgentDef[];
  agent?: AgentDef;
  run?: AgentRun;
  onClick: () => void;
  onAssign: (agentId: string) => void;
  onRun: () => void;
  onCancelRun: () => void;
  onOpenRun: () => void;
  onDragStart: () => void;
  onDropBefore: () => void;
  onDelete?: () => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const running = run?.status === 'running';
  const canRun = !!card.assignedAgentId && !running;
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropBefore(); }}
      onClick={onClick}
      className="group relative rounded-md bg-zinc-900 hover:bg-zinc-900/80 border border-zinc-800 hover:border-zinc-700 p-2 cursor-pointer transition-colors"
    >
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete done card"
          className="absolute top-1 right-1 p-0.5 rounded text-zinc-600 hover:text-red-300 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        >
          <X className="w-3 h-3" />
        </button>
      )}
      <div className="flex items-start gap-1">
        {selectable ? (
          <input
            type="checkbox"
            checked={!!selected}
            onClick={e => e.stopPropagation()}
            onChange={() => onToggleSelect?.()}
            title="Select for reviewer agent"
            className="mt-0.5 shrink-0 accent-emerald-500"
          />
        ) : (
          <GripVertical className="w-3 h-3 text-zinc-600 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-1.5 text-[11px] text-zinc-100 leading-snug">
            {running && <Loader2 className="w-3 h-3 mt-0.5 shrink-0 animate-spin text-indigo-300" />}
            <span className="min-w-0">{card.title}</span>
          </div>

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
            {running ? (
              <button
                onClick={onCancelRun}
                title="Cancel run"
                className="p-0.5 rounded text-red-300 hover:bg-red-500/10"
              >
                <StopSquare className="w-3 h-3" />
              </button>
            ) : (
              <button
                onClick={onRun}
                disabled={!canRun}
                title={!card.assignedAgentId ? 'Assign an agent first' : 'Run agent on this card'}
                className={`p-0.5 rounded ${canRun ? 'text-emerald-400 hover:text-white hover:bg-emerald-500/10' : 'text-zinc-700 cursor-not-allowed'}`}
              >
                <Play className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Run status row */}
          {run && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenRun(); }}
              className="mt-1.5 w-full flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border bg-zinc-950 hover:bg-zinc-900 transition-colors"
              title="Open run output"
            >
              <RunBadgeIcon status={run.status} />
              <span className={runStatusColor(run.status)}>{run.status}</span>
              {run.transcript && <span className="text-zinc-600 truncate normal-case tracking-normal text-[10px] ml-1">{transcriptPreview(run.transcript)}</span>}
            </button>
          )}

          {card.reviewState && card.reviewState !== 'passed' && (
            <div
              className={`mt-1.5 flex items-start gap-1 px-1.5 py-1 rounded border text-[9px] leading-snug ${
                card.reviewState === 'reviewing'
                  ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-200'
                  : card.reviewState === 'needs-work'
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                    : 'bg-red-500/10 border-red-500/30 text-red-200'
              }`}
              title={card.reviewMessage || card.reviewState}
            >
              {card.reviewState === 'reviewing' ? <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0 mt-0.5" /> : <AlertCircle className="w-2.5 h-2.5 shrink-0 mt-0.5" />}
              <span className="min-w-0 line-clamp-2">
                {card.reviewState === 'needs-work' ? 'Needs work: ' : card.reviewState === 'missing-run' ? 'Review blocked: ' : card.reviewState === 'error' ? 'Review error: ' : ''}
                {card.reviewMessage || card.reviewState}
              </span>
            </div>
          )}

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

function ClearBoardModal({
  cardCount, hasProjectRoot, busy, onCancel, onClear,
}: {
  cardCount: number;
  hasProjectRoot: boolean;
  busy: boolean;
  onCancel: () => void;
  onClear: (save: boolean) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={busy ? undefined : onCancel}
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xl overflow-y-auto"
    >
      <div className="min-h-full flex items-center justify-center p-8">
        <motion.div
          initial={{ scale: 0.97, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 12 }}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-md bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden"
        >
          <header className="h-14 px-5 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/30">
            <Trash2 className="w-4 h-4 text-red-400" />
            <h3 className="text-sm font-semibold">Clear board</h3>
          </header>
          <div className="px-5 py-4 space-y-2 text-[12px] text-zinc-300">
            <p>
              This deletes all {cardCount} card{cardCount === 1 ? '' : 's'} and resets the board.
              The project folder is kept. Any running agents will be stopped.
            </p>
            <p className="text-zinc-500">
              {hasProjectRoot
                ? 'Save first to snapshot the board, its agents, and Maestro settings into the project folder.'
                : 'No project folder is set yet — choosing “Save & clear” will ask you to pick one.'}
            </p>
          </div>
          <div className="px-5 py-4 border-t border-zinc-800 flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-[11px] font-medium border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={() => onClear(false)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-[11px] font-medium border border-red-500/30 bg-red-600/15 text-red-300 hover:bg-red-600/25 hover:text-red-200 disabled:opacity-40"
            >
              Clear without saving
            </button>
            <button
              onClick={() => onClear(true)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-bold border border-indigo-400/60 bg-indigo-500/25 text-indigo-100 hover:bg-indigo-500/35 disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save &amp; clear
            </button>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

function PlanModal({
  goal, setGoal, context, setContext, constraints, setConstraints, acceptance, setAcceptance,
  questions, setQuestions, count, setCount, busy, assistBusy, error, onCancel, onAssist, onRun,
}: {
  goal: string; setGoal: (s: string) => void;
  context: string; setContext: (s: string) => void;
  constraints: string; setConstraints: (s: string) => void;
  acceptance: string; setAcceptance: (s: string) => void;
  questions: string; setQuestions: (s: string) => void;
  count: number; setCount: (n: number) => void;
  busy: boolean; assistBusy: boolean; error: string | null;
  onCancel: () => void; onAssist: () => void; onRun: () => void;
}) {
  const locked = busy || assistBusy;
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={locked ? undefined : onCancel}
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xl overflow-y-auto"
    >
      <div className="min-h-full flex items-start justify-center p-8">
        <motion.div
          initial={{ scale: 0.97, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 12 }}
          onClick={e => e.stopPropagation()}
          className="my-auto w-full max-w-3xl bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden"
        >
          <header className="h-14 px-5 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/30">
            <Sparkles className="w-4 h-4 text-indigo-400" />
            <h3 className="text-sm font-semibold">Plan with AI</h3>
            <button
              onClick={onAssist}
              disabled={locked || (!goal.trim() && !context.trim())}
              title="Ask Claude to refine the brief before generating cards"
              className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-violet-600/20 text-violet-200 hover:bg-violet-600/30 border border-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {assistBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Ask Claude
            </button>
          </header>
          <div className="px-5 py-4 space-y-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Outcome</label>
              <textarea
                autoFocus value={goal} onChange={e => setGoal(e.target.value)} disabled={locked} rows={3}
                placeholder='e.g. "Make the Orchestra planner generate connected implementation cards from a richer brief"'
                className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 resize-none"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <PlanField label="Current state / context">
                <textarea
                  value={context}
                  onChange={e => setContext(e.target.value)}
                  disabled={locked}
                  rows={5}
                  placeholder="What exists now, relevant files, current behavior, user pain, prior attempts..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 resize-none"
                />
              </PlanField>
              <PlanField label="Definition of done">
                <textarea
                  value={acceptance}
                  onChange={e => setAcceptance(e.target.value)}
                  disabled={locked}
                  rows={5}
                  placeholder="What should be true when this is finished? Include test, UX, and behavior expectations."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 resize-none"
                />
              </PlanField>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <PlanField label="Constraints / non-goals">
                <textarea
                  value={constraints}
                  onChange={e => setConstraints(e.target.value)}
                  disabled={locked}
                  rows={4}
                  placeholder="Scope limits, design constraints, files to avoid, compatibility requirements..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 resize-none"
                />
              </PlanField>
              <PlanField label="Questions / assumptions">
                <textarea
                  value={questions}
                  onChange={e => setQuestions(e.target.value)}
                  disabled={locked}
                  rows={4}
                  placeholder="Let Claude add clarifying questions, assumptions, or decisions that shape the card sequence."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 resize-none"
                />
              </PlanField>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-[10px] uppercase tracking-wider text-zinc-500">Target count</label>
              <input
                type="number" min={2} max={20} value={count}
                onChange={e => setCount(parseInt(e.target.value || '7', 10))} disabled={locked}
                className="w-16 bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1 text-[12px] text-zinc-100 tabular-nums focus:outline-none focus:border-indigo-500/60"
              />
              <span className="text-[11px] text-zinc-500">connected backlog cards</span>
            </div>
            {error && (
              <div className="flex items-start gap-2 p-2.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-300 text-[12px]">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
          <footer className="px-5 py-3 border-t border-zinc-800 bg-zinc-900/30 flex justify-end gap-2">
            <button onClick={onCancel} disabled={locked} className="px-3 py-1.5 rounded-md text-[12px] text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-50">Cancel</button>
            <button
              onClick={onRun} disabled={locked || !goal.trim()}
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

function PlanField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{label}</label>
      {children}
    </div>
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
  const [workingDirOverride, setWorkingDirOverride] = useState(card.workingDirOverride ?? '');

  const dirty =
    title !== card.title ||
    description !== card.description ||
    (tag || '') !== (card.tag || '') ||
    (estimate || '') !== (card.estimate || '') ||
    (priority || '') !== (card.priority || '') ||
    (assignedAgentId || '') !== (card.assignedAgentId || '') ||
    (workingDirOverride || '') !== (card.workingDirOverride || '');

  const apply = () => onSave({
    title: title.trim() || card.title,
    description: description.trim(),
    tag: tag.trim() || undefined,
    estimate: estimate.trim() || undefined,
    priority: priority || undefined,
    assignedAgentId: assignedAgentId || undefined,
    workingDirOverride: workingDirOverride.trim() || undefined,
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
            <div>
              <div className="text-[9px] uppercase tracking-wider text-zinc-500 mb-1">Working dir override (optional)</div>
              <div className="flex gap-1">
                <input
                  value={workingDirOverride}
                  onChange={e => setWorkingDirOverride(e.target.value)}
                  placeholder="Leave blank to inherit from agent / board project root"
                  className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 font-mono"
                />
                <button
                  onClick={async () => {
                    const picked = await window.aios?.pickFolder({ title: 'Pick a subfolder for this card', defaultPath: workingDirOverride || undefined });
                    if (picked) setWorkingDirOverride(picked);
                  }}
                  title="Pick a folder"
                  className="px-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                </button>
              </div>
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

function RunBadgeIcon({ status }: { status: AgentRun['status'] }) {
  if (status === 'running')   return <Loader2 className="w-2.5 h-2.5 animate-spin text-indigo-300" />;
  if (status === 'succeeded') return <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />;
  if (status === 'failed')    return <AlertCircle className="w-2.5 h-2.5 text-red-400" />;
  if (status === 'canceled')  return <StopSquare className="w-2.5 h-2.5 text-amber-400" />;
  return <Clock className="w-2.5 h-2.5 text-zinc-500" />;
}

function runStatusColor(status: AgentRun['status']) {
  if (status === 'running')   return 'text-indigo-300';
  if (status === 'succeeded') return 'text-emerald-300';
  if (status === 'failed')    return 'text-red-300';
  if (status === 'canceled')  return 'text-amber-300';
  return 'text-zinc-400';
}

function transcriptPreview(t: string): string {
  const lastLine = t.split('\n').reverse().find(l => l.trim()) ?? '';
  return lastLine.length > 36 ? lastLine.slice(0, 36) + '…' : lastLine;
}
