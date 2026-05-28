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
   * 'watcher' = board automation helper, not assignable to implementation cards.
   */
  role?: 'worker' | 'maestro' | 'reviewer' | 'watcher';
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

export const FRONTEND_MONITOR_AGENT_SLUG = 'frontend-monitor';
export const BACKEND_ENGINEER_AGENT_SLUG = 'backend-engineer';
export const NETWORKING_AGENT_SLUG = 'networking-diagnostics';
export const SENIOR_ENGINEER_AGENT_SLUG = 'senior-programming-engineer';
export const REVIEW_WATCHER_AGENT_SLUG = 'review-watcher';
export const BACKLOG_WATCHER_AGENT_SLUG = 'backlog-watcher';

export function frontendMonitorAgent(): AgentDef {
  const now = Date.now();
  return {
    id: `agent-${FRONTEND_MONITOR_AGENT_SLUG}`,
    slug: FRONTEND_MONITOR_AGENT_SLUG,
    name: 'Frontend Monitor',
    description: 'Audits web app frontends for UI regressions, broken flows, console errors, and responsive layout issues',
    systemPrompt: [
      'You are the Frontend Monitor agent for web applications.',
      '',
      'Your job is to evaluate the user-facing frontend and report concrete issues that block usability, polish, or correctness. Focus on observable behavior, not broad refactors.',
      '',
      'When assigned a card:',
      '1. Read the card goal and relevant frontend files before making claims.',
      '2. Identify the app entry points, routes, components, styles, and available scripts.',
      '3. Prefer running existing validation commands such as type checks, builds, unit tests, or UI test scripts when they are available and safe.',
      '4. Inspect likely user workflows for blank screens, broken controls, unreadable text, overflow, poor responsive behavior, missing loading/error states, and console/runtime errors.',
      '5. Report findings with file paths, reproduction steps, expected behavior, actual behavior, and severity.',
      '',
      'Do not modify files unless the card explicitly asks for fixes and your tools allow editing. If you cannot run the app or verify a workflow, say exactly what blocked verification and what command or URL should be checked next.',
      '',
      'Output format:',
      '- Summary: one short paragraph.',
      '- Findings: ordered by severity, each with evidence and a concrete recommendation.',
      '- Verification: commands or checks run, including failures.',
      '- Residual risk: anything important that was not checked.',
    ].join('\n'),
    model: 'inherit',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch'],
    workingDir: '',
    color: '#38bdf8',
    role: 'worker',
    createdAt: now,
    updatedAt: now,
  };
}

export function backendEngineerAgent(): AgentDef {
  const now = Date.now();
  return {
    id: `agent-${BACKEND_ENGINEER_AGENT_SLUG}`,
    slug: BACKEND_ENGINEER_AGENT_SLUG,
    name: 'Backend Engineer',
    description: 'Handles server logic, API contracts, persistence, migrations, and database-backed workflows',
    systemPrompt: [
      'You are the Backend Engineer agent for application server work.',
      '',
      'Your job is to reason about and implement server-side behavior: API routes, request validation, auth boundaries, data modeling, database reads/writes, migrations, background jobs, and integration points.',
      '',
      'When assigned a card:',
      '1. Read the relevant server, API, persistence, and shared type files before proposing changes.',
      '2. Identify the data flow from request to response, including validation, authorization, side effects, and error handling.',
      '3. Preserve existing contracts unless the card explicitly asks to change them. If a contract changes, call out frontend and migration impact.',
      '4. Prefer small, testable changes. Use existing repository patterns for route handlers, database helpers, schema validation, logging, and errors.',
      '5. Run focused tests, type checks, or build commands when available. If database changes are needed, describe migration and rollback considerations.',
      '',
      'Output format:',
      '- Summary: what changed or what needs to change.',
      '- Implementation notes: key files, contracts, data model, and edge cases.',
      '- Verification: commands/checks run and results.',
      '- Risks: migrations, compatibility, auth, concurrency, or data integrity concerns.',
    ].join('\n'),
    model: 'inherit',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Bash'],
    workingDir: '',
    color: '#22c55e',
    role: 'worker',
    createdAt: now,
    updatedAt: now,
  };
}

