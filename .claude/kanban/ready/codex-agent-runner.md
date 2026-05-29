# Ready Card: Codex Agent Runner for Orchestrator Cards

**ID:** codex-agent-runner
**Column:** Ready
**Priority:** Medium
**Estimate:** Medium (4–8 h)
**Tag:** backend, ui
**Source:** Decomposed from backlog item "Add a new way to interact with Codex directly"

---

## Problem Statement

The Orchestrator's agent run system is Claude-only: every agent executes via
`@anthropic-ai/claude-agent-sdk` regardless of the task. Codex — OpenAI's coding agent — is
wired only as a chat interface and as a raw terminal PTY; it never gets to act as an autonomous
agent on Kanban cards. This leaves a gap for users who want Codex to drive coding tasks in the
Orchestrator with its own sandbox and approval model.

---

## Goal

Extend the Orchestrator so agents can be configured to run via the **Codex SDK** instead of the
Claude Agent SDK. An agent with `runnerType: 'codex'` will execute Kanban card tasks through
`@openai/codex-sdk`, streaming output to the run drawer in exactly the same format as today's
Claude runs.

---

## Scope

### In scope
- Add `runnerType?: 'claude' | 'codex'` to `AgentDef` in `src/lib/agents.ts`
- Update `newAgent()` default: `runnerType: 'claude'` (no change to existing agents)
- New `/api/codex-agent/run` endpoint in `electron/api-server.cjs`
- Update `startRun()` in `src/lib/runs.ts` to route to the new endpoint when `runnerType === 'codex'`
- Add a "Runner" selector toggle (Claude / Codex) in `src/components/AgentBuilder.tsx`
- When runner = Codex, disable the model picker (Codex auto-selects; `AIOS_CODEX_MODEL` env override)
- Cancel via the existing `/api/agents/run/cancel` endpoint (same `runId`-keyed AbortController map)

### Out of scope
- Codex-specific tool catalog — Codex tool access is controlled by `sandboxMode` at thread level,
  not a per-tool allowlist. The existing `allowedTools` array still drives the `sandboxMode`
  selection (see logic below) but the catalog itself is unchanged.
- `.codex/agents/` file persistence — Codex has no subagent markdown format; skip .md write for
  Codex-runner agents (or write a no-op stub).
- Network-enabled Codex runs (`networkAccessEnabled: true`) — out of scope for v1; sandboxed only.

---

## Acceptance Criteria

1. `AgentDef` has a `runnerType` field; all existing agents default to `'claude'` (backwards-compat).
2. AgentBuilder shows a "Runner" row with two options: `Claude` (default) and `Codex`.
   - Selecting Codex greys out / hides the Model picker (Codex auto-selects).
   - A tooltip explains: *"Requires Codex CLI installed and `codex login` completed."*
3. When a Codex-runner agent's ▶ Play button is pressed, the card moves to Running and the run
   drawer opens, streaming output from `/api/codex-agent/run`.
4. The streaming format is identical to Claude runs — same Vercel AI data-stream protocol
   (`0:"delta"\n`, `d:{...}\n`, `3:"error"\n`), same `parseRunStream` consumer in `KanbanTab.tsx`.
5. Shell commands and file changes emitted by Codex are formatted inline in the transcript
   (e.g. `→ shell(ls -la)` / `← output`), consistent with Claude tool annotation format.
6. Cancel (⬛ stop button) triggers `/api/agents/run/cancel` with the `runId` and aborts the
   Codex stream within ~1 s.
7. If Codex CLI is not installed/signed in, the run emits an error delta:
   *"Codex CLI not available. Install it and run `codex login`, then retry."*
   The card is left in `running` so the user can inspect and retry (same behavior as Claude failures).
8. No regression: existing Claude-runner agents continue to work.

---

## Technical Notes

### Files to modify

| File | Change |
|------|--------|
| `src/lib/agents.ts` | Add `runnerType?: 'claude' \| 'codex'` to `AgentDef`; update `newAgent()` default |
| `src/lib/runs.ts` | Update `startRun()` to POST to `/api/codex-agent/run` when `agent.runnerType === 'codex'`; pass `authMode` from `getOpenAIAuthMode()` |
| `src/components/AgentBuilder.tsx` | Add "Runner" toggle row; hide model picker when `runnerType === 'codex'` |
| `electron/api-server.cjs` | Add new `/api/codex-agent/run` POST handler |

