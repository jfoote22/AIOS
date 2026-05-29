# READY-02 — Electron IPC Bridge for Claude Code Subprocess

**Column:** Ready
**Priority:** High
**Tag:** electron / ipc
**Estimate:** Medium (3–5 h)
**Source:** Expanded from [BACKLOG-01](../backlog/BACKLOG-01-claude-code-tab.md)
**Depends on:** READY-01 (tab must exist; IPC can be wired independently, but the
renderer needs somewhere to call it from)

---

## Problem Statement

The renderer has no way to launch a `claude --output-format stream-json` process and
receive its structured NDJSON events. The existing `terminal.cjs` / `window.aios.term`
bridge uses node-pty (raw TTY) and is designed for xterm.js — it is not appropriate for
parsing line-delimited JSON. A dedicated IPC bridge for Claude Code is needed.

## Scope

**In:**
- Create `electron/claude-code.cjs` — a new Electron main-process module that:
  - Spawns `claude` (or a user-specified path) as a `child_process.spawn` (not node-pty)
    with `--output-format stream-json` and `--print` flags
  - Streams `stdout` line-by-line back to the renderer as `claudecode:data` IPC events
  - Streams `stderr` back as `claudecode:error` events
  - Notifies the renderer when the process exits via `claudecode:exit`
  - Supports sending a follow-up prompt to an interactive session (stdin write)
  - Handles `claudecode:spawn`, `claudecode:write`, `claudecode:kill`, `claudecode:available`
- Register the module in `electron/main.cjs` (follow how `terminal.cjs` is wired)
- Expose the API on `window.aios.claudeCode` in `electron/preload.cjs`

**Out:**
- No React UI changes (that is READY-03)
- No session history persistence (that is READY-04)
- No bundling or auto-installing the `claude` CLI

---

## Acceptance Criteria

1. `window.aios.claudeCode.available()` resolves to `{ available: true }` when `claude`
   is on the PATH, `{ available: false, reason: '...' }` otherwise.
2. `window.aios.claudeCode.spawn({ cwd, prompt })` starts a `claude` process and
   returns `{ id }`.
3. `window.aios.claudeCode.onData(cb)` fires for every complete JSON line emitted on
   stdout; the payload is `{ id, line }` where `line` is the raw NDJSON string.
4. `window.aios.claudeCode.onError(cb)` fires for stderr lines; payload `{ id, line }`.
5. `window.aios.claudeCode.onExit(cb)` fires when the process exits; payload
   `{ id, exitCode }`.
6. `window.aios.claudeCode.write(id, text)` sends a follow-up prompt to stdin.
7. `window.aios.claudeCode.kill(id)` terminates the process cleanly.
8. All sessions are killed when the BrowserWindow is destroyed (no zombie processes).
9. TypeScript types for `window.aios` in `src/electron.d.ts` are updated so the renderer
   can call these without `any` casts.

---

## Technical Notes

### New file: `electron/claude-code.cjs`

```js
const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const { which } = require('which'); // or inline PATH search

// id -> { proc, cwd }
const sessions = new Map();
const ownership = new Map();

function registerClaudeCodeIpc() {
  ipcMain.handle('claudecode:available', async () => {
    try {
      // Check that 'claude' exists on PATH
      await require('which')('claude');
      return { available: true };
    } catch {
      return { available: false, reason: "'claude' not found on PATH. Install Claude Code CLI first." };
    }
  });

  ipcMain.handle('claudecode:spawn', (event, { cwd, prompt, extraArgs = [] } = {}) => {
    const id = `cc-${Date.now().toString(36)}`;
    const args = ['--output-format', 'stream-json', '--print', ...extraArgs, prompt ?? ''];
    const proc = spawn('claude', args, {
      cwd: cwd ?? process.env.HOME ?? process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    sessions.set(id, { proc, cwd });
    ownership.set(id, event.sender);

    let buf = '';
    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        const sender = ownership.get(id);
        if (sender && !sender.isDestroyed()) sender.send('claudecode:data', { id, line });
      }
    });

    proc.stderr.on('data', chunk => {
      const sender = ownership.get(id);
      if (sender && !sender.isDestroyed())
        sender.send('claudecode:error', { id, line: chunk.toString() });
    });

    proc.on('close', code => {
      const sender = ownership.get(id);
      if (sender && !sender.isDestroyed()) sender.send('claudecode:exit', { id, exitCode: code });
      sessions.delete(id);
      ownership.delete(id);
    });

    event.sender.on('destroyed', () => killSession(id));
    return { id };
  });

  ipcMain.handle('claudecode:write', (_e, id, text) => {
    const s = sessions.get(id);
    if (s) s.proc.stdin.write(text + '\n');
  });

  ipcMain.handle('claudecode:kill', (_e, id) => killSession(id));
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.proc.kill(); } catch {}
  sessions.delete(id);
  ownership.delete(id);
}

function killAll() {
  for (const id of sessions.keys()) killSession(id);
}

module.exports = { registerClaudeCodeIpc, killAll };
```

### Changes to `electron/main.cjs`

```js
// At top of file, add:
const claudeCode = require('./claude-code.cjs');

// Inside app.whenReady() or wherever terminal is registered:
claudeCode.registerClaudeCodeIpc();

// Inside the window 'close' or app cleanup:
claudeCode.killAll();
```

### Changes to `electron/preload.cjs`

Add inside the `contextBridge.exposeInMainWorld('aios', { ... })` block:

```js
claudeCode: {
  available: () => ipcRenderer.invoke('claudecode:available'),
  spawn: (opts) => ipcRenderer.invoke('claudecode:spawn', opts),
  write: (id, text) => ipcRenderer.invoke('claudecode:write', id, text),
  kill: (id) => ipcRenderer.invoke('claudecode:kill', id),
  onData: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('claudecode:data', listener);
    return () => ipcRenderer.removeListener('claudecode:data', listener);
  },
  onError: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('claudecode:error', listener);
    return () => ipcRenderer.removeListener('claudecode:error', listener);
  },
  onExit: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('claudecode:exit', listener);
    return () => ipcRenderer.removeListener('claudecode:exit', listener);
  },
},
```

### Changes to `src/electron.d.ts`

Add the `claudeCode` property to the `aios` interface so the renderer has typed access.

### Dependency note

`which` package (already a transitive dependency via electron-builder tooling) can be
used to locate the `claude` binary; alternatively use a manual PATH search. If `which`
is not available, fallback: `require('child_process').execSync('where claude')` on Windows
or `execSync('which claude')` on Unix, wrapped in try/catch.

---

## Dependencies

- READY-01 must be complete so there is a tab component to test from.
- `claude` CLI must be installed on the developer's machine for manual verification.
