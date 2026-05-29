# Ready Card: Dedicated Codex Chat Tab

**ID:** codex-chat-tab
**Column:** Ready
**Priority:** Medium
**Estimate:** Small (2–4 h)
**Tag:** ui
**Source:** Decomposed from backlog item "Add a new way to interact with Codex directly"

---

## Problem Statement

Codex chat exists in AIOS today but is invisible: it only activates when the user navigates to
Models → OpenAI auth → toggles "ChatGPT subscription" — then the OpenAI slot in DeepDives silently
routes to `/api/codex-agent/chat`. There is no discoverable "talk to Codex" entry point.
Users who want to interact with Codex directly have to either find that hidden toggle or open a raw
terminal PTY. Neither is a good experience.

---

## Goal

Add a dedicated **Codex** tab to the sidebar that gives users a purpose-built chat UI backed by
the existing `/api/codex-agent/chat` endpoint — no settings toggle required.

---

## Scope

### In scope
- New `src/tabs/CodexTab.tsx` — standalone chat UI with Codex branding
- Update `src/components/Sidebar.tsx` — add `'codex'` to `TabId` union and `MAIN_TABS` array
- Update `src/App.tsx` — add `<TabPanel active={active === 'codex'}><CodexTab /></TabPanel>`
- Friendly error state when Codex CLI is not installed or not logged in

### Out of scope
- No new backend endpoint (reuses the existing `/api/codex-agent/chat` unchanged)
- No agentic/tool-use mode — chat only (`sandboxMode: 'read-only'`, no network, `approvalPolicy: 'never'`)
- No vault context injection (covered by a separate card if desired)
- No model picker (Codex auto-selects by plan; override via `AIOS_CODEX_MODEL` env var)

---

## Acceptance Criteria

1. A "Codex" entry appears in the sidebar nav (between Terminal and Orchestrator) with a `Sparkles`
   icon, visible in both expanded and collapsed states.
2. Clicking the Codex tab opens a dedicated chat view with:
   - Header: Sparkles icon + "Codex" title + subtitle "ChatGPT-powered coding assistant"
   - A chat input and streaming message list (consistent with DeepDives visual language)
3. The user can send a message and receive a streaming response via `/api/codex-agent/chat`.
4. When the server returns a 500 containing "codex" (CLI missing/not logged in), the UI shows an
   inline error: *"Codex CLI not found or not signed in. Run `codex login` in the Terminal tab
   first."* — not just a generic error toast.
5. The tab stays mounted when navigated away from (same `display:none` pattern as all other tabs
   in `App.tsx`), so an in-progress conversation is not lost.
6. No regression: the existing OpenAI subscription mode in DeepDives/SecondBrain continues to
   function (this card does not remove or modify that code path).

---

## Technical Notes

### Files to create
- `src/tabs/CodexTab.tsx`

### Files to modify
| File | Change |
|------|--------|
| `src/components/Sidebar.tsx` | Add `'codex'` to `TabId`; insert `{ id: 'codex', label: 'Codex', icon: Sparkles }` in `MAIN_TABS` before `'hermes'` |
| `src/App.tsx` | Import `CodexTab`; add `<TabPanel active={active === 'codex'}><CodexTab /></TabPanel>` |

### CodexTab implementation sketch
```tsx
// src/tabs/CodexTab.tsx
import { useChat } from 'ai/react';
import { apiUrl } from '../lib/apiBase';

// useChat({ api: apiUrl('/api/codex-agent/chat') })
// Render message list + input identical to the DeepDives chat minimal variant
// Error detection: if error.message?.toLowerCase().includes('codex') → show install tip
```

### Endpoint shape (no change needed)
`POST /api/codex-agent/chat` — `{ messages: [{role, content}] }`
Response: Vercel AI data-stream (`0:"delta"\n`, `d:{...}\n`). Already consumed by `useChat`.

### Sidebar icon
`Sparkles` is already imported in `Sidebar.tsx`'s peer files and available from `lucide-react`.
`Sparkles` is already used in TerminalTab for the codex quick-launch button — semantically consistent.

---

## Dependencies

- Existing `/api/codex-agent/chat` endpoint in `electron/api-server.cjs` (lines 689–764) — **no change**.
- User must have Codex CLI installed and signed in (`codex login`) for actual responses. The card
  itself does not require this; it handles the missing-CLI case gracefully.

---

## Open Questions / Assumptions

- **Assumption:** The Codex tab is chat-only (read-only mode). Agentic Codex capabilities are
  handled by the separate `codex-agent-runner` card.
- **Assumption:** A simple single-thread chat (no branching/threading like DeepDives) is sufficient
  for v1. Threading can be added later.
- **Open question:** Should the Codex tab share conversation history with the OpenAI subscription
  mode in DeepDives, or be fully independent? **Assumed independent** for simplicity.
