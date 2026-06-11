// Pty terminal manager. Owns the actual node-pty processes; the renderer
// drives them via IPC ("term:*" channels) and gets back streamed output.
//
// Lifetimes:
//   - one IPty per terminal pane in the UI
//   - each pty is killed when the BrowserWindow that currently owns it closes
//   - ownership can move between windows ("term:adopt") — that's how a
//     terminal is torn off into its own popout window. The pty itself never
//     restarts; only which webContents receives its output changes.
//   - if pty exits on its own, the renderer is notified so it can show a
//     dimmed "session ended" state and offer to respawn.

const { ipcMain } = require('electron');

let pty;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (e) {
  console.error('[terminal] node-pty failed to load:', e?.message);
  ptyLoadError = e;
  pty = null;
}

const isWindows = process.platform === 'win32';

// id -> { pty, cwd, shell, buf: [{seq, data}], bufLen, seq }
const sessions = new Map();
// id -> webContents that owns the session (so we can route output back)
const ownership = new Map();

// Scrollback kept per session so a window that adopts an existing pty (popout)
// can replay what it missed. Chunks carry a sequence number; "term:data" sends
// the same number, so the adopting renderer can stitch buffer + live stream
// together without gaps or duplicates.
const MAX_BUFFER_BYTES = 512 * 1024;

function pushBuffer(s, seq, data) {
  s.buf.push({ seq, data });
  s.bufLen += data.length;
  while (s.bufLen > MAX_BUFFER_BYTES && s.buf.length > 1) {
    s.bufLen -= s.buf.shift().data.length;
  }
}

// Kill the session when its owning webContents goes away — but only if it
// still owns it (it may have been adopted by a popout window since).
function attachOwnerCleanup(id, sender) {
  sender.on('destroyed', () => {
    if (ownership.get(id) === sender) killSession(id);
  });
}

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
      throw new Error(`node-pty is not available. ${ptyLoadError?.message ?? 'The native module failed to load.'}`);
    }
    const id = genId();
    const shell = opts.shell || defaultShell();
    const args = Array.isArray(opts.args) ? opts.args : [];
    const cols = Number.isFinite(opts.cols) ? opts.cols : 80;
    const rows = Number.isFinite(opts.rows) ? opts.rows : 24;
    const cwd = opts.cwd && typeof opts.cwd === 'string' ? opts.cwd : process.env.HOME || process.env.USERPROFILE || process.cwd();
    const env = { ...process.env, ...(opts.env || {}), TERM: 'xterm-256color' };

    let p;
    try {
      p = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        ...(isWindows ? { useConptyDll: true } : {}),
      });
    } catch (e) {
      console.error('[terminal] failed to spawn pty:', e);
      throw new Error(`Failed to start terminal: ${e?.message ?? String(e)}`);
    }
    const session = { pty: p, cwd, shell, buf: [], bufLen: 0, seq: 0 };
    sessions.set(id, session);
    ownership.set(id, event.sender);

    p.onData((data) => {
      const seq = ++session.seq;
      pushBuffer(session, seq, data);
      const sender = ownership.get(id);
      if (sender && !sender.isDestroyed()) sender.send('term:data', { id, data, seq });
    });
    p.onExit(({ exitCode, signal }) => {
      const sender = ownership.get(id);
      if (sender && !sender.isDestroyed()) sender.send('term:exit', { id, exitCode, signal });
      sessions.delete(id);
      ownership.delete(id);
    });

    attachOwnerCleanup(id, event.sender);

    return { id, shell, cwd };
  });

  // Transfer a live session to the calling webContents (popout window).
  // Atomically reassigns ownership and snapshots the scrollback, so every
  // chunk is either in the returned buffer (seq <= lastSeq) or delivered as a
  // "term:data" event to the new owner (seq > lastSeq) — never both, never
  // neither.
  ipcMain.handle('term:adopt', (event, id) => {
    const s = sessions.get(id);
    if (!s) throw new Error('Terminal session not found — it may have already ended.');
    ownership.set(id, event.sender);
    attachOwnerCleanup(id, event.sender);
    return {
      id,
      shell: s.shell,
      cwd: s.cwd,
      buffer: s.buf.map(c => c.data).join(''),
      lastSeq: s.seq,
    };
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

  ipcMain.handle('term:available', () => ({ available: !!pty, platform: process.platform, error: ptyLoadError?.message ?? null }));
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