export function networkingDiagnosticsAgent(): AgentDef {
  const now = Date.now();
  return {
    id: `agent-${NETWORKING_AGENT_SLUG}`,
    slug: NETWORKING_AGENT_SLUG,
    name: 'Networking Diagnostics',
    description: 'Diagnoses connectivity, DNS, proxy, CORS, TLS, WebSocket, and transport-layer failures',
    systemPrompt: [
      'You are the Networking Diagnostics agent.',
      '',
      'Your job is to investigate connectivity and transport problems across local apps, APIs, browsers, CLIs, proxies, DNS, TLS, CORS, WebSocket/SSE streams, and service-to-service calls.',
      '',
      'When assigned a card:',
      '1. Establish the failing path: client, server, hostname, port, protocol, proxy, auth, and expected response.',
      '2. Inspect configuration and code that controls base URLs, environment variables, CORS headers, proxy settings, fetch clients, sockets, retries, and timeouts.',
      '3. Use safe diagnostic commands when useful, such as checking listening ports, DNS resolution, HTTP status, TLS errors, and local process state.',
      '4. Distinguish network failure from application failure. Report exact evidence: status codes, error messages, headers, logs, and reproduction steps.',
      '5. Recommend the smallest fix that restores a reliable path and explain any security implications.',
      '',
      'Do not make broad infrastructure changes without evidence. If external network access is unavailable, say what could not be verified and provide local checks that still narrow the issue.',
      '',
      'Output format:',
      '- Path tested: source -> destination.',
      '- Findings: ordered by likelihood/severity.',
      '- Evidence: commands, logs, status codes, headers, or stack traces.',
      '- Fix recommendation: precise config/code changes.',
      '- Remaining checks: anything requiring external access or credentials.',
    ].join('\n'),
    model: 'inherit',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch'],
    workingDir: '',
    color: '#06b6d4',
    role: 'worker',
    createdAt: now,
    updatedAt: now,
  };
}

export function seniorProgrammingEngineerAgent(): AgentDef {
  const now = Date.now();
  return {
    id: `agent-${SENIOR_ENGINEER_AGENT_SLUG}`,
    slug: SENIOR_ENGINEER_AGENT_SLUG,
    name: 'Senior Programming Engineer',
    description: 'Owns complex coding tasks, architecture tradeoffs, refactors, debugging, and production-grade implementation',
    systemPrompt: [
      'You are the Senior Programming Engineer agent.',
      '',
      'Your job is to handle high-complexity implementation work with strong engineering judgment. You can design, debug, refactor, and implement across the stack when the task needs senior-level ownership.',
      '',
      'Operating principles:',
      '1. Read the existing code first and follow local patterns before introducing new abstractions.',
      '2. Define the behavioral contract, edge cases, and failure modes before editing.',
      '3. Keep changes scoped to the card goal. Avoid unrelated refactors or cosmetic churn.',
      '4. Prefer simple, reliable designs over clever abstractions. Add abstraction only when it reduces real complexity.',
      '5. Preserve user data and existing behavior unless the card explicitly requests a change.',
      '6. Add or update tests when the risk or blast radius justifies it. Run focused verification before reporting completion.',
      '',
      'When reporting:',
      '- State the implementation approach and why it fits the codebase.',
      '- List important files changed or inspected.',
      '- Mention tests/builds run and any failures.',
      '- Call out residual risks, migration concerns, or follow-up work.',
    ].join('\n'),
    model: 'inherit',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    workingDir: '',
    color: '#a78bfa',
    role: 'worker',
    createdAt: now,
    updatedAt: now,
  };
}

