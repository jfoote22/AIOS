# READY-04 — Project & Session Context Panel

**Column:** Ready
**Priority:** Medium
**Tag:** ui / sessions
**Estimate:** Medium (2–3 h)
**Source:** Expanded from [BACKLOG-01](../backlog/BACKLOG-01-claude-code-tab.md)
**Depends on:** READY-01, READY-02, READY-03 (the chat UI it sits alongside)

---

## Problem Statement

Claude Code is a project-aware CLI — it reads from a working directory and maintains
session continuity. The tab needs a way for the user to:
1. Set the project directory (CWD) for each session
2. Start a fresh conversation
3. See and restore recent session history

Without this context panel, every session defaults to a fixed CWD and there is no way
to revisit what Claude did in prior sessions.

## Scope

**In:**
- A left-side panel (collapsible, ~260 px wide) inside `ClaudeCodeTab` containing:
  - **CWD picker**: displays current working directory; click opens Electron's
    `dialog.showOpenDialog` (directory select); persisted to `db.setMeta`
  - **New session button**: kills running process, clears chat, resets state
  - **Recent sessions list**: last 20 sessions stored in `db.ts`, showing timestamp,
    first user prompt (truncated), and exit status badge
  - Clicking a recent session loads its transcript (read-only) into the message thread
    with a "read-only — start new session to continue" banner
- Session records persisted to `db.ts` under key `claudecode:sessions`

**Out:**
- Full file tree / project explorer (future)
- Branch / git status display (future)
- Multi-project workspace management (future)
- Editing or re-running past sessions (future)

---

## Acceptance Criteria

1. The panel is visible by default on first load and can be collapsed with a toggle
   button (chevron icon), matching the sidebar collapse pattern in `Sidebar.tsx`.
2. The current CWD is displayed in a truncated path chip (e.g. `~/code/myapp`).
3. Clicking the CWD chip or a folder icon opens Electron's native directory picker.
   On confirm, the selected path is saved and used for the next spawned session.
4. Clicking "New session" immediately clears the message thread and kills any running
   process.
5. After each session ends (exit event), a record is saved to
   `db.setMeta('claudecode:sessions', [...])` with fields:
   `{ id, cwd, startedAt, endedAt, exitCode, firstPrompt, messageCount }`.
6. The recent sessions list shows the last 20 sessions, newest first, with:
   - Relative timestamp ("2 min ago", "yesterday")
   - First 40 chars of the user's first prompt
   - A green ✓ for exit 0 or red ✗ otherwise
7. Clicking a session entry loads its stored transcript into the thread in read-only
   mode (input bar is disabled with a note "Start a new session to continue").
8. The panel state (open/closed, last CWD) survives tab navigation (the component stays
   mounted per the existing `TabPanel` hide/show pattern).
9. Electron's `dialog.showOpenDialog` is invoked from the main process via a new IPC
   handler `claudecode:pick-dir` (add to `electron/claude-code.cjs` and preload).

---

## Technical Notes

### New IPC handler to add in `electron/claude-code.cjs`

```js
const { dialog } = require('electron');

ipcMain.handle('claudecode:pick-dir', async (event) => {
  const win = require('electron').BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select project directory',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});
```

Add `pickDir: () => ipcRenderer.invoke('claudecode:pick-dir')` to the `claudeCode`
object in `electron/preload.cjs`.

### Session record storage

Use the existing `src/lib/db.ts` API (same pattern as `kanban.ts`):

```ts
// src/lib/claudeCodeSessions.ts  (new small file)
import * as db from './db';

const KEY = 'claudecode:sessions';

export interface ClaudeSession {
  id: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  firstPrompt: string;
  messageCount: number;
  transcript: string;   // full serialized message thread (JSON string)
}

export async function loadSessions(): Promise<ClaudeSession[]> {
  return (await db.getMeta<ClaudeSession[]>(KEY)) ?? [];
}

export async function appendSession(s: ClaudeSession): Promise<void> {
  const existing = await loadSessions();
  const trimmed = [s, ...existing].slice(0, 50); // keep last 50
  await db.setMeta(KEY, trimmed);
}
```

### Panel layout inside `ClaudeCodeTab.tsx`

```tsx
<div className="flex-1 flex overflow-hidden min-h-0">
  {/* Left panel */}
  {panelOpen && (
    <aside className="w-64 shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-900/30">
      <CwdPicker cwd={cwd} onPick={handlePickDir} />
      <NewSessionButton onClick={handleNewSession} />
      <RecentSessionsList sessions={sessions} onSelect={handleLoadSession} />
    </aside>
  )}
  {/* Main chat area (already built in READY-03) */}
  <div className="flex-1 flex flex-col min-w-0">
    {/* MessageThread + InputBar from READY-03 */}
  </div>
</div>
```

### Relative timestamps

Use a simple local utility (no external lib needed):
```ts
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}
```

---

## Dependencies

- READY-01 — tab shell exists
- READY-02 — IPC bridge including the new `pick-dir` handler
- READY-03 — chat UI to embed in the right pane and pass session data to/from
