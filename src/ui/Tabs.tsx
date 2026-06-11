import { createContext, useContext, useId } from "react";
import { cn } from "./cn";

interface TabsCtx {
  value: string;
  setValue: (v: string) => void;
  idBase: string;
}
const Ctx = createContext<TabsCtx | null>(null);

export interface TabsProps {
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
  children: React.ReactNode;
}

export function Tabs({ value, onValueChange, className, children }: TabsProps) {
  const idBase = useId();
  return (
    <Ctx.Provider value={{ value, setValue: onValueChange, idBase }}>
      <div className={cn("flex flex-col min-h-0", className)}>{children}</div>
    </Ctx.Provider>
  );
}

export type TabsListVariant = "underline" | "pill" | "segmented";

export function TabsList({
  variant = "underline",
  className,
  children,
}: {
  variant?: TabsListVariant;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "flex items-center gap-1 shrink-0",
        variant === "underline" && "border-b border-line gap-4",
        variant === "segmented" &&
          "bg-surface-2 border border-line rounded-[var(--radius-md)] p-0.5 gap-0.5",
        className,
      )}
      data-variant={variant}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  className,
  children,
  disabled,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("TabsTrigger must be used within <Tabs>");
  const active = ctx.value === value;
  return (
    <button
      role="tab"
      type="button"
      id={`${ctx.idBase}-tab-${value}`}
      aria-selected={active}
      aria-controls={`${ctx.idBase}-panel-${value}`}
      tabIndex={active ? 0 : -1}
      disabled={disabled}
      onClick={() => ctx.setValue(value)}
      data-active={active}
      className={cn(
        "focus-ring relative inline-flex items-center gap-2 text-sm font-medium transition-colors disabled:opacity-40",
        // underline style
        "data-[variant=underline]:pb-2.5",
        active ? "text-ink" : "text-ink-3 hover:text-ink-2",
        // pill / segmented active background applied via group below
        "px-3 h-8 rounded-[var(--radius-sm)] data-[active=true]:bg-surface group-data-[variant=underline]:bg-transparent",
        className,
      )}
    >
      {children}
      {/* underline indicator */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-0 right-0 -bottom-px h-0.5 rounded-full transition-colors",
          active ? "bg-accent" : "bg-transparent",
        )}
      />
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children,
  /** keep mounted while hidden (preserves state) */
  keepMounted,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
  keepMounted?: boolean;
}) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("TabsContent must be used within <Tabs>");
  const active = ctx.value === value;
  if (!active && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={`${ctx.idBase}-panel-${value}`}
      aria-labelledby={`${ctx.idBase}-tab-${value}`}
      hidden={!active}
      className={cn("flex-1 min-h-0", className)}
    >
      {children}
    </div>
  );
}

export default Tabs;
