# Backlog Card: Add a new way to interact with Codex directly

**ID:** codex-new-interaction
**Column:** Backlog → **Expanded** (see Ready cards below)
**Status:** Decomposed by Backlog Agent on 2026-05-26

---

## Original Request

> Add a new way to interact with Codex directly.

---

## Decomposition Notes

The original item was intentionally broad. After reviewing the codebase, two existing Codex
interaction modes were identified:

1. **Terminal PTY** — `codex` CLI spawned as a raw PTY in TerminalTab
2. **Hidden chat** — `/api/codex-agent/chat` only activates when OpenAI auth = "subscription"
   in ModelsTab; buried behind a settings toggle, not discoverable

The item was split into two independently shippable Ready cards, each addressing a distinct
interaction paradigm:

---

## Ready Cards Produced

| Card | File | What it adds |
|------|------|--------------|
| Dedicated Codex Chat Tab | `.claude/kanban/ready/codex-chat-tab.md` | A discoverable sidebar tab with a purpose-built chat UI for Codex |
| Codex Agent Runner | `.claude/kanban/ready/codex-agent-runner.md` | Codex SDK as an agent runtime for Orchestrator Kanban cards |

---

## Assumptions Made

- "Interact with Codex directly" means both (a) conversational chat and (b) agentic task execution
- The chat tab (card 1) is the most immediately discoverable improvement; the agent runner (card 2)
  unlocks Codex's full coding-agent capabilities in the Orchestrator
- Agentic mode with network access is out of scope for both cards (can be unlocked in a follow-up)
