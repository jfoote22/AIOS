import { cn } from "./cn";

/* ------------------------------- PageHeader ------------------------------- */
export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  /** Right-aligned actions (buttons, toggles). */
  actions?: React.ReactNode;
  /** Breadcrumb / back slot rendered above the title. */
  eyebrow?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  icon,
  actions,
  eyebrow,
  className,
  children,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "shrink-0 px-5 py-3.5 border-b border-line bg-surface/40 backdrop-blur-sm",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        {icon && (
          <div className="shrink-0 w-9 h-9 rounded-[var(--radius-md)] bg-surface-2 border border-line flex items-center justify-center text-ink-2">
            {icon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <div className="text-[11px] font-medium text-ink-3 mb-0.5">
              {eyebrow}
            </div>
          )}
          <h1 className="text-base font-semibold text-ink leading-tight truncate">
            {title}
          </h1>
          {description && (
            <p className="text-xs text-ink-3 mt-0.5 truncate">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        )}
      </div>
      {children}
    </header>
  );
}

/* -------------------------------- Toolbar --------------------------------- */
export function Toolbar({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 h-12 shrink-0 border-b border-line bg-surface/30",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function ToolbarSpacer() {
  return <div className="flex-1" />;
}

/* ------------------------------ SectionLabel ------------------------------ */
export function SectionLabel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider text-ink-3 px-1",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/* ------------------------------- EmptyState ------------------------------- */
export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** compact variant for inline/list empties */
  size?: "md" | "lg";
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  size = "md",
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center mx-auto",
        size === "lg" ? "py-16 max-w-sm" : "py-10 max-w-xs",
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            "rounded-[var(--radius-xl)] bg-surface-2 border border-line flex items-center justify-center text-ink-3 mb-4",
            size === "lg" ? "w-14 h-14" : "w-11 h-11",
          )}
        >
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-ink-2">{title}</h3>
      {description && (
        <p className="text-xs text-ink-3 mt-1.5 leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export default PageHeader;
