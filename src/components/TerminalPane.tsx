import { Terminal as TerminalIcon } from 'lucide-react';

// Placeholder for Phase 1B. Will be xterm.js + node-pty, multiple shells
// with "+ claude" / "+ codex" quick-launches and per-pane cwd.
export default function TerminalPane() {
  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <header className="h-10 px-3 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <TerminalIcon className="w-3.5 h-3.5 text-zinc-500" />
        <span className="text-[11px] uppercase tracking-widest text-zinc-400">Terminal</span>
        <span className="ml-auto text-[10px] text-zinc-600">Phase 1B</span>
      </header>
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 space-y-3">
        <div className="p-3 rounded-full bg-zinc-900 border border-zinc-800">
          <TerminalIcon className="w-6 h-6 text-zinc-700" />
        </div>
        <div>
          <p className="text-xs text-zinc-400">Live terminal coming next</p>
          <p className="text-[11px] text-zinc-600 mt-1 max-w-xs leading-relaxed">
            xterm.js + node-pty with quick-launch for{' '}
            <code className="text-zinc-400">claude</code> and{' '}
            <code className="text-zinc-400">codex</code> sessions.
          </p>
        </div>
      </div>
    </div>
  );
}
