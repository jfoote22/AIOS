import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Terminal as TerminalIcon, Plus, X, Bot, Sparkles, Zap, AlertCircle, ShieldOff,
  Square, Columns2, Columns3, Rows2, Grid2x2, FolderOpen, CornerDownLeft,
} from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

// Layout slots: each visible slot hosts at most one terminal session. The
// session ↔ slot binding is stable across layout changes, so a session in
// slot 2 stays in slot 2 even if you switch layouts and back. Hidden slots
// keep their session alive (display:none) so processes survive layout
// changes too.

type LayoutId = 'single' | 'cols-2' | 'cols-3' | 'rows-2' | 'grid-2x2';

const LAYOUTS: Record<LayoutId, { slots: number; gridCols: number; gridRows: number; label: string; Icon: React.ComponentType<{ className?: string }>; }> = {
  'single':   { slots: 1, gridCols: 1, gridRows: 1, label: 'Single',     Icon: Square },
  'cols-2':   { slots: 2, gridCols: 2, gridRows: 1, label: '2 columns',  Icon: Columns2 },
  'cols-3':   { slots: 3, gridCols: 3, gridRows: 1, label: '3 columns',  Icon: Columns3 },
  'rows-2':   { slots: 2, gridCols: 1, gridRows: 2, label: 'Stacked',    Icon: Rows2 },
  'grid-2x2': { slots: 4, gridCols: 2, gridRows: 2, label: '2 × 2 grid', Icon: Grid2x2 },
};

const MAX_SLOTS = 4; // largest layout

interface Session {
  id: string;          // pty id
  label: string;
  cwd: string;
  shell: string;
  term: Terminal;
  fit: FitAddon;
  unsubs: Array<() => void>;
  ended: boolean;
}