### New backend endpoint: `/api/codex-agent/run`

Blueprint: the existing `/api/agents/run` handler (lines 452–593) and the existing
`/api/codex-agent/chat` handler (lines 689–764).

```js
// Sandbox mode derived from allowedTools (conservative default: read-only)
function codexSandboxMode(allowedTools) {
  const dangerous = new Set(['Bash', 'Edit', 'Write']);
  const hasDangerous = (allowedTools || []).some(t => dangerous.has(t));
  return hasDangerous ? 'full-auto' : 'read-only';
}

app.post('/api/codex-agent/run', async (req, res) => {
  const { runId, card, agent } = req.body || {};
  // 1. Register AbortController in activeRuns map (same map as /api/agents/run)
  // 2. Set response headers (same as agents/run)
  // 3. Build taskPrompt from card.title + card.description (same template)
  // 4. const { Codex } = await import('@openai/codex-sdk');
  //    const codex = new Codex();
  //    const thread = codex.startThread({
  //      sandboxMode: codexSandboxMode(agent.allowedTools),
  //      skipGitRepoCheck: true,
  //      networkAccessEnabled: false,
  //      webSearchEnabled: false,
  //      approvalPolicy: 'never',
  //      ...(cwd ? { workingDirectory: cwd } : {}),
  //      ...(codexModelOverride ? { model: codexModelOverride } : {}),
  //    });
  //    const streamed = await thread.runStreamed(taskPrompt);
  // 5. Consume streamed.events:
  //    - item.updated / item.completed with type 'agent_message' → text delta
  //    - shell_command events → format as "→ shell(<cmd>)\n"
  //    - file_change events → format as "→ edit(<path>)\n"
  //    - turn.completed → break
  //    - turn.failed / error → throw
  // 6. writeFinish('stop' or 'canceled')
});
```

### Codex SDK import
Already present in `package.json` (used by `/api/codex-agent/chat`):
`const { Codex } = await import('@openai/codex-sdk');`

### AgentDef backwards compatibility
`runnerType` is optional (`?`). All consumers that don't check it default to Claude behavior
(the runs.ts routing check: `agent.runnerType === 'codex'` is falsy for existing agents).

### toMarkdown() in agents.ts
For Codex-runner agents, the `.md` file write still happens but the frontmatter is purely
informational (no `runner:` field in Claude Code subagent format). Safe to leave as-is;
the Codex runner is AIOS-internal and doesn't affect the .md file consumers.

---

## Dependencies

- `@openai/codex-sdk` — already installed (used by `/api/codex-agent/chat`, lines 708–709).
- The `activeRuns` map in `api-server.cjs` is module-scoped; both `/api/agents/run` and the new
  `/api/codex-agent/run` must share the same map. Move the `const activeRuns = new Map()` to
  module scope above both handlers (it already is at line 450 — verify when adding the new handler
  that the new route references the same binding).
- `getOpenAIAuthMode()` is needed in `runs.ts` to pass `authMode` to the new endpoint; this is
  already imported in `authMode.ts` and follows the same pattern as `getAnthropicAuthMode()`.

---

## Open Questions / Assumptions

- **Assumption:** `sandboxMode` is derived from `allowedTools` (dangerous tools → `'full-auto'`,
  otherwise `'read-only'`). An explicit sandbox picker in AgentBuilder is a follow-up.
- **Assumption:** `networkAccessEnabled: false` and `webSearchEnabled: false` for v1 (no
  network-enabled Codex runs). Can be unlocked per-agent in a follow-up.
- **Open question:** Does `@openai/codex-sdk`'s `startThread` accept a `workingDirectory` option,
  or is it `cwd`? Check the SDK's TypeScript types at `node_modules/@openai/codex-sdk` before
  implementing. Use whatever field name the SDK types expose.
- **Open question:** Codex event types for shell/file operations — verify exact event type strings
  (`shell_command`, `file_change`) against the SDK before implementing the transcript formatter.
