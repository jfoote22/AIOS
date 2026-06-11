import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon, AlertCircle } from 'lucide-react';
import { createXterm, FolderBar, cdCommand, shortCwd, labelFromShell } from './term-shared';

// A torn-off terminal window. The pty already exists in the main process —
// it was spawned by the Terminal tab and detached when the user hit "pop out".
// This window adopts it: a fresh xterm instance is created here (DOM can't
// cross windows), the main process replays the scrollback buffer, and live
// output is routed to this window from then on. Sequence numbers stitch the
// replay and the live stream together: chunks with seq <= lastSeq are already
// in the buffer; anything newer arrives as a term:data event.
//
// Closing this window kills the session (main process auto-kills a pty when
// its owning webContents is destroyed) — same contract as closing the slot.

export default function TerminalPopout({ sessionId, initialLabel }: { sessionId: string; initialLabel?: string }) {
  const [label, setLabel] = useState(initialLabel || '');
  const [cwd, setCwd] = useState('');
  const [shell, setShell] = useState('');
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<{ shell: string; ended: boolean }>({ shell: '', ended: false });
  sessionRef.current.ended = ended;

  useEffect(() => {
    document.title = `${label || 'terminal'} — Terminal`;
  }, [label]);

  useEffect(() => {
    if (!window.aios?.term || !containerRef.current) {
      setError('Terminal bridge unavailable in this window.');
      return;
    }
    const api = window.aios.term;
    let disposed = false;

    const { term, fit } = createXterm();

    // Live output. Until the adopt round-trip finishes we don't know lastSeq,
    // so queue chunks and reconcile afterwards (drop anything the replayed
    // buffer already covers).
    let ready = false;
    let lastSeq = 0;
    let exitedEarly = false;
    const pending: Array<{ data: string; seq?: number }> = [];

    const offData = api.onData(({ id, data, seq }) => {
      if (id !== sessionId) return;
      if (!ready) { pending.push({ data, seq }); return; }
      if (seq !== undefined && seq <= lastSeq) return;
      term.write(data);
    });
    const offExit = api.onExit(({ id }) => {
      if (id !== sessionId) return;
      setEnded(true);
      if (!ready) { exitedEarly = true; return; }
      term.write('\r\n\x1b[2;3m[session ended]\x1b[0m');
    });

    term.open(containerRef.current);
    try { fit.fit(); } catch {}
    term.focus();

    term.onData(d => api.write(sessionId, d));
    term.onResize(({ cols, rows }) => api.resize(sessionId, cols, rows));

    api.adopt(sessionId)
      .then(({ shell: sh, cwd: dirNow, buffer, lastSeq: seq }) => {
        if (disposed) return;
        sessionRef.current.shell = sh;
        setShell(sh);
        setCwd(dirNow);
        setLabel(prev => prev || labelFromShell(sh));
        lastSeq = seq;
        if (buffer) term.write(buffer);
        ready = true;
        for (const chunk of pending) {
          if (chunk.seq !== undefined && chunk.seq <= lastSeq) continue;
          term.write(chunk.data);
        }
        pending.length = 0;
        if (exitedEarly) {
          term.write('\r\n\x1b[2;3m[session ended]\x1b[0m');
        } else {
          // Snap the pty to this window's dimensions (the old slot was likely
          // a different size).
          api.resize(sessionId, term.cols, term.rows);
        }
      })
      .catch((e: any) => {
        if (!disposed) setError(e?.message ?? String(e));
      });

    const onWindowResize = () => { try { fit.fit(); } catch {} };
    window.addEventListener('resize', onWindowResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onWindowResize);
      offData();
      offExit();
      try { term.dispose(); } catch {}
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Same folder bar contract as a slot in the Terminal tab: applying a path
  // issues a shell-appropriate `cd` on the live session.
  const applyDir = useCallback((rawDir: string) => {
    const d = rawDir.trim();
    setDir(d);
    if (!d || sessionRef.current.ended || !sessionRef.current.shell) return;
    window.aios?.term.write(sessionId, cdCommand(sessionRef.current.shell, d) + '\r');
    setCwd(d);
  }, [sessionId]);

  const browse = useCallback(async () => {
    if (!window.aios?.pickFolder) return;
    const picked = await window.aios.pickFolder({ title: 'Select working folder', defaultPath: dir.trim() || cwd || undefined });
    if (picked) applyDir(picked);
  }, [applyDir, dir, cwd]);

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-200 overflow-hidden">
      <header className="h-7 px-2 flex items-center gap-1.5 border-b border-zinc-800/60 bg-zinc-900/40 shrink-0">
        <TerminalIcon className="w-3 h-3 text-indigo-400" />
        <span className="text-[10px] text-zinc-300 truncate">{label || 'terminal'}</span>
        {cwd && <span className="text-[9px] text-zinc-600 truncate ml-1" title={cwd}>{shortCwd(cwd)}</span>}
        {ended && (
          <span className="ml-auto text-[9px] text-amber-400 uppercase tracking-wider">ended — close window to dismiss</span>
        )}
      </header>
      <FolderBar dir={dir} onDirChange={setDir} onApply={applyDir} onBrowse={browse} hasSession={!ended && !!shell} />
      {error && (
        <div className="px-3 py-1.5 text-[11px] text-red-300 bg-red-500/10 border-b border-red-500/30 flex items-center gap-1.5">
          <AlertCircle className="w-3 h-3 shrink-0" /> {error}
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 px-1.5 py-1" />
    </div>
  );
}
