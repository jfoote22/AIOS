// Skill definitions for the Orchestra tab's Skill creator.
//
// A "skill" is a reusable Claude Code Skill: a SKILL.md (with name/description
// frontmatter + an instructions body) living in its own folder so the bare
// `claude` CLI can discover it, plus any supporting files the author adds via
// the IDE editor. Like agents, each skill is persisted two ways:
//   1. SQLite record (AIOS-internal state: ids, timestamps, working dir).
//   2. `.claude/skills/<slug>/SKILL.md` on disk (written via the Electron API).
//
// This mirrors src/lib/agents.ts deliberately so the two creators behave the
// same way.

import * as db from './db';
import { apiUrl } from './apiBase';
import { getAnthropicAuthMode } from './authMode';

export interface SkillDef {
  id: string;
  slug: string;                // kebab-case, becomes the skill folder name
  name: string;
  description: string;         // what it does + WHEN to use it (trigger)
  instructions: string;        // the SKILL.md body (markdown allowed)
  allowedTools: string[];      // optional `allowed-tools` frontmatter
  workingDir: string;          // absolute path; folder lands in <workingDir>/.claude/skills/<slug>/
  color?: string;
  createdAt: number;
  updatedAt: number;
}

// Skills are read-leaning by default; the author opts into write/exec tools.
export const DEFAULT_SKILL_TOOLS: string[] = [];

// Same catalog the Agent builder uses, re-exported so the Skill builder can
// share the tool grid UI without importing from agents.ts.
export const SKILL_TOOL_CATALOG: Array<{ id: string; label: string; description: string; danger?: boolean }> = [
  { id: 'Read',      label: 'Read',      description: 'Read files by absolute path' },
  { id: 'Glob',      label: 'Glob',      description: 'File pattern matching' },
  { id: 'Grep',      label: 'Grep',      description: 'Content search (ripgrep)' },
  { id: 'Edit',      label: 'Edit',      description: 'Modify existing files', danger: true },
  { id: 'Write',     label: 'Write',     description: 'Create or overwrite files', danger: true },
  { id: 'Bash',      label: 'Bash',      description: 'Execute shell commands', danger: true },
  { id: 'WebFetch',  label: 'WebFetch',  description: 'Fetch URLs' },
  { id: 'WebSearch', label: 'WebSearch', description: 'Search the web' },
];

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'skill';
}

export function newSkill(partial: Partial<SkillDef> & { name: string }): SkillDef {
  const now = Date.now();
  const slug = partial.slug || slugify(partial.name);
  return {
    id: `skill-${now}-${Math.random().toString(36).slice(2, 8)}`,
    slug,
    name: partial.name,
    description: partial.description ?? '',
    instructions: partial.instructions ?? '',
    allowedTools: partial.allowedTools ?? [...DEFAULT_SKILL_TOOLS],
    workingDir: partial.workingDir ?? '',
    color: partial.color,
    createdAt: now,
    updatedAt: now,
  };
}

export const listSkills = () => db.getAllSkills<SkillDef>();

// Pub/sub so views holding a copy of the skill list can re-read when something
// mutates skills outside their own flow (parallels agents.ts).
const skillsChangedListeners = new Set<() => void>();
export function onSkillsChanged(fn: () => void): () => void {
  skillsChangedListeners.add(fn);
  return () => { skillsChangedListeners.delete(fn); };
}
export function emitSkillsChanged(): void {
  skillsChangedListeners.forEach(fn => { try { fn(); } catch { /* ignore */ } });
}

/** The absolute folder a skill's files live in, given a working dir. */
export function skillDir(workingDir: string, slug: string): string {
  const base = workingDir.replace(/[\\/]+$/, '');
  return `${base}/.claude/skills/${slug}`;
}

/**
 * Persist a skill: SQLite + SKILL.md (best-effort). If the .md write fails
 * (no working dir, browser mode, etc.) the SQLite record still saves so the
 * skill stays usable inside AIOS.
 */
export async function saveSkill(skill: SkillDef, opts?: { fallbackWorkingDir?: string }): Promise<{ filePath: string | null; warning?: string }> {
  const next: SkillDef = { ...skill, updatedAt: Date.now() };
  await db.putSkill(next);

  const writeDir = next.workingDir?.trim() || opts?.fallbackWorkingDir?.trim() || '';
  if (!writeDir) {
    return { filePath: null, warning: 'No working directory or board project root set — skipped SKILL.md write.' };
  }
  try {
    const res = await fetch(apiUrl('/api/skills/write-md'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: next.slug,
        workingDir: writeDir,
        markdown: toMarkdown(next),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return { filePath: null, warning: err.error || 'Failed to write SKILL.md file.' };
    }
    const j = await res.json();
    return { filePath: j.path ?? null };
  } catch (e: any) {
    return { filePath: null, warning: e?.message ?? String(e) };
  }
}

export async function deleteSkill(id: string, opts?: { alsoDeleteFiles?: boolean; workingDir?: string; slug?: string }): Promise<void> {
  await db.removeSkill(id);
  if (opts?.alsoDeleteFiles && opts.workingDir && opts.slug) {
    try {
      await fetch(apiUrl('/api/skills/delete-md'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: opts.slug, workingDir: opts.workingDir }),
      });
    } catch { /* best-effort */ }
  }
}

// ── Markdown serialization (Claude Code SKILL.md format) ─────────────────────

export function toMarkdown(s: SkillDef): string {
  const fm: string[] = ['---'];
  fm.push(`name: ${s.slug}`);
  if (s.description) fm.push(`description: ${escapeYaml(s.description)}`);
  if (s.allowedTools.length) fm.push(`allowed-tools: ${s.allowedTools.join(', ')}`);
  fm.push('---');
  fm.push('');
  fm.push(s.instructions.trim() || `# ${s.name}\n\nInstructions for the ${s.name} skill.`);
  fm.push('');
  return fm.join('\n');
}

function escapeYaml(str: string): string {
  const oneLine = str.replace(/\s+/g, ' ').trim();
  if (/[:#"'\\]/.test(oneLine)) return `"${oneLine.replace(/"/g, '\\"')}"`;
  return oneLine;
}

// ── AI-assisted drafting (mirrors agents.draftAgentField) ────────────────────

export type SkillDraftField = 'description' | 'instructions' | 'tools' | 'all';

export interface SkillDraftRequest {
  field: SkillDraftField;
  currentValue?: string;
  hint?: string;
  skill: Partial<SkillDef>;
}

export interface SkillDraftResult {
  field: SkillDraftField;
  value: string;
}

export async function draftSkillField(req: SkillDraftRequest): Promise<SkillDraftResult> {
  const authMode = await getAnthropicAuthMode();
  const res = await fetch(apiUrl('/api/skills/draft'), {
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
