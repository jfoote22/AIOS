import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { X, Square, Bot, Clock, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import type { AgentRun } from '../lib/runs';

export default function AgentRunDrawer({
  run, cardTitle, onClose, onCancel,
}: {
  run: AgentRun;
  cardTitle: string;
  onClose: () => void;
  onCancel?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on transcript growth
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [run.transcript]);

  const StatusIcon = STATUS_ICON[run.status];
  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.15 }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      className="absolute top-2 right-2 bottom-2 w-[460px] max-w-[60vw] bg-zinc-950/95 backdrop-blur-xl border border-zinc-800 rounded-xl shadow-2xl flex flex-col overflow-hidden z-20"
    >
      <header className="h-12 px-3 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <Bot className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">{run.agentSlug}</div>
          <div className="text-[12px] font-semibold text-zinc-100 truncate">{cardTitle}</div>
        </div>
        <div className={`flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${STATUS_BADGE[run.status]}`}>
          <StatusIcon className={`w-3 h-3 ${run.status === 'running' ? 'animate-spin' : ''}`} />
          {run.status}
        </div>
        {run.status === 'running' && onCancel && (
          <button onClick={onCancel} title="Cancel run" className="p-1 rounded text-zinc-400 hover:text-red-300 hover:bg-red-500/10">
            <Square className="w-3.5 h-3.5" />
          </button>
        )}
        <button onClick={onClose} className="p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800">
          <X className="w-4 h-4" />
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 text-[11px] text-zinc-200 leading-relaxed font-mono whitespace-pre-wrap break-words">
        {run.transcript || <span className="text-zinc-600 italic">Waiting for first output…</span>}
        {run.status === 'failed' && run.error && (
          <div className="mt-3 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 whitespace-pre-wrap">
            {run.error}
          </div>
        )}
      </div>

      <footer className="px-3 py-2 border-t border-zinc-800 bg-zinc-900/40 shrink-0 text-[10px] text-zinc-500 flex items-center gap-3">
        <span><Clock className="inline w-3 h-3 mr-0.5" />started {fmtTime(run.startedAt)}</span>
        {run.finishedAt && <span>finished {fmtTime(run.finishedAt)} ({fmtDuration(run.finishedAt - run.startedAt)})</span>}
      </footer>
    </motion.div>
  );
}

const STATUS_ICON = {
  queued:    Clock,
  running:   Loader2,
  succeeded: CheckCircle2,
  failed:    AlertCircle,
  canceled:  Square,
};

const STATUS_BADGE = {
  queued:    'bg-zinc-800 text-zinc-400 border-zinc-700',
  running:   'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
  succeeded: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  failed:    'bg-red-500/20 text-red-300 border-red-500/40',
  canceled:  'bg-amber-500/20 text-amber-300 border-amber-500/40',
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
