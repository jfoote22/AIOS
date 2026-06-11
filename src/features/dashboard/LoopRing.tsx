import { cn } from "@/ui";

export interface LoopPhase {
  key: string;
  label: string;
  count: number;
  hint: string;
  color: string;
  icon: React.ReactNode;
  onClick: () => void;
}

// Cardinal positions for the 4 phases (top → right → bottom → left = the flow).
const POS = [
  "top-0 left-1/2 -translate-x-1/2 -translate-y-1/2",
  "top-1/2 right-0 translate-x-1/2 -translate-y-1/2",
  "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2",
  "top-1/2 left-0 -translate-x-1/2 -translate-y-1/2",
];

/** The knowledge loop as a clickable, animated cycle. The rotating dashed ring
 *  conveys continuous flow; each cardinal node is a phase you can act on. */
export default function LoopRing({ phases }: { phases: LoopPhase[] }) {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[320px]">
      <svg viewBox="0 0 320 320" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="loopgrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="55%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>
        </defs>
        {/* base track */}
        <circle cx="160" cy="160" r="118" fill="none" stroke="var(--color-line)" strokeWidth="2" />
        {/* flowing dashed ring */}
        <circle
          cx="160"
          cy="160"
          r="118"
          fill="none"
          stroke="url(#loopgrad)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="6 22"
          className="animate-spin [animation-duration:26s]"
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
        />
      </svg>

      {/* center label */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-3">
          The
        </span>
        <span
          className="text-lg font-bold tracking-tight bg-clip-text text-transparent"
          style={{ backgroundImage: "var(--gradient-brand)" }}
        >
          Loop
        </span>
      </div>

      {/* phase nodes */}
      {phases.slice(0, 4).map((p, i) => (
        <button
          key={p.key}
          onClick={p.onClick}
          title={p.hint}
          className={cn(
            "focus-ring absolute flex flex-col items-center gap-1 group",
            POS[i],
          )}
        >
          <span
            className="flex h-12 w-12 items-center justify-center rounded-full border bg-elevated shadow-md transition-transform group-hover:scale-110"
            style={{ borderColor: p.color, color: p.color }}
          >
            {p.icon}
          </span>
          <span className="text-[11px] font-semibold text-ink leading-none whitespace-nowrap">
            {p.label}
          </span>
          <span className="text-[10px] text-ink-3 leading-none tabular-nums">
            {p.count}
          </span>
        </button>
      ))}
    </div>
  );
}
