# READY-01 — Scaffold the Claude Code Tab (routing + empty shell)

**Column:** Ready
**Priority:** High
**Tag:** ui / scaffold
**Estimate:** Small (1–2 h)
**Source:** Expanded from [BACKLOG-01](../backlog/BACKLOG-01-claude-code-tab.md)
**Depends on:** Nothing — do this first.

---

## Problem Statement

There is no Claude Code tab in AIOS. Before any functionality can be built, the tab must
exist as a routable, mountable shell in the app so that subsequent cards can target it.

## Scope

**In:**
- Add `'claudecode'` to the `TabId` union in `src/components/Sidebar.tsx`
- Add the tab entry to `MAIN_TABS` with label `"Claude Code"` and icon `Bot` (already
  imported from `lucide-react` in `TerminalTab.tsx`; use the same icon or `Code2`)
- Create `src/tabs/ClaudeCodeTab.tsx` as an empty shell (header + placeholder body)
- Import and mount the tab as a `<TabPanel active={active === 'claudecode'}>` in
  `src/App.tsx`, following the existing pattern for all other tabs

**Out:**
- No real Claude communication yet
- No IPC handlers
- No session state

---

## Acceptance Criteria

1. Running `npm run dev` shows a "Claude Code" entry in the sidebar.
2. Clicking it renders a page with a header labeled "Claude Code" and a placeholder body
   (e.g. "Ready to wire up").
3. Navigating away and back keeps the tab mounted (hidden via `display:none` per the
   existing `TabPanel` pattern).
4. TypeScript compilation (`tsc --noEmit`) passes with no new errors.
5. No existing tabs are broken.

---

## Technical Notes

### Files to touch

| File | Change |
|------|--------|
| `src/components/Sidebar.tsx` | Add `'claudecode'` to `TabId` export; add entry in `MAIN_TABS` array |
| `src/App.tsx` | Import `ClaudeCodeTab`; add `<TabPanel active={active === 'claudecode'}>` |
| `src/tabs/ClaudeCodeTab.tsx` | **Create new** — empty shell component |

### Sidebar.tsx pattern to follow
```ts
// Current TabId (line 4):
export type TabId = 'deepdives' | 'snipping' | 'secondbrain' | 'terminal' | 'kanban' | 'hermes' | 'settings';
// Add:
export type TabId = 'deepdives' | 'snipping' | 'secondbrain' | 'terminal' | 'kanban' | 'hermes' | 'claudecode' | 'settings';

// MAIN_TABS entry to add (after 'terminal', before 'kanban' or after 'hermes'):
{ id: 'claudecode', label: 'Claude Code', icon: Bot },
// Bot is already used in TerminalTab.tsx; import it from 'lucide-react' in Sidebar.tsx
```

### ClaudeCodeTab.tsx starter shape
```tsx
import { Bot } from 'lucide-react';

export default function ClaudeCodeTab() {
  return (
    <div className="flex-1 flex flex-col">
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center gap-4 bg-zinc-900/10 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-zinc-800 rounded-md"><Bot className="w-4 h-4 text-indigo-400" /></div>
          <h1 className="text-sm font-bold uppercase tracking-widest text-zinc-100">Claude Code</h1>
        </div>
        <span className="text-[11px] text-zinc-500">Interactive Claude Code session</span>
      </header>
      <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
        Coming soon — wire up READY-02 next.
      </div>
    </div>
  );
}
```

---

## Dependencies

- None. This card is the foundation for READY-02, READY-03, and READY-04.
