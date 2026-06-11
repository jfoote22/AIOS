import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "./cn";

export type ToastTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface ToastOptions {
  title?: React.ReactNode;
  description?: React.ReactNode;
  tone?: ToastTone;
  /** ms before auto-dismiss; 0 keeps it until dismissed. Default 4500. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
}

interface ToastApi {
  toast: (opts: ToastOptions) => number;
  success: (title: React.ReactNode, opts?: ToastOptions) => number;
  error: (title: React.ReactNode, opts?: ToastOptions) => number;
  info: (title: React.ReactNode, opts?: ToastOptions) => number;
  warning: (title: React.ReactNode, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS: Record<ToastTone, React.ComponentType<{ className?: string }>> = {
  neutral: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
};

const TONE_ICON: Record<ToastTone, string> = {
  neutral: "text-ink-3",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (opts: ToastOptions) => {
      const id = ++seq.current;
      const duration = opts.duration ?? 4500;
      setItems((prev) => [...prev, { ...opts, id }]);
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      dismiss,
      success: (title, opts) => toast({ ...opts, title, tone: "success" }),
      error: (title, opts) =>
        toast({ duration: 7000, ...opts, title, tone: "danger" }),
      info: (title, opts) => toast({ ...opts, title, tone: "info" }),
      warning: (title, opts) => toast({ ...opts, title, tone: "warning" }),
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="fixed bottom-4 right-4 z-[1200] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-2rem)]">
          {items.map((t) => {
            const Icon = ICONS[t.tone ?? "neutral"];
            return (
              <div
                key={t.id}
                role="status"
                className="animate-slide-up flex items-start gap-3 rounded-[var(--radius-lg)] border border-line bg-elevated shadow-lg p-3.5"
              >
                <Icon
                  className={cn("w-4 h-4 mt-0.5 shrink-0", TONE_ICON[t.tone ?? "neutral"])}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  {t.title && (
                    <div className="text-sm font-medium text-ink leading-snug">
                      {t.title}
                    </div>
                  )}
                  {t.description && (
                    <div className="text-xs text-ink-3 mt-0.5 break-words">
                      {t.description}
                    </div>
                  )}
                  {t.action && (
                    <button
                      onClick={() => {
                        t.action!.onClick();
                        dismiss(t.id);
                      }}
                      className="mt-2 text-xs font-medium text-accent hover:underline underline-offset-2"
                    >
                      {t.action.label}
                    </button>
                  )}
                </div>
                <button
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss notification"
                  className="shrink-0 text-ink-4 hover:text-ink transition-colors -mr-1 -mt-1 p-1"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

export default ToastProvider;
