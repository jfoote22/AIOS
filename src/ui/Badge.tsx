import { cn } from "./cn";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";
export type BadgeVariant = "soft" | "solid" | "outline";

const TONES: Record<BadgeVariant, Record<BadgeTone, string>> = {
  soft: {
    neutral: "bg-surface-2 text-ink-2 border border-line",
    accent: "bg-accent-soft text-accent border border-accent-line",
    success: "bg-success-soft text-success-ink border border-success/30",
    warning: "bg-warning-soft text-warning-ink border border-warning/30",
    danger: "bg-danger-soft text-danger-ink border border-danger/30",
    info: "bg-info-soft text-info-ink border border-info/30",
  },
  solid: {
    neutral: "bg-ink-3 text-canvas",
    accent: "bg-accent text-accent-ink",
    success: "bg-success text-white",
    warning: "bg-warning text-black",
    danger: "bg-danger text-white",
    info: "bg-info text-white",
  },
  outline: {
    neutral: "border border-line text-ink-2",
    accent: "border border-accent-line text-accent",
    success: "border border-success/40 text-success-ink",
    warning: "border border-warning/40 text-warning-ink",
    danger: "border border-danger/40 text-danger-ink",
    info: "border border-info/40 text-info-ink",
  },
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  /** Render a small leading status dot. */
  dot?: boolean;
}

export function Badge({
  tone = "neutral",
  variant = "soft",
  dot,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap",
        TONES[variant][tone],
        className,
      )}
      {...props}
    >
      {dot && (
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            tone === "neutral" && "bg-ink-3",
            tone === "accent" && "bg-accent",
            tone === "success" && "bg-success",
            tone === "warning" && "bg-warning",
            tone === "danger" && "bg-danger",
            tone === "info" && "bg-info",
          )}
          aria-hidden
        />
      )}
      {children}
    </span>
  );
}

export default Badge;
