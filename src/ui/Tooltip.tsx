import { useId, useRef, useState } from "react";
import { cn } from "./cn";

export type TooltipSide = "top" | "bottom" | "left" | "right";

const SIDE: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
  right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
};

export interface TooltipProps {
  content: React.ReactNode;
  side?: TooltipSide;
  delay?: number;
  className?: string;
  children: React.ReactElement;
}

/**
 * Lightweight CSS-positioned tooltip — no portal/positioning library. Wraps a
 * single child in an inline-flex anchor; shows on hover + keyboard focus.
 */
export function Tooltip({
  content,
  side = "top",
  delay = 250,
  className,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  if (!content) return children;

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "absolute z-[1100] pointer-events-none whitespace-nowrap rounded-[var(--radius-sm)]",
            "bg-elevated border border-line px-2 py-1 text-xs text-ink shadow-pop animate-fade-in",
            SIDE[side],
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}

export default Tooltip;