const THEME = {
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

export default function TerminalTab({ active }: { active: boolean }) {
  const [layout, setLayout] = useState<LayoutId>('single');
  // slotIndex (0..MAX_SLOTS-1) → Session | null
  const [slots, setSlots] = useState<Array<Session | null>>(() => new Array(MAX_SLOTS).fill(null));
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-slot working directory chosen via the folder bar. Persists across
  // (re)spawns in that slot, so a respawned session reuses the last folder.
  const [slotDirs, setSlotDirs] = useState<string[]>(() => new Array(MAX_SLOTS).fill(''));
  const containers = useRef<Array<HTMLDivElement | null>>(new Array(MAX_SLOTS).fill(null));
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const slotDirsRef = useRef(slotDirs);
  slotDirsRef.current = slotDirs;

  // Probe node-pty
  useEffect(() => {
    if (!window.aios?.term) { setAvailable(false); return; }
    window.aios.term.available()
      .then(r => setAvailable(r.available))
      .catch(() => setAvailable(false));
  }, []);

  // Auto-spawn the first session once the terminal tab is visible.
  useEffect(() => {
    if (active && available === true && !slotsRef.current[0]) spawnInSlot(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, available]);

  // Refit all visible terminals on window resize
  useEffect(() => {
    const onResize = () => refitVisible();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // Refit when layout changes (cells resize)
  useEffect(() => {
    requestAnimationFrame(refitVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // Cleanup all ptys on unmount
  useEffect(() => () => {
    for (const s of slotsRef.current) {
      if (!s) continue;
      for (const off of s.unsubs) off();
      try { s.term.dispose(); } catch {}
      window.aios?.term.kill(s.id).catch(() => {});
    }
  }, []);

  const refitVisible = useCallback(() => {
    const visibleCount = LAYOUTS[layout].slots;
    for (let i = 0; i < visibleCount; i++) {
      const s = slotsRef.current[i];
      if (!s) continue;
      try { s.fit.fit(); } catch {}
    }
  }, [layout]);

  const spawnInSlot = useCallback(async (slotIndex: number, initialCommand?: string, labelHint?: string) => {
    if (!window.aios?.term) return;
    setError(null);

    try {
      const term = new Terminal({
        fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
        fontSize: 12,
        cursorBlink: true,
        scrollback: 5000,
        theme: THEME,
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

      const chosenDir = slotDirsRef.current[slotIndex]?.trim() || undefined;
      const { id, shell, cwd } = await window.aios.term.spawn({ cols: 80, rows: 24, cwd: chosenDir });

      if (initialCommand) {
        setTimeout(() => window.aios?.term.write(id, `${initialCommand}\r`), 300);
      }

      const session: Session = {
        id,
        label: labelHint ?? labelFromShell(shell),
        cwd,
        shell,
        term,
        fit,
        unsubs: [],
        ended: false,
      };

      const offData = window.aios.term.onData(({ id: i, data }) => {
        if (i === id) term.write(data);
      });
      const offExit = window.aios.term.onExit(({ id: i }) => {
        if (i !== id) return;
        setSlots(prev => prev.map((s, idx) => (idx === slotIndex && s && s.id === id) ? { ...s, ended: true } : s));
        term.write('\r\n\x1b[2;3m[session ended]\x1b[0m');
      });
      session.unsubs.push(offData, offExit);

      term.onData(d => window.aios?.term.write(id, d));
      term.onResize(({ cols, rows }) => window.aios?.term.resize(id, cols, rows));

      setSlots(prev => {
        const next = prev.slice();
        next[slotIndex] = session;
        return next;
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);

  // Apply a folder to a slot. Stores it for future (re)spawns and, if a live
  // session exists, issues a shell-appropriate `cd` so the user never has to
  // type it. For an empty slot, the folder is just remembered for next spawn.
  const applyDir = useCallback((idx: number, rawDir: string) => {
    const dir = rawDir.trim();
    setSlotDirs(prev => { const n = prev.slice(); n[idx] = dir; return n; });
    if (!dir) return;
    const session = slotsRef.current[idx];
    if (session && !session.ended) {
      window.aios?.term.write(session.id, cdCommand(session.shell, dir) + '\r');
      setSlots(prev => prev.map((s, i) => (i === idx && s) ? { ...s, cwd: dir } : s));
    }
  }, []);

  // Native folder picker for a slot.
  const browseSlot = useCallback(async (idx: number) => {
    if (!window.aios?.pickFolder) return;
    const current = slotDirsRef.current[idx]?.trim() || slotsRef.current[idx]?.cwd || undefined;
    const picked = await window.aios.pickFolder({ title: 'Select working folder', defaultPath: current });
    if (picked) applyDir(idx, picked);
  }, [applyDir]);

  // Open xterm into its slot's container as soon as both exist. Re-fit on
  // layout-driven visibility changes.
  useEffect(() => {
    slots.forEach((s, idx) => {
      if (!s) return;
      const container = containers.current[idx];
      if (!container) return;
      // xterm.open is idempotent across same container; safe to call after
      // re-renders. We check whether the term already owns a child of the
      // container — if not, open.
      if (!container.firstChild) {
        try { s.term.open(container); } catch (e) { console.error('term.open failed', e); }
      }
    });
    requestAnimationFrame(refitVisible);
  }, [slots, layout, refitVisible]);

  const closeSlot = (idx: number) => {
    const s = slotsRef.current[idx];
    if (!s) return;
    for (const off of s.unsubs) off();
    try { s.term.dispose(); } catch {}
    window.aios?.term.kill(s.id).catch(() => {});
    setSlots(prev => { const n = prev.slice(); n[idx] = null; return n; });
    // Detach DOM child so a future spawn re-opens cleanly
    if (containers.current[idx]) containers.current[idx]!.innerHTML = '';
  };

  // Find the first empty visible slot for "+ new" quick-launch buttons
  const firstEmptyVisibleSlot = useMemo(() => {
    const count = LAYOUTS[layout].slots;
    for (let i = 0; i < count; i++) if (!slots[i]) return i;
    return -1;
  }, [slots, layout]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (available === null) {
    return (
      <div className="flex-1 flex flex-col">
        <Header layout={layout} setLayout={setLayout} onSpawn={() => {}} canSpawn={false} />
        <div className="flex-1 flex items-center justify-center text-[11px] text-zinc-600">Initializing terminal…</div>
      </div>
    );
  }
  if (!available) {
    return (
      <div className="flex-1 flex flex-col">
        <Header layout={layout} setLayout={setLayout} onSpawn={() => {}} canSpawn={false} />
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 space-y-3">
          <div className="p-3 rounded-full bg-red-500/10 border border-red-500/30">
            <AlertCircle className="w-5 h-5 text-red-300" />
          </div>
          <div>
            <p className="text-xs text-zinc-300">Terminal unavailable</p>
            <p className="text-[11px] text-zinc-500 mt-1 max-w-md leading-relaxed">
              <code>node-pty</code> failed to load. Rebuild against this Electron version with{' '}
              <code className="text-zinc-300">npx @electron/rebuild -f -w node-pty</code>, then restart AIOS.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const layoutCfg = LAYOUTS[layout];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Header
        layout={layout}
        setLayout={setLayout}
        canSpawn={firstEmptyVisibleSlot >= 0}
        onSpawn={(initialCommand, labelHint) => {
          if (firstEmptyVisibleSlot >= 0) spawnInSlot(firstEmptyVisibleSlot, initialCommand, labelHint);
        }}
      />

      {error && (
        <div className="px-3 py-1.5 text-[11px] text-red-300 bg-red-500/10 border-b border-red-500/30 flex items-center gap-1.5">
          <AlertCircle className="w-3 h-3" /> {error}
          <button onClick={() => setError(null)} className="ml-auto p-0.5"><X className="w-3 h-3" /></button>
        </div>
      )}

      {/* Grid of slots */}
      <div
        className="flex-1 min-h-0 grid gap-1 p-1 bg-zinc-950"
        style={{
          gridTemplateColumns: `repeat(${layoutCfg.gridCols}, minmax(0, 1fr))`,
          gridTemplateRows:    `repeat(${layoutCfg.gridRows}, minmax(0, 1fr))`,
        }}
      >
        {/* Visible slots */}
        {Array.from({ length: layoutCfg.slots }).map((_, idx) => (
          <Slot
            key={idx}
            slotIndex={idx}
            session={slots[idx]}
            dir={slotDirs[idx]}
            onDirChange={(dir) => setSlotDirs(prev => { const n = prev.slice(); n[idx] = dir; return n; })}
            onApplyDir={(dir) => applyDir(idx, dir)}
            onBrowse={() => browseSlot(idx)}
            containerRef={(el) => { containers.current[idx] = el; }}
            onSpawn={(initialCommand, labelHint) => spawnInSlot(idx, initialCommand, labelHint)}
            onClose={() => closeSlot(idx)}
          />
        ))}
      </div>

      {/* Hidden slots — keep their term DOM alive so processes don't die when
          the user shrinks the layout. They render outside the visible grid. */}
      <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }} aria-hidden="true">
        {Array.from({ length: MAX_SLOTS - layoutCfg.slots }).map((_, n) => {
          const idx = layoutCfg.slots + n;
          if (!slots[idx]) return null;
          return (
            <div key={`hidden-${idx}`} ref={(el) => { containers.current[idx] = el; }} />
          );
        })}
      </div>
    </div>
  );
}

// ── UI bits ──────────────────────────────────────────────────────────────────

function Header({
  layout, setLayout, canSpawn, onSpawn,
}: {
  layout: LayoutId;
  setLayout: (id: LayoutId) => void;
  canSpawn: boolean;
  onSpawn: (initialCommand?: string, labelHint?: string) => void;
}) {
  return (
    <header className="h-16 border-b border-zinc-800 px-6 flex items-center gap-4 bg-zinc-900/10 backdrop-blur-md shrink-0">
      <div className="flex items-center gap-2">
        <div className="p-1.5 bg-zinc-800 rounded-md"><TerminalIcon className="w-4 h-4 text-indigo-400" /></div>
        <h1 className="text-sm font-bold uppercase tracking-widest text-zinc-100">Terminal</h1>
      </div>

      <div className="flex items-center gap-1 bg-zinc-900/60 p-1 rounded-md border border-zinc-800">
        {(Object.keys(LAYOUTS) as LayoutId[]).map(id => {
          const L = LAYOUTS[id];
          const active = id === layout;
          return (
            <button
              key={id}
              onClick={() => setLayout(id)}
              title={L.label}
              className={`p-1.5 rounded transition-colors ${
                active ? 'bg-indigo-600/20 text-indigo-300' : 'text-zinc-500 hover:text-white'
              }`}
            >
              <L.Icon className="w-3.5 h-3.5" />
            </button>
          );
        })}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <NewButton icon={<Bot className="w-3 h-3" />}      label="claude" onClick={() => onSpawn('claude', 'claude')} disabled={!canSpawn} />
        <NewButton icon={<ShieldOff className="w-3 h-3" />} label="claude!" onClick={() => onSpawn('claude --dangerously-skip-permissions', 'claude (skip perms)')} disabled={!canSpawn} danger title="New Claude session with --dangerously-skip-permissions" />
        <NewButton icon={<Sparkles className="w-3 h-3" />} label="codex"  onClick={() => onSpawn('codex',  'codex')}  disabled={!canSpawn} />
        <NewButton icon={<Zap className="w-3 h-3" />}      label="grok"   onClick={() => onSpawn('grok',   'grok')}   disabled={!canSpawn} />
        <NewButton icon={<Plus className="w-3 h-3" />}     label="shell"  onClick={() => onSpawn()} disabled={!canSpawn} />
      </div>
    </header>
  );
}

function NewButton({ icon, label, onClick, disabled, danger, title }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'All visible slots are filled' : (title ?? `New ${label} session`)}
      className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed ${
        danger
          ? 'text-amber-300 hover:text-amber-200 hover:bg-amber-500/10'
          : 'text-zinc-300 hover:text-white hover:bg-zinc-800'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function Slot({
  slotIndex, session, dir, onDirChange, onApplyDir, onBrowse, containerRef, onSpawn, onClose,
}: {
  slotIndex: number;
  session: Session | null;
  dir: string;
  onDirChange: (dir: string) => void;
  onApplyDir: (dir: string) => void;
  onBrowse: () => void;
  containerRef: (el: HTMLDivElement | null) => void;
  onSpawn: (initialCommand?: string, labelHint?: string) => void;
  onClose: () => void;
}) {
  if (!session) {
    return (
      <div className="rounded-md border border-dashed border-zinc-800 bg-zinc-900/20 flex flex-col overflow-hidden">
        <FolderBar dir={dir} onDirChange={onDirChange} onApply={onApplyDir} onBrowse={onBrowse} hasSession={false} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-zinc-600">
            <div className="text-[10px] uppercase tracking-widest">Empty slot {slotIndex + 1}</div>
            <div className="flex gap-1">
              <SmallButton icon={<Bot className="w-3 h-3" />}      onClick={() => onSpawn('claude', 'claude')}>claude</SmallButton>
              <SmallButton icon={<ShieldOff className="w-3 h-3" />} onClick={() => onSpawn('claude --dangerously-skip-permissions', 'claude (skip perms)')} danger title="New Claude session with --dangerously-skip-permissions">claude!</SmallButton>
              <SmallButton icon={<Sparkles className="w-3 h-3" />} onClick={() => onSpawn('codex', 'codex')}>codex</SmallButton>
              <SmallButton icon={<Plus className="w-3 h-3" />}     onClick={() => onSpawn()}>shell</SmallButton>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 flex flex-col overflow-hidden">
      <header className="h-6 px-2 flex items-center gap-1.5 border-b border-zinc-800/60 bg-zinc-900/40 shrink-0">
        <TerminalIcon className="w-3 h-3 text-zinc-500" />
        <span className="text-[10px] text-zinc-400 truncate">{session.label}</span>
        <span className="text-[9px] text-zinc-600 truncate ml-1" title={session.cwd}>{shortCwd(session.cwd)}</span>
        {session.ended && (
          <span className="text-[9px] text-amber-400 uppercase tracking-wider">ended</span>
        )}
        <button
          onClick={onClose}
          title="Close session"
          className="ml-auto p-0.5 rounded text-zinc-600 hover:text-red-300 hover:bg-red-500/10"
        >
          <X className="w-2.5 h-2.5" />
        </button>
      </header>
      <FolderBar dir={dir} onDirChange={onDirChange} onApply={onApplyDir} onBrowse={onBrowse} hasSession={!session.ended} />
      <div ref={containerRef} className="flex-1 min-h-0 px-1.5 py-1" />
    </div>
  );
}

// Per-terminal folder bar: type/paste a path (Enter applies) or click the
// folder icon for the native picker. On a live session, applying issues a `cd`;
// on an empty slot it just sets the working dir for the next spawn.
function FolderBar({
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
function cdCommand(shell: string, dir: string): string {
  const s = shell.toLowerCase();
  const quoted = `"${dir.replace(/"/g, '\\"')}"`;
  if (s.includes('cmd')) return `cd /d ${quoted}`;
  return `cd ${quoted}`;
}

function SmallButton({ icon, onClick, children, danger, title }: { icon: React.ReactNode; onClick: () => void; children: React.ReactNode; danger?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1 px-1.5 py-1 rounded text-[10px] uppercase tracking-wider border ${
        danger
          ? 'text-amber-300 hover:text-amber-200 hover:bg-amber-500/10 border-amber-500/30'
          : 'text-zinc-400 hover:text-white hover:bg-zinc-800 border-zinc-800'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function labelFromShell(shell: string): string {
  const base = shell.split(/[\\/]/).pop() || 'shell';
  return base.replace(/\.exe$/i, '');
}

function shortCwd(cwd: string): string {
  const norm = cwd.replace(/\\/g, '/');
  return norm.length > 32 ? '…' + norm.slice(-30) : norm;
}
