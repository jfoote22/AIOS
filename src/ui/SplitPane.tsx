import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "./cn";

export interface SplitPaneProps {
  /** Orientation of the divider. "vertical" = side-by-side panes. */
  direction?: "vertical" | "horizontal";
  /** Initial size of the first pane in px. */
  initial?: number;
  min?: number;
  max?: number;
  /** Persist the size under this key in localStorage. */
  storageKey?: string;
  className?: string;
  first: React.ReactNode;
  second: React.ReactNode;
}

/**
 * Resizable two-pane split with a draggable divider. Dependency-free; persists
 * to localStorage when `storageKey` is provided.
 */
export function SplitPane({
  direction = "vertical",
  initial = 320,
  min = 160,
  max = 720,
  storageKey,
  className,
  first,
  second,
}: SplitPaneProps) {
  const isVertical = direction === "vertical";
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<number>(() => {
    if (storageKey) {
      const saved = Number(localStorage.getItem(storageKey));
      if (saved && !Number.isNaN(saved)) return saved;
    }
    return initial;
  });
  const dragging = useRef(false);

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = clamp(
        isVertical ? e.clientX - rect.left : e.clientY - rect.top,
      );
      setSize(next);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (storageKey) localStorage.setItem(storageKey, String(size));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [clamp, isVertical, size, storageKey]);

  const startDrag = () => {
    dragging.current = true;
    document.body.style.cursor = isVertical ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0", isVertical ? "flex-row" : "flex-col", className)}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={isVertical ? { width: size } : { height: size }}
      >
        {first}
      </div>
      <div
        role="separator"
        aria-orientation={isVertical ? "vertical" : "horizontal"}
        onMouseDown={startDrag}
        className={cn(
          "group relative shrink-0 bg-line hover:bg-accent/60 transition-colors",
          isVertical ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
        )}
      >
        <div
          className={cn(
            "absolute z-10",
            isVertical
              ? "inset-y-0 -left-1 -right-1"
              : "inset-x-0 -top-1 -bottom-1",
          )}
        />
      </div>
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">{second}</div>
    </div>
  );
}

export default SplitPane;
