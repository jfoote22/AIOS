import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "./cn";
import { useFocusReturn, useLockBodyScroll, useOnEscape } from "./overlay";
import { IconButton } from "./Button";

export type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZE: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  size?: DialogSize;
  /** Footer actions, right-aligned. */
  footer?: React.ReactNode;
  /** Disable closing on scrim click / Escape (e.g. during a destructive op). */
  dismissible?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  footer,
  dismissible = true,
  className,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useLockBodyScroll(open);
  useFocusReturn(open);
  useOnEscape(open && dismissible, onClose);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-overlay backdrop-blur-sm animate-fade-in"
        onClick={dismissible ? onClose : undefined}
        aria-hidden
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "relative w-full rounded-[var(--radius-xl)] border border-line bg-elevated shadow-lg outline-none",
          "animate-scale-in flex flex-col max-h-[calc(100vh-2rem)]",
          SIZE[size],
          className,
        )}
      >
        {(title || dismissible) && (
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-line-subtle">
            <div className="min-w-0">
              {title && (
                <h2 className="text-base font-semibold text-ink leading-tight">
                  {title}
                </h2>
              )}
              {description && (
                <p className="text-sm text-ink-3 mt-1">{description}</p>
              )}
            </div>
            {dismissible && (
              <IconButton
                aria-label="Close dialog"
                size="sm"
                onClick={onClose}
                className="-mr-1 -mt-0.5 shrink-0"
              >
                <X className="w-4 h-4" />
              </IconButton>
            )}
          </div>
        )}
        <div className="px-5 py-4 overflow-y-auto scrollbar-thin">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-line-subtle">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default Dialog;
