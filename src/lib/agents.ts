// Agent definitions for the Kanban orchestration tab.
//
// Each agent is persisted two ways:
//   1. IndexedDB record (for AIOS-internal state: assignments, run history,
//      timestamps, IDs).
//   2. `.claude/agents/<slug>.md` file in the agent's working directory,
//      with Claude Code subagent frontmatter, so the same agent is usable
//      from the bare `claude` CLI too.
//
// The .md write happens via the Electron API server, since the renderer
// can't touch the filesystem directly.

import * as db from './db';
import { apiUrl } from './apiBase';
import { getAnthropicAuthMode } from './authMode';

export interface AgentDef {
  id: string;
  slug: string;                // kebab-case, becomes the .md filename
  name: string;
  description: string;         // short, shown in tooltips / pickers
  systemPrompt: string;        // the full agent instructions
  model: string;               // "inherit" | a specific model id like "claude-sonnet-4-6"
  allowedTools: string[];      // e.g. ["Read","Edit","Bash","Glob","Grep"]
  workingDir: string;          // absolute path; .md file lands in <workingDir>/.claude/agents/
  /** Color hint for board cards / pickers; falls back to a hash of the slug. */
  color?: string;
  /**
   * Orchestra role. 'worker' (default) = assignable to cards. 'maestro' = the
   * board conductor agent (special — filtered out of worker dropdowns).
   * 'reviewer' = used for the Reviewer-agent review mode.
   */
  role?: 'worker' | 'maestro' | 'reviewer';
  createdAt: number;
  updatedAt: number;
}

// Conservative defaults. Read-only-ish tools so a fresh agent can't write
// or shell out until the user explicitly opts in.
export const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep'];

export const TOOL_CATALOG: Array<{ id: string; label: string; description: string; danger?: boolean }> = [
  { id: 'Read',         label: 'Read',         description: 'Read files by absolute path' },
  { id: 'Glob',         label: 'Glob',         description: 'File pattern matching' },
  { id: 'Grep',         label: 'Grep',         description: 'Content search (ripgrep)' },
  { id: 'Edit',         label: 'Edit',         description: 'Modify existing files', danger: true },
  { id: 'Write',        label: 'Write',        description: 'Create or overwrite files', danger: true },
  { id: 'Bash',         label: 'Bash',         description: 'Execute shell commands', danger: true },
  { id: 'WebFetch',     label: 'WebFetch',     description: 'Fetch URLs' },
  { id: 'WebSearch',    label: 'WebSearch',    description: 'Search the web' },
];

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

export function newAgent(partial: Partial<AgentDef> & { name: string }): AgentDef {
  const now = Date.now();
  const slug = partial.slug || slugify(partial.name);
  return {
    id: `agent-${now}-${Math.random().toString(36).slice(2, 8)}`,
    slug,
    name: partial.name,
    description: partial.description ?? '',
    systemPrompt: partial.systemPrompt ?? '',
    model: partial.model ?? 'inherit',
    allowedTools: partial.allowedTools ?? [...DEFAULT_TOOLS],
    workingDir: partial.workingDir ?? '',
    color: partial.color,
    createdAt: now,
    updatedAt: now,
  };
}

export const listAgents = () => db.getAllAgents<AgentDef>();

/**
 * Persist agent: IndexedDB + .md file (best-effort). The .md write goes
 * through Electron — if it fails (e.g. workingDir doesn't exist or AIOS is
 * running in browser mode), the IndexedDB record still saves so the agent
 * stays usable inside AIOS.
 */
export async function saveAgent(agent: AgentDef): Promise<{ filePath: string | null; warning?: string }> {
  const next: AgentDef = { ...agent, updatedAt: Date.now() };
  await db.putAgent(next);

  if (!next.workingDir) {
    return { filePath: null, warning: 'No working directory set — skipped .md file write.' };
  }
  try {
    const res = await fetch(apiUrl('/api/agents/write-md'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: next.slug,
        workingDir: next.workingDir,
        markdown: toMarkdown(next),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return { filePath: null, warning: err.error || 'Failed to write .md file.' };
    }
    const j = await res.json();
    return { filePath: j.path ?? null };
  } catch (e: any) {
    return { filePath: null, warning: e?.message ?? String(e) };
  }
}

export async function deleteAgent(id: string, opts?: { alsoDeleteFile?: boolean; workingDir?: string; slug?: string }): Promise<void> {
  await db.removeAgent(id);
  if (opts?.alsoDeleteFile && opts.workingDir && opts.slug) {
    try {
      await fetch(apiUrl('/api/agents/delete-md'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: opts.slug, workingDir: opts.workingDir }),
      });
    } catch { /* best-effort */ }
  }
}

// ── Markdown serialization (Claude Code subagent format) ─────────────────────

export function toMarkdown(a: AgentDef): string {
  const fm: string[] = ['---'];
  fm.push(`name: ${a.slug}`);
  if (a.description) fm.push(`description: ${escapeYaml(a.description)}`);
  if (a.model && a.model !== 'inherit') fm.push(`model: ${a.model}`);
  if (a.allowedTools.length) fm.push(`tools: ${a.allowedTools.join(', ')}`);
  fm.push('---');
  fm.push('');
  fm.push(a.systemPrompt.trim() || `You are the ${a.name} agent.`);
  fm.push('');
  return fm.join('\n');
}

function escapeYaml(s: string): string {
  // Single-line description: collapse newlines, wrap in quotes if needed
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (/[:#"'\\]/.test(oneLine)) return `"${oneLine.replace(/"/g, '\\"')}"`;
  return oneLine;
}

// ── AI-assisted drafting ─────────────────────────────────────────────────────
// Each "✨ ask Claude" button on the builder form hits this endpoint to fill
// or refine a single field. The endpoint reuses the user's existing Anthropic
// auth (subscription or API key) — same as the kanban planner.

export type DraftField = 'description' | 'systemPrompt' | 'tools' | 'all';

export interface DraftRequest {
  field: DraftField;
  currentValue?: string;   // existing field value (empty = generate from scratch)
  hint?: string;           // free-text instruction from the user
  agent: Partial<AgentDef>; // the rest of the form for context
}

export interface DraftResult {
  field: DraftField;
  value: string;            // for 'tools' this is JSON-stringified array
  rationale?: string;       // short note shown as a transient toast
}

export async function draftAgentField(req: DraftRequest): Promise<DraftResult> {
  const authMode = await getAnthropicAuthMode();
  const res = await fetch(apiUrl('/api/agents/draft'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, authMode }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Draft failed (${res.status})`);
  }
  return res.json();
}
