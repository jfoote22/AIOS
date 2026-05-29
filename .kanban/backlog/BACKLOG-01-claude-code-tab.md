# BACKLOG-01 — Claude Code Tab

**Column:** Backlog → *expanded to Ready (see linked cards below)*
**Priority:** High
**Tag:** ui / claude
**Source:** Manual
**Created:** 2026-05-26

## Original Request

> "I want to set up a new tab that interacts with Claude Code directly like a CLI but then also has a user interface wrapped around it."

## Status: Expanded

This backlog item has been broken down into four independently shippable Ready cards:

| Card | Title | Effort |
|------|-------|--------|
| [READY-01](../ready/READY-01-claudecode-tab-scaffold.md) | Scaffold the Claude Code tab (routing + empty shell) | Small (1–2 h) |
| [READY-02](../ready/READY-02-claudecode-electron-ipc.md) | Electron IPC bridge for Claude Code subprocess | Medium (3–5 h) |
| [READY-03](../ready/READY-03-claudecode-chat-ui.md) | Structured chat UI — parse & render JSON stream | Medium (3–5 h) |
| [READY-04](../ready/READY-04-claudecode-session-panel.md) | Project & session context panel | Medium (2–3 h) |

## Assumptions Made

1. "Claude Code directly" means the `claude` CLI (Claude Code agent), invoked with
   `--output-format stream-json` so its NDJSON event stream can be parsed into a
   structured UI — not just raw terminal output.
2. The tab is a peer to the existing Terminal tab, not a replacement. The Terminal
   tab's "claude" quick-launch button (raw xterm) stays as-is.
3. A dedicated Electron child_process (not node-pty) is used for the JSON mode
   because there is no need for a real TTY, and stdio is cleaner to parse.
4. Session history is persisted via the existing `src/lib/db.ts` key-value store.
5. The `claude` binary must already be installed on the user's PATH. No auto-install
   logic is in scope.

## Open Questions

- Should the tab support multi-session split-panes (like TerminalTab) or single-session only for v1?
  → **Assumption: single-session for v1; split-pane is a future enhancement.**
- Should tool-call events (file reads/writes, bash) be rendered inline in the chat?
  → **Assumption: yes — show a collapsed tool-call badge with expand-on-click.**
- Does "UI wrapper" imply a file-tree panel, or just chat + context header?
  → **Assumption: project CWD picker + session controls + chat; no full file-tree for v1.**
