// Maestro: the autonomous conductor for the Orchestra board.
// When enabled, watches the board and drives cards through their lifecycle.

import * as db from './db';
import { apiUrl } from './apiBase';
import { getAnthropicAuthMode } from './authMode';
import { BACKLOG_WATCHER_AGENT_SLUG, REVIEW_WATCHER_AGENT_SLUG, newAgent, saveAgent, type AgentDef } from './agents';
import type { KanbanBoard, KanbanCard } from './kanban';
import type { AgentRun } from './runs';

export type ReviewMode = 'human' | 'self' | 'reviewer-agent';
export type Cadence = 'manual' | 'on-change' | 'heartbeat';

export interface MaestroState {
  enabled: boolean;
  reviewMode: ReviewMode;
  reviewerAgentId?: string;        // only used when reviewMode === 'reviewer-agent'
  cadence: Cadence;
  heartbeatSec: number;            // only when cadence === 'heartbeat'
  parallelism: number;             // max concurrent runs
}

export const DEFAULT_MAESTRO: MaestroState = {
  enabled: false,
  reviewMode: 'human',
  cadence: 'manual',
  heartbeatSec: 30,
  parallelism: 4,
};

const STATE_KEY = 'maestro:state';

export async function loadMaestroState(): Promise<MaestroState> {
  const existing = await db.getMeta<MaestroState>(STATE_KEY);
  return { ...DEFAULT_MAESTRO, ...(existing || {}) };
}

export async function saveMaestroState(state: MaestroState): Promise<void> {
  await db.setMeta(STATE_KEY, state);
}

// ── Maestro agent bootstrap ────────────────────────────────────────────────
// Maestro is itself an agent record so it appears in the agent list, has its
// own .md file, and can be tweaked. We mark it role: 'maestro' so it's filtered
// out of the worker dropdowns on cards.

const MAESTRO_SLUG = 'maestro';

const MAESTRO_PROMPT = [
  'You are the Maestro — the conductor of the Orchestra board.',
  '',
  'Your job is to keep cards flowing through their lifecycle (Backlog → Ready → Running → Review → Done).',
  'You do NOT do the underlying work yourself. You decide:',
  '  • Which backlog card should run next, and which worker agent should run it.',
  '  • When a finished run is good enough to mark Done (only in self-approve review mode).',
  '',
  'Be decisive but conservative. If a card has no good-fit agent, leave it in Backlog and explain why.',
  'When asked to assign, return ONLY a JSON object — no prose, no fences.',
].join('\n');

export async function ensureMaestroAgent(existing: AgentDef[]): Promise<AgentDef> {
  const found = existing.find(a => a.role === 'maestro' || a.slug === MAESTRO_SLUG);
  if (found) return found;
  const agent = newAgent({
    name: 'Maestro',
    slug: MAESTRO_SLUG,
    description: 'Conducts the Orchestra board — assigns workers and (optionally) approves work.',
    systemPrompt: MAESTRO_PROMPT,
    model: 'inherit',
    allowedTools: [],   // Maestro doesn't run tools — it reasons + emits decisions
    workingDir: '',
  });
  agent.role = 'maestro';
  await saveAgent(agent);
  return agent;
}

// ── Tick controller (deterministic state machine) ──────────────────────────
// One tick scans the board and emits a list of actions for the caller to apply.
// LLM calls (auto-assign / review) happen separately so tick() stays cheap.

export type TickAction =
  | { type: 'start-run'; card: KanbanCard; agent: AgentDef }
  | { type: 'assign-agent'; cardId: string; agentId: string }
  | { type: 'promote-to-ready'; cardId: string }
  | { type: 'request-review'; cardId: string; transcript: string; reviewer?: AgentDef };

export interface TickInput {
  board: KanbanBoard;
  agents: AgentDef[];                 // all agents (we filter internally)
  runs: Map<string, AgentRun>;        // cardId -> latest run
  state: MaestroState;
}

