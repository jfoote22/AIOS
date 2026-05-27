import { UserCheck, Sparkles, ShieldCheck, MousePointer2, Zap, Timer, Play } from 'lucide-react';
import type { MaestroState, ReviewMode, Cadence } from '../lib/maestro';
import type { AgentDef } from '../lib/agents';

export default function MaestroControls({
  state, agents, onChange, onTickNow,
}: {
  state: MaestroState;
  agents: AgentDef[];        // full list — we filter for reviewer dropdown
  onChange: (next: MaestroState) => void;
  onTickNow: () => void;
}) {
  const reviewerCandidates = agents.filter(a => a.role !== 'maestro');

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/30 shrink-0 flex-wrap">
          {/* Review mode */}
          <Segmented
            label="Review"
            value={state.reviewMode}
            onChange={(v) => onChange({ ...state, reviewMode: v as ReviewMode })}
            options={[
              { value: 'human', label: 'Human', icon: UserCheck, tip: 'Cards stop at Review for your approval.' },
              { value: 'self', label: 'Self', icon: Sparkles, tip: 'Maestro grades its own runs and moves them to Done.' },
              { value: 'reviewer-agent', label: 'Agent', icon: ShieldCheck, tip: 'A separate reviewer agent grades work.' },
            ]}
          />

          {state.reviewMode === 'reviewer-agent' && (
            <select
              value={state.reviewerAgentId ?? ''}
              onChange={(e) => onChange({ ...state, reviewerAgentId: e.target.value || undefined })}
              title="Reviewer agent"
              className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[10px] text-zinc-200 focus:outline-none focus:border-indigo-500/60"
            >
              <option value="">(pick reviewer)</option>
              {reviewerCandidates.map(a => (
                <option key={a.id} value={a.id}>{a.name || a.slug}</option>
              ))}
            </select>
          )}

          {/* Cadence */}
          <Segmented
            label="Cadence"
            value={state.cadence}
            onChange={(v) => onChange({ ...state, cadence: v as Cadence })}
            options={[
              { value: 'manual', label: 'Manual', icon: MousePointer2, tip: 'Tick only when you press the button.' },
              { value: 'on-change', label: 'On change', icon: Zap, tip: 'Tick on new card and on card finish.' },
              { value: 'heartbeat', label: 'Heartbeat', icon: Timer, tip: 'Tick on a fixed interval.' },
            ]}
          />

          {state.cadence === 'heartbeat' && (
            <div className="flex items-center gap-1 text-[10px] text-zinc-400">
              <input
                type="number" min={5} max={3600} value={state.heartbeatSec}
                onChange={(e) => onChange({ ...state, heartbeatSec: Math.max(5, parseInt(e.target.value || '30', 10) || 30) })}
                className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 tabular-nums focus:outline-none focus:border-indigo-500/60"
              />
              <span>sec</span>
            </div>
          )}

          {/* Parallelism */}
          <div className="flex items-center gap-1 text-[10px] text-zinc-400" title="Max concurrent Running cards">
            <span className="uppercase tracking-wider text-zinc-500">Parallel</span>
            <input
              type="number" min={1} max={10} value={state.parallelism}
              onChange={(e) => onChange({ ...state, parallelism: Math.max(1, parseInt(e.target.value || '2', 10) || 2) })}
              className="w-12 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 tabular-nums focus:outline-none focus:border-indigo-500/60"
            />
          </div>

          {/* Tick now */}
          <button
            onClick={onTickNow}
            title="Run one Maestro tick now"
            className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[10px] uppercase tracking-wider"
          >
            <Play className="w-3 h-3" />
            Tick now
          </button>
    </div>
  );
}

function Segmented<T extends string>({
  label, value, onChange, options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; icon: React.ComponentType<{ className?: string }>; tip: string }>;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] uppercase tracking-wider text-zinc-500 mr-0.5">{label}</span>
      <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-900 overflow-hidden">
        {options.map(opt => {
          const Icon = opt.icon;
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              title={opt.tip}
              className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider border-r border-zinc-800 last:border-r-0 transition-colors ${
                active ? 'bg-indigo-500/25 text-indigo-200' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <Icon className="w-2.5 h-2.5" />
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
