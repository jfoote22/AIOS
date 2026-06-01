// Project snapshot: save/load a whole board to a folder so you can point AIOS
// at a directory, build the board out, save it, and move on to the next one.
//
// The snapshot lives at `<projectRoot>/.aios/project.json` and bundles the
// board (cards + layout), the agents it uses, Maestro settings, and a light
// run-history summary. Loading merges agents by slug (non-destructive) and
// makes the loaded board the active board.

import * as db from './db';
import { saveBoard, type KanbanBoard } from './kanban';
import { listAgents, emitAgentsChanged, type AgentDef } from './agents';
import { saveMaestroState, loadMaestroState, type MaestroState } from './maestro';
import { listRuns, type AgentRun, type RunStatus } from './runs';
import { apiUrl } from './apiBase';

export const PROJECT_FORMAT = 'aios-project' as const;
export const PROJECT_VERSION = 1 as const;

/** A compact record of the most recent run for a card. Full transcripts are
 *  truncated to keep the project file portable. */
export interface RunSummary {
  cardId: string;
  cardTitle: string;
  agentSlug: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  transcriptTail?: string;
}

export interface AiosProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: number;
  board: KanbanBoard;
  agents: AgentDef[];
  maestro: MaestroState;
  runsSummary: RunSummary[];
}

const TRANSCRIPT_TAIL_CHARS = 2000;

/** Build the most-recent-run-per-card summary from the global run store. */
async function buildRunsSummary(board: KanbanBoard): Promise<RunSummary[]> {
  const cardIds = new Set(board.cards.map(c => c.id));
  const titleById = new Map(board.cards.map(c => [c.id, c.title]));
  const latest = new Map<string, AgentRun>();
  for (const run of await listRuns()) {
    if (!cardIds.has(run.cardId)) continue;
    const prev = latest.get(run.cardId);
    if (!prev || run.startedAt > prev.startedAt) latest.set(run.cardId, run);
  }
  return Array.from(latest.values()).map(r => ({
    cardId: r.cardId,
    cardTitle: titleById.get(r.cardId) ?? '',
    agentSlug: r.agentSlug,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    error: r.error,
    transcriptTail: r.transcript
      ? r.transcript.slice(-TRANSCRIPT_TAIL_CHARS)
      : undefined,
  }));
}

/** Assemble the full snapshot for the given board. */
export async function buildProjectSnapshot(board: KanbanBoard): Promise<AiosProjectFile> {
  const [agents, maestro, runsSummary] = await Promise.all([
    listAgents(),
    loadMaestroState(),
    buildRunsSummary(board),
  ]);
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: Date.now(),
    board,
    agents,
    maestro,
    runsSummary,
  };
}

export interface SaveResult { path: string; }

/** Write the snapshot to `<board.projectRoot>/.aios/project.json`. */
export async function saveProject(board: KanbanBoard): Promise<SaveResult> {
  const projectRoot = board.projectRoot?.trim();
  if (!projectRoot) throw new Error('No project folder set — pick one before saving.');
  const project = await buildProjectSnapshot(board);
  const res = await fetch(apiUrl('/api/project/save'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot, project }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || 'Failed to save project.');
  }
  const j = await res.json();
  return { path: j.path };
}

/** Read the snapshot at `<projectRoot>/.aios/project.json`, or null if none. */
export async function loadProjectFromFolder(projectRoot: string): Promise<AiosProjectFile | null> {
  const root = projectRoot.trim();
  if (!root) return null;
  const res = await fetch(apiUrl('/api/project/load'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot: root }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || 'Failed to load project.');
  }
  const j = await res.json();
  if (!j.exists || !j.project) return null;
  const project = j.project as AiosProjectFile;
  if (project.format !== PROJECT_FORMAT) {
    throw new Error('That folder has a project.json, but it is not an AIOS project file.');
  }
  return project;
}

/**
 * Apply a loaded project: merge its agents into the global store by slug
 * (update matches in place, add new ones — never deletes), remap the board's
 * agent references to the resolved local ids, persist Maestro settings, and
 * make the board the active board. Returns the board to swap into state.
 *
 * `projectRoot` is the folder we loaded from; the board's projectRoot is
 * pinned to it so subsequent saves land in the same place.
 */
export async function applyProject(
  project: AiosProjectFile,
  projectRoot: string,
): Promise<KanbanBoard> {
  // Merge agents by slug, building old-id -> resolved-id remap as we go.
  const existing = await listAgents();
  const bySlug = new Map(existing.map(a => [a.slug, a]));
  const idMap = new Map<string, string>();
  for (const incoming of project.agents ?? []) {
    const match = bySlug.get(incoming.slug);
    if (match) {
      // Keep the existing record's identity to respect the unique slug index
      // and avoid orphaning references from other state.
      const merged: AgentDef = { ...incoming, id: match.id, createdAt: match.createdAt, updatedAt: Date.now() };
      await db.putAgent(merged);
      idMap.set(incoming.id, match.id);
    } else {
      const added: AgentDef = { ...incoming, updatedAt: Date.now() };
      await db.putAgent(added);
      idMap.set(incoming.id, incoming.id);
    }
  }
  emitAgentsChanged();

  const remap = (id?: string) => (id ? idMap.get(id) ?? id : id);

  const board: KanbanBoard = {
    ...project.board,
    projectRoot,
    cards: project.board.cards.map(c => ({ ...c, assignedAgentId: remap(c.assignedAgentId) })),
  };

  const maestro: MaestroState = {
    ...project.maestro,
    reviewerAgentId: remap(project.maestro?.reviewerAgentId),
  };
  await saveMaestroState(maestro);
  await saveBoard(board);
  return board;
}
