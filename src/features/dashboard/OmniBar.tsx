import { useState } from "react";
import { Brain, ScanLine, Telescope, Github, ArrowRight } from "lucide-react";
import { cn } from "@/ui";

export type OmniMode = "ask" | "capture" | "deepdive" | "tools";

const MODES: {
  key: OmniMode;
  label: string;
  icon: React.ReactNode;
  placeholder: string;
}[] = [
  { key: "ask", label: "Ask", icon: <Brain className="w-4 h-4" />, placeholder: "Ask your brain anything…" },
  { key: "capture", label: "Capture", icon: <ScanLine className="w-4 h-4" />, placeholder: "Paste a note to store — or leave empty to snip the screen" },
  { key: "deepdive", label: "Deep Dive", icon: <Telescope className="w-4 h-4" />, placeholder: "A topic to research deeply…" },
  { key: "tools", label: "Find Tools", icon: <Github className="w-4 h-4" />, placeholder: "Find GitHub repos & tools for a topic…" },
];

/** The universal entry point — same bar, four verbs. Enter anywhere in the loop. */
export default function OmniBar({
  onSubmit,
}: {
  onSubmit: (mode: OmniMode, value: string) => void;
}) {
  const [mode, setMode] = useState<OmniMode>("ask");
  const [value, setValue] = useState("");
  const current = MODES.find((m) => m.key === mode)!;

  const submit = () => {
    if (mode !== "capture" && !value.trim()) return;
    onSubmit(mode, value.trim());
    if (mode === "capture") setValue("");
  };

  return (
    <div className="rounded-[var(--radius-xl)] border border-line bg-surface/70 backdrop-blur-sm shadow-md overflow-hidden">
      <div className="flex items-center gap-1 px-2 pt-2">
        {MODES.map((m) => {
          const activeMode = m.key === mode;
          return (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={cn(
                "focus-ring inline-flex items-center gap-1.5 px-3 h-8 rounded-[var(--radius-md)] text-xs font-medium transition-colors",
                activeMode
                  ? "bg-accent-soft text-accent border border-accent-line"
                  : "text-ink-3 hover:text-ink hover:bg-surface-2 border border-transparent",
              )}
            >
              {m.icon}
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 p-2">
        <div className="text-ink-3 pl-2">{current.icon}</div>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={current.placeholder}
          className="flex-1 bg-transparent outline-none text-sm text-ink placeholder:text-ink-4 h-10"
        />
        <button
          onClick={submit}
          style={{ backgroundImage: "var(--gradient-brand)" }}
          className="focus-ring inline-flex items-center gap-1.5 h-10 px-4 rounded-[var(--radius-md)] text-white text-sm font-semibold shadow-[var(--glow-accent)] transition-shadow hover:shadow-[0_10px_30px_-8px_rgb(34_211_238/0.7)]"
        >
          {current.label}
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