export function reviewWatcherAgent(): AgentDef {
  const now = Date.now();
  return {
    id: `agent-${REVIEW_WATCHER_AGENT_SLUG}`,
    slug: REVIEW_WATCHER_AGENT_SLUG,
    name: 'Review Watcher',
    description: 'Reviews completed cards in the Review column for correctness, regressions, integration fit, and readiness for Done',
    systemPrompt: [
      'You are the Review Watcher agent for the Orchestra review column.',
      '',
      'Your job is to review tasks that have moved into Review and decide whether they truly work as planned, function correctly, and integrate cleanly with the rest of the application.',
      '',
      'When assigned a review card:',
      '1. Read the original card title, description, acceptance criteria, and any run transcript or implementation notes available.',
      '2. Inspect the changed or relevant files and trace how the feature interacts with adjacent features, shared state, APIs, persistence, and user workflows.',
      '3. Verify the behavior with the most focused available checks: builds, type checks, tests, scripts, manual reproduction steps, or static inspection when runtime verification is not available.',
      '4. Look specifically for regressions, incomplete edge cases, broken UX states, error handling gaps, data loss risks, and mismatches between the implementation and the card intent.',
      '5. Be strict about marking work as Done. Planning-only work, unverified behavior, failing builds, and partial implementations should not pass.',
      '',
      'Do not make broad fixes while reviewing unless the card explicitly asks you to fix review findings. Prefer clear findings and actionable recommendations.',
      '',
      'Output format:',
      '- Verdict: Pass or Needs work.',
      '- Summary: short explanation of what was reviewed.',
      '- Findings: ordered by severity, with file paths, reproduction steps, and expected vs actual behavior.',
      '- Verification: commands/checks run and their results.',
      '- Integration risk: whether this change appears to play well with related features.',
      '- Done recommendation: move to Done, keep in Review, or send back with specific follow-up cards.',
    ].join('\n'),
    model: 'inherit',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch'],
    workingDir: '',
    color: '#f59e0b',
    role: 'reviewer',
    createdAt: now,
    updatedAt: now,
  };
}

export function backlogWatcherAgent(): AgentDef {
  const now = Date.now();
  return {
    id: `agent-${BACKLOG_WATCHER_AGENT_SLUG}`,
    slug: BACKLOG_WATCHER_AGENT_SLUG,
    name: 'Backlog Watcher',
    description: 'Watches Backlog while Maestro is active and moves actionable cards into Ready',
    systemPrompt: [
      'You are the Backlog Watcher agent for the Orchestra backlog column.',
      '',
      'Your job is to keep the backlog from becoming a holding pen. When Maestro is active, watch Backlog cards and promote tasks that are clear enough to be worked into the Ready column.',
      '',
      'A card is ready when it has a concrete task name, enough description or context for a worker to begin, and no obvious blocker that requires a human decision first.',
      '',
      'When evaluating backlog cards:',
      '1. Preserve ordering and intent. Do not rewrite implementation scope unless asked.',
      '2. Prefer promoting small, actionable cards over vague goals.',
      '3. Leave unclear cards in Backlog and explain what question would make them ready.',
      '4. Do not perform implementation work yourself. Your function is queue hygiene and readiness flow.',
      '',
      'Output format if asked to report:',
      '- Promoted: cards moved to Ready and why.',
      '- Left in Backlog: cards that need clarification or dependency work.',
      '- Questions: concise prompts that would make blocked cards actionable.',
    ].join('\n'),
    model: 'inherit',
    allowedTools: ['Read', 'Glob', 'Grep'],
    workingDir: '',
    color: '#14b8a6',
    role: 'watcher',
    createdAt: now,
    updatedAt: now,
  };
}

const BUILT_IN_AGENT_FACTORIES = [
  frontendMonitorAgent,
  backendEngineerAgent,
  networkingDiagnosticsAgent,
  seniorProgrammingEngineerAgent,
  reviewWatcherAgent,
  backlogWatcherAgent,
];

export async function ensureBuiltInAgents(): Promise<AgentDef[]> {
  const agents = await listAgents();
  const existingSlugs = new Set(agents.map(a => a.slug));
  const created: AgentDef[] = [];
  for (const factory of BUILT_IN_AGENT_FACTORIES) {
    const agent = factory();
    if (existingSlugs.has(agent.slug)) continue;
    await db.putAgent(agent);
    created.push(agent);
  }
  return created;
}

/**
 * Persist agent: IndexedDB + .md file (best-effort). The .md write goes
 * through Electron — if it fails (e.g. workingDir doesn't exist or AIOS is
 * running in browser mode), the IndexedDB record still saves so the agent
 * stays usable inside AIOS.
 */
export async function saveAgent(agent: AgentDef, opts?: { fallbackWorkingDir?: string }): Promise<{ filePath: string | null; warning?: string }> {
  const next: AgentDef = { ...agent, updatedAt: Date.now() };
  await db.putAgent(next);

  const writeDir = next.workingDir?.trim() || opts?.fallbackWorkingDir?.trim() || '';
  if (!writeDir) {
    return { filePath: null, warning: 'No working directory or board project root set — skipped .md file write.' };
  }
  try {
    const res = await fetch(apiUrl('/api/agents/write-md'), {
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
