import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "./cn";
import { useFocusReturn, useLockBodyScroll, useOnEscape } from "./overlay";
import { IconButton } from "./Button";

export type DrawerSide = "right" | "left";
export type DrawerSize = "sm" | "md" | "lg" | "xl";

const WIDTH: Record<DrawerSize, string> = {
  sm: "w-[320px]",
  md: "w-[420px]",
  lg: "w-[560px]",
  xl: "w-[720px]",
};

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: DrawerSide;
  size?: DrawerSize;
  title?: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  dismissible?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function Drawer({
  open,
  onClose,
  side = "right",
  size = "md",
  title,
  description,
  footer,
  dismissible = true,
  className,
  children,
}: DrawerProps) {
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
      className="fixed inset-0 z-[1000] flex"
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
          "relative ml-auto h-full bg-elevated border-line shadow-lg outline-none flex flex-col max-w-[92vw]",
          WIDTH[size],
          side === "right"
            ? "ml-auto border-l animate-slide-in-right"
            : "mr-auto border-r animate-slide-in-left",
          className,
        )}
      >
        {(title || dismissible) && (
          <div className="flex items-start justify-between gap-4 px-5 h-14 shrink-0 border-b border-line-subtle">
            <div className="min-w-0 flex flex-col justify-center h-full">
              {title && (
                <h2 className="text-sm font-semibold text-ink leading-tight truncate">
                  {title}
                </h2>
              )}
              {description && (
                <p className="text-xs text-ink-3 truncate">{description}</p>
              )}
            </div>
            {dismissible && (
              <IconButton
                aria-label="Close drawer"
                size="sm"
                onClick={onClose}
                className="self-center shrink-0"
              >
                <X className="w-4 h-4" />
              </IconButton>
            )}
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-4">
          {children}
        </div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-line-subtle shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default Drawer;
