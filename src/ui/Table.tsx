import { cn } from "./cn";

export function Table({
  className,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto scrollbar-thin rounded-[var(--radius-lg)] border border-line">
      <table
        className={cn("w-full border-collapse text-sm", className)}
        {...props}
      />
    </div>
  );
}

export function THead({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn("bg-surface-2 text-ink-3", className)}
      {...props}
    />
  );
}

export function TBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export function TR({
  className,
  interactive,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }) {
  return (
    <tr
      className={cn(
        "border-t border-line-subtle",
        interactive && "hover:bg-surface-2 transition-colors cursor-pointer",
        className,
      )}
      {...props}
    />
  );
}

export function TH({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "text-left font-medium text-xs uppercase tracking-wide px-3.5 py-2.5 whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn("px-3.5 py-2.5 text-ink-2 align-middle", className)} {...props} />
  );
}

export default Table;
