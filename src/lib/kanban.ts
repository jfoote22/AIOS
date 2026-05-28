// Kanban board: storage + AI task breakdown.
// Phase 1: single board, manual CRUD, "Plan with AI" splits a goal into
// modular cards that land in the Backlog column for user review.

import * as db from './db';
import { apiUrl } from './apiBase';
import { getAnthropicAuthMode } from './authMode';

// Agent-workflow columns (not human todo). Cards move through these as the
// assigned agent runs. The Manager agent (Phase 1D) will drive automatic
// progression; for now humans drag manually.
export type ColumnId = 'backlog' | 'ready' | 'running' | 'review' | 'done';

export const COLUMNS: Array<{ id: ColumnId; label: string; hint: string }> = [
  { id: 'backlog', label: 'Backlog', hint: 'Unassigned, waiting for an agent' },
  { id: 'ready',   label: 'Ready',   hint: 'Assigned, ready to run' },
  { id: 'running', label: 'Running', hint: 'Agent is currently working' },
  { id: 'review',  label: 'Review',  hint: 'Agent finished; awaiting human ack' },
  { id: 'done',    label: 'Done',    hint: 'Verified complete' },
];

export type Priority = 'low' | 'medium' | 'high';
export type CardSource = 'manual' | 'ai';

export interface KanbanCard {
  id: string;
  column: ColumnId;
  position: number;          // ordering within a column
  title: string;
  description: string;
  tag?: string;
  priority?: Priority;
  estimate?: string;         // free text: "30 min", "small", "1 day"
  source: CardSource;
  parentGoal?: string;       // for AI-generated cards, the goal they came from
  assignedAgentId?: string;  // id of the agent that owns this card
  /**
   * Per-card override for where the agent runs. If set, beats agent.workingDir
   * and board.projectRoot. Use for "this card should be scoped to subfolder X".
   */
  workingDirOverride?: string;
  reviewState?: 'pending' | 'reviewing' | 'passed' | 'needs-work' | 'error' | 'missing-run';
  reviewMessage?: string;
  reviewedRunId?: string;
  reviewedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface KanbanBoard {
  id: string;
  title: string;
  cards: KanbanCard[];
  updatedAt: number;
  /**
   * Default working directory for any agent run on this board. Agents inherit
   * this when their own workingDir is blank. Card-level workingDirOverride
   * beats both. Without this set, runs are refused (no implicit AIOS folder).
   */
  projectRoot?: string;
}

/**
 * Pick the effective working directory for a run, in priority order:
 *   1. card.workingDirOverride
 *   2. agent.workingDir
 *   3. board.projectRoot
 * Returns null if none are set — caller should refuse to run.
 */
export function resolveWorkingDir(
  card: Pick<KanbanCard, 'workingDirOverride'>,
  agent: { workingDir?: string },
  board: Pick<KanbanBoard, 'projectRoot'>,
): string | null {
  const pick = card.workingDirOverride?.trim() || agent.workingDir?.trim() || board.projectRoot?.trim() || '';
  return pick || null;
}

const BOARD_KEY = 'kanban:default';

export async function loadBoard(): Promise<KanbanBoard> {
  const existing = await db.getMeta<KanbanBoard>(BOARD_KEY);
  if (existing) return existing;
  const fresh: KanbanBoard = {
    id: 'default',
    title: 'Board',
    cards: [],
    updatedAt: Date.now(),
  };
  await db.setMeta(BOARD_KEY, fresh);
  return fresh;
}

export async function saveBoard(board: KanbanBoard): Promise<void> {
  await db.setMeta(BOARD_KEY, { ...board, updatedAt: Date.now() });
}

export function newCard(partial: Partial<KanbanCard> & { title: string }): KanbanCard {
  const now = Date.now();
  return {
    id: `card-${now}-${Math.random().toString(36).slice(2, 8)}`,
    column: partial.column ?? 'backlog',
    position: partial.position ?? now,
    title: partial.title,
    description: partial.description ?? '',
    tag: partial.tag,
    priority: partial.priority,
    estimate: partial.estimate,
    source: partial.source ?? 'manual',
    parentGoal: partial.parentGoal,
    assignedAgentId: partial.assignedAgentId,
    createdAt: now,
    updatedAt: now,
  };
}

// ── AI planner ────────────────────────────────────────────────────────────────

export interface PlannedTask {
  title: string;
  description: string;
  estimate?: string;
  tag?: string;
  dependsOn?: string[];
}

export interface PlanRequest {
  goal: string;
  context?: string;        // optional extra context (existing cards, notes, etc.)
  constraints?: string;
  acceptance?: string;
  questions?: string;
  desiredCount?: number;   // soft hint, default 6-8
}

export interface PlanResult {
  tasks: PlannedTask[];
}

export interface PlanAssistRequest {
  goal: string;
  context?: string;
  constraints?: string;
  acceptance?: string;
  questions?: string;
  desiredCount?: number;
}

export interface PlanAssistResult {
  goal: string;
  context: string;
  constraints: string;
  acceptance: string;
  questions: string;
  desiredCount?: number;
}

export async function planTasks(req: PlanRequest): Promise<PlanResult> {
  const authMode = await getAnthropicAuthMode();
  const res = await fetch(apiUrl('/api/kanban/plan'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: req.goal,
      context: req.context,
      constraints: req.constraints,
      acceptance: req.acceptance,
      questions: req.questions,
      desiredCount: req.desiredCount,
      authMode,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Planner failed (${res.status})`);
  }
  return res.json();
}

export async function assistPlanBrief(req: PlanAssistRequest): Promise<PlanAssistResult> {
  const authMode = await getAnthropicAuthMode();
  const res = await fetch(apiUrl('/api/kanban/plan-assist'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, authMode }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Plan assist failed (${res.status})`);
  }
  return res.json();
}