export function tick(input: TickInput): TickAction[] {
  const { board, agents, runs, state } = input;
  if (!state.enabled) return [];

  const actions: TickAction[] = [];

  const hasBacklogWatcher = agents.some(a => a.slug === BACKLOG_WATCHER_AGENT_SLUG);

  // Workers only — Maestro/Reviewer/Watcher agents never run cards
  const workerById = new Map<string, AgentDef>();
  for (const a of agents) {
    if (a.role !== 'maestro' && a.role !== 'reviewer' && a.role !== 'watcher') workerById.set(a.id, a);
  }
  const workers = Array.from(workerById.values());

  // Count what's currently running
  let runningNow = 0;
  for (const c of board.cards) {
    if (c.column === 'running') {
      const r = runs.get(c.id);
      if (!r || r.status === 'running') runningNow++;
    }
  }

  // Promote: assigned Backlog cards move to Ready. If the Backlog Watcher
  // exists, it also keeps unassigned Backlog cards flowing into Ready.
  for (const c of board.cards) {
    if (c.column !== 'backlog') continue;
    if (c.reviewState === 'needs-work' || c.reviewState === 'missing-run' || c.reviewState === 'error') continue;
    if (c.assignedAgentId && workerById.has(c.assignedAgentId)) {
      actions.push({ type: 'promote-to-ready', cardId: c.id });
    } else if (!c.assignedAgentId && hasBacklogWatcher) {
      actions.push({ type: 'promote-to-ready', cardId: c.id });
    }
  }

  // Start: Ready → Running, up to parallelism cap
  const ready = board.cards
    .filter(c => c.column === 'ready')
    .sort((a, b) => a.position - b.position);
  for (const c of ready) {
    if (runningNow >= state.parallelism) break;
    const agent = c.assignedAgentId && workerById.has(c.assignedAgentId)
      ? workerById.get(c.assignedAgentId)
      : chooseWorkerForCard(c, workers);
    if (!agent) continue;
    if (c.assignedAgentId !== agent.id) {
      actions.push({ type: 'assign-agent', cardId: c.id, agentId: agent.id });
    }
    actions.push({ type: 'start-run', card: { ...c, assignedAgentId: agent.id }, agent });
    runningNow++;
  }

  // Review handling: Self mode uses Maestro. Agent mode uses the configured
  // reviewer, falling back to the built-in Review Watcher when available.
  const reviewer = state.reviewMode === 'reviewer-agent'
    ? agents.find(a => a.id === state.reviewerAgentId) || agents.find(a => a.slug === REVIEW_WATCHER_AGENT_SLUG)
    : undefined;
  if (state.reviewMode === 'self' || (state.reviewMode === 'reviewer-agent' && reviewer)) {
    for (const c of board.cards) {
      if (c.column === 'review') {
        const r = runs.get(c.id);
        const reviewedThisRun = c.reviewedRunId === r?.id && (c.reviewState === 'passed' || c.reviewState === 'needs-work');
        const reviewRecentlyStarted = c.reviewState === 'reviewing' && !!c.reviewedAt && Date.now() - c.reviewedAt < 120000;
        if (
          r && r.status === 'succeeded' && r.transcript &&
          !reviewedThisRun &&
          !reviewRecentlyStarted
        ) {
          actions.push({ type: 'request-review', cardId: c.id, transcript: r.transcript, reviewer });
        }
      }
    }
  }

  return actions;
}

// ── Review LLM call ────────────────────────────────────────────────────────
// Used by both self-approve mode (Maestro reviews) and reviewer-agent mode
// (user-picked agent reviews). Returns a verdict + short rationale.

function chooseWorkerForCard(card: KanbanCard, workers: AgentDef[]): AgentDef | undefined {
  if (!workers.length) return undefined;

  const text = `${card.title} ${card.description || ''} ${card.tag || ''}`.toLowerCase();
  // Default to implementation. Only flip to audit-only when the card is *explicitly*
  // an audit/diagnose/report task and contains no implementation verb.
  const auditOnlyCard = /\b(audit|diagnose|investigate|monitor|report on|review of|inspect)\b/.test(text)
    && !/\b(add|build|create|implement|wire|fix|update|change|refactor|persist|integrate|delete|remove|render|save|load|write|ship|expose|hook up)\b/.test(text);
  const implementationCard = !auditOnlyCard;

  // Implementation cards must go to an Edit/Write-capable worker if any exist.
  const editCapable = workers.filter(w => w.allowedTools.includes('Edit') || w.allowedTools.includes('Write'));
  const pool = implementationCard && editCapable.length ? editCapable : workers;

  let best = pool[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const worker of pool) {
    const profile = `${worker.name} ${worker.slug} ${worker.description} ${worker.systemPrompt}`.toLowerCase();
    const canEdit = worker.allowedTools.includes('Edit') || worker.allowedTools.includes('Write');
    let score = 0;

    for (const token of text.split(/[^a-z0-9]+/).filter(t => t.length >= 4)) {
      if (profile.includes(token)) score += 2;
    }
    if (implementationCard && !canEdit) score -= 100;
    if (implementationCard && canEdit) score += 10;
    if (/\b(ui|ux|frontend|front-end|react|css|layout|screen|button|modal|component)\b/.test(text) && /front|ui|ux|react|web/.test(profile)) score += 8;
    if (/\b(api|server|backend|back-end|database|db|sql|route|endpoint|auth)\b/.test(text) && /back|server|api|database/.test(profile)) score += 8;
    if (/\b(network|dns|proxy|cors|websocket|socket|tls|http|connect|transport)\b/.test(text) && /network|dns|proxy|transport/.test(profile)) score += 8;
    if (/\b(architecture|refactor|complex|debug|senior|cross-cutting|integration)\b/.test(text) && /senior|programming|architecture/.test(profile)) score += 6;
    if (implementationCard && /senior|programming|engineer/.test(profile)) score += 8;
    if (auditOnlyCard && /monitor|diagnose|network|audit/.test(profile)) score += 10;

    if (score > bestScore) {
      best = worker;
      bestScore = score;
    }
  }

  return best;
}

export interface ReviewVerdict {
  pass: boolean;
  rationale: string;
}

export async function reviewCard(args: {
  card: { id: string; title: string; description?: string };
  transcript: string;
  reviewer?: AgentDef;        // omit for Maestro self-review
}): Promise<ReviewVerdict> {
  const authMode = await getAnthropicAuthMode();
  const res = await fetch(apiUrl('/api/agents/review'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authMode,
      card: args.card,
      transcript: args.transcript,
      reviewer: args.reviewer ? {
        slug: args.reviewer.slug,
        name: args.reviewer.name,
        systemPrompt: args.reviewer.systemPrompt,
        model: args.reviewer.model,
      } : null,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Review failed (${res.status})`);
  }
  return res.json();
}
