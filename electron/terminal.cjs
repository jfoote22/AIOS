// Pty terminal manager. Owns the actual node-pty processes; the renderer
// drives them via IPC ("term:*" channels) and gets back streamed output.
//
// Lifetimes:
//   - one IPty per terminal pane in the UI
//   - all ptys are killed when the BrowserWindow they belong to closes
//   - if pty exits on its own, the renderer is notified so it can show a
//     dimmed "session ended" state and offer to respawn.

const { ipcMain } = require('electron');

let pty;
try {
  pty = require('node-pty');
} catch (e) {
  console.error('[terminal] node-pty failed to load:', e?.message);
  pty = null;
}

const isWindows = process.platform === 'win32';

// id -> { pty, cwd, shell }
const sessions = new Map();
// id -> webContents that owns the session (so we can route output back)
const ownership = new Map();

function defaultShell() {
  if (isWindows) return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

function genId() {
  return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function registerTerminalIpc() {
  // Spawn a new pty. Returns the id; the renderer should immediately listen
  // for "term:data" / "term:exit" events filtered on that id.
  ipcMain.handle('term:spawn', (event, opts = {}) => {
    if (!pty) {
      throw new Error('node-pty is not available. The native module failed to load.');
    }
    const id = genId();
    const shell = opts.shell || defaultShell();
    const args = Array.isArray(opts.args) ? opts.args : [];
    const cols = Number.isFinite(opts.cols) ? opts.cols : 80;
    const rows = Number.isFinite(opts.rows) ? opts.rows : 24;
    const cwd = opts.cwd && typeof opts.cwd === 'string' ? opts.cwd : process.env.HOME || process.env.USERPROFILE || process.cwd();
    const env = { ...process.env, ...(opts.env || {}), TERM: 'xterm-256color' };

    const p = pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env });
    sessions.set(id, { pty: p, cwd, shell });
    ownership.set(id, event.sender);

    p.onData((data) => {
      const sender = ownership.get(id);
      if (sender && !sender.isDestroyed()) sender.send('term:data', { id, data });
    });
    p.onExit(({ exitCode, signal }) => {
      const sender = ownership.get(id);
      if (sender && !sender.isDestroyed()) sender.send('term:exit', { id, exitCode, signal });
      sessions.delete(id);
      ownership.delete(id);
    });

    // Clean up if the owning window goes away
    event.sender.on('destroyed', () => killSession(id));

    return { id, shell, cwd };
  });

  ipcMain.handle('term:write', (_e, id, data) => {
    const s = sessions.get(id);
    if (s && typeof data === 'string') s.pty.write(data);
  });

  ipcMain.handle('term:resize', (_e, id, cols, rows) => {
    const s = sessions.get(id);
    if (!s) return;
    const c = Math.max(2, Math.floor(Number(cols) || 80));
    const r = Math.max(2, Math.floor(Number(rows) || 24));
    try { s.pty.resize(c, r); } catch (e) { /* pty may have just exited */ }
  });

  ipcMain.handle('term:kill', (_e, id) => killSession(id));

  ipcMain.handle('term:list', () => {
    return Array.from(sessions.entries()).map(([id, s]) => ({ id, cwd: s.cwd, shell: s.shell }));
  });

  ipcMain.handle('term:available', () => ({ available: !!pty, platform: process.platform }));
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.pty.kill(); } catch { /* ignore */ }
  sessions.delete(id);
  ownership.delete(id);
}

function killAll() {
  for (const id of Array.from(sessions.keys())) killSession(id);
}

module.exports = { registerTerminalIpc, killAll };
