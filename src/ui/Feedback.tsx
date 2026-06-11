import { Loader2 } from "lucide-react";
import { cn } from "./cn";

/* --------------------------------- Spinner -------------------------------- */
export function Spinner({
  className,
  size = 16,
  label,
}: {
  className?: string;
  size?: number;
  label?: string;
}) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2">
      <Loader2
        className={cn("animate-spin text-ink-3", className)}
        style={{ width: size, height: size }}
        aria-hidden
      />
      {label && <span className="text-sm text-ink-3">{label}</span>}
      {!label && <span className="sr-only">Loading</span>}
    </span>
  );
}

/* -------------------------------- Skeleton -------------------------------- */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-[var(--radius-sm)] bg-surface-2",
        className,
      )}
      {...props}
    />
  );
}

/* ------------------------------- Separator -------------------------------- */
export function Separator({
  orientation = "horizontal",
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "bg-line",
        orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch",
        className,
      )}
      {...props}
    />
  );
}

/* ----------------------------------- Kbd ---------------------------------- */
export function Kbd({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[var(--radius-xs)] border border-line bg-surface-2",
        "px-1.5 h-5 min-w-[20px] justify-center text-[10px] font-mono font-medium text-ink-2",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
