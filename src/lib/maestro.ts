// Maestro: the autonomous conductor for the Orchestra board.
// When enabled, watches the board and drives cards through their lifecycle.
// Triage (the one-shot backlog assignment helper) is independent — Maestro
// respects pre-assigned cards from Triage and never re-assigns them.

import * as db from './db';
import { apiUrl } from './apiBase';
import { getAnthropicAuthMode } from './authMode';
import { newAgent, saveAgent, type AgentDef } from './agents';
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
  parallelism: 2,
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
  | { type: 'promote-to-ready'; cardId: string }
  | { type: 'request-review'; cardId: string; transcript: string };

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

  // Workers only — Maestro/Reviewer never run cards
  const workerById = new Map<string, AgentDef>();
  for (const a of agents) {
    if (a.role !== 'maestro' && a.role !== 'reviewer') workerById.set(a.id, a);
  }

  // Count what's currently running
  let runningNow = 0;
  for (const c of board.cards) {
    if (c.column === 'running') {
      const r = runs.get(c.id);
      if (!r || r.status === 'running') runningNow++;
    }
  }

  // Promote: Backlog (assigned) → Ready
  for (const c of board.cards) {
    if (c.column === 'backlog' && c.assignedAgentId && workerById.has(c.assignedAgentId)) {
      actions.push({ type: 'promote-to-ready', cardId: c.id });
    }
  }

  // Start: Ready → Running, up to parallelism cap
  const ready = board.cards
    .filter(c => c.column === 'ready' && c.assignedAgentId && workerById.has(c.assignedAgentId))
    .sort((a, b) => a.position - b.position);
  for (const c of ready) {
    if (runningNow >= state.parallelism) break;
    const agent = workerById.get(c.assignedAgentId!);
    if (!agent) continue;
    actions.push({ type: 'start-run', card: c, agent });
    runningNow++;
  }

  // Review handling: Self mode auto-approves via LLM (caller drives that flow).
  // Reviewer-agent mode is batch-driven (user picks cards, clicks button).
  // Human mode does nothing here.
  if (state.reviewMode === 'self') {
    for (const c of board.cards) {
      if (c.column === 'review') {
        const r = runs.get(c.id);
        if (r && r.status === 'succeeded' && r.transcript && !(c as any).maestroReviewed) {
          actions.push({ type: 'request-review', cardId: c.id, transcript: r.transcript });
        }
      }
    }
  }

  return actions;
}

// ── Review LLM call ────────────────────────────────────────────────────────
// Used by both self-approve mode (Maestro reviews) and reviewer-agent mode
// (user-picked agent reviews). Returns a verdict + short rationale.

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
