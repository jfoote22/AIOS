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
  createdAt: number;
  updatedAt: number;
}

export interface KanbanBoard {
  id: string;
  title: string;
  cards: KanbanCard[];
  updatedAt: number;
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
}

export interface PlanRequest {
  goal: string;
  context?: string;        // optional extra context (existing cards, notes, etc.)
  desiredCount?: number;   // soft hint, default 6-8
}

export interface PlanResult {
  tasks: PlannedTask[];
}

export async function planTasks(req: PlanRequest): Promise<PlanResult> {
  const res = await fetch(apiUrl('/api/kanban/plan'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: req.goal,
      context: req.context,
      desiredCount: req.desiredCount,
      authMode: getAnthropicAuthMode(),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Planner failed (${res.status})`);
  }
  return res.json();
}
