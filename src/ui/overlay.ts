import { useEffect } from "react";

/** Call `handler` when Escape is pressed, while `active`. */
export function useOnEscape(active: boolean, handler: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handler();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, handler]);
}

/** Lock body scroll while `active` (e.g. a modal/drawer is open). */
export function useLockBodyScroll(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);
}

/** Move focus into a container on mount and restore it on unmount. */
export function useFocusReturn(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      try {
        prev?.focus?.();
      } catch {
        /* element gone — ignore */
      }
    };
  }, [active]);
}
