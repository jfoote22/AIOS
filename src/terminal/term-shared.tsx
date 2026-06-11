// Pieces shared between the Terminal tab (in-app slots) and torn-off popout
// terminal windows: xterm construction + clipboard wiring, the per-terminal
// folder bar, and small shell helpers. Behavior must stay identical in both
// hosts, so anything terminal-flavored that both render lives here.

import { FolderOpen, CornerDownLeft } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export const TERM_THEME = {
  background: '#09090b',
  foreground: '#e4e4e7',
  cursor: '#a5b4fc',
  cursorAccent: '#09090b',
  selectionBackground: '#3730a3aa',
  black: '#27272a', red: '#f87171', green: '#86efac', yellow: '#fcd34d',
  blue: '#93c5fd', magenta: '#f0abfc', cyan: '#67e8f9', white: '#e4e4e7',
  brightBlack: '#52525b', brightRed: '#fca5a5', brightGreen: '#bbf7d0',
  brightYellow: '#fde68a', brightBlue: '#bfdbfe', brightMagenta: '#f5d0fe',
  brightCyan: '#a5f3fc', brightWhite: '#fafafa',
};

/** Construct an xterm instance with the app's standard config, fit + weblinks
 *  addons, and clipboard wiring. */
export function createXterm(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
    fontSize: 12,
    cursorBlink: true,
    scrollback: 5000,
    theme: TERM_THEME,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  // Clipboard wiring. xterm has no built-in paste binding, so Ctrl+V (and
  // clipboard-injecting dictation like Wispr Flow) would otherwise emit a
  // literal ^V control char. Intercept here and paste real clipboard text.
  // Leave bare Ctrl+C alone so it still sends SIGINT; use Ctrl+Shift+C to copy.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      navigator.clipboard.readText().then(text => { if (text) term.paste(text); }).catch(() => {});
      return false;
    }
    if (mod && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      e.preventDefault();
      return false;
    }
    return true;
  });

  return { term, fit };
}

// Per-terminal folder bar: type/paste a path (Enter applies) or click the
// folder icon for the native picker. On a live session, applying issues a `cd`;
// on an empty slot it just sets the working dir for the next spawn.
export function FolderBar({
  dir, onDirChange, onApply, onBrowse, hasSession,
}: {
  dir: string;
  onDirChange: (dir: string) => void;
  onApply: (dir: string) => void;
  onBrowse: () => void;
  hasSession: boolean;
}) {
  return (
    <div className="h-7 px-1.5 flex items-center gap-1 border-b border-zinc-800/60 bg-zinc-900/30 shrink-0">
      <button
        onClick={onBrowse}
        title="Browse for a folder"
        className="p-1 rounded text-zinc-400 hover:text-indigo-300 hover:bg-zinc-800 shrink-0"
      >
        <FolderOpen className="w-3 h-3" />
      </button>
      <input
        value={dir}
        onChange={(e) => onDirChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onApply(dir); } }}
        placeholder={hasSession ? 'Folder to cd into…' : 'Folder to start in…'}
        spellCheck={false}
        className="flex-1 min-w-0 bg-zinc-950/60 border border-zinc-800 rounded px-1.5 py-0.5 text-[10px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
      />
      <button
        onClick={() => onApply(dir)}
        disabled={!dir.trim()}
        title={hasSession ? 'cd into this folder' : 'Use this folder on next launch'}
        className="p-1 rounded text-zinc-400 hover:text-indigo-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
      >
        <CornerDownLeft className="w-3 h-3" />
      </button>
    </div>
  );
}

// Build a shell-appropriate "change directory" command. cmd.exe needs `/d` to
// cross drives; PowerShell and POSIX shells take a quoted path directly.
export function cdCommand(shell: string, dir: string): string {
  const s = shell.toLowerCase();
  const quoted = `"${dir.replace(/"/g, '\\"')}"`;
  if (s.includes('cmd')) return `cd /d ${quoted}`;
  return `cd ${quoted}`;
}

export function labelFromShell(shell: string): string {
  const base = shell.split(/[\\/]/).pop() || 'shell';
  return base.replace(/\.exe$/i, '');
}

export function shortCwd(cwd: string): string {
  const norm = cwd.replace(/\\/g, '/');
  return norm.length > 32 ? '…' + norm.slice(-30) : norm;
}
