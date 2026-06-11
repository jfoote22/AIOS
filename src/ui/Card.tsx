import { forwardRef } from "react";
import { cn } from "./cn";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Adds hover affordance for clickable cards. */
  interactive?: boolean;
  /** Surface elevation. */
  elevation?: "flat" | "raised" | "elevated";
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive, elevation = "flat", className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-[var(--radius-lg)] border border-line bg-surface",
        elevation === "raised" && "shadow-sm",
        elevation === "elevated" && "shadow-md",
        interactive &&
          "transition-colors duration-150 hover:border-line-strong hover:bg-surface-2 cursor-pointer",
        className,
      )}
      {...props}
    />
  );
});

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 px-4 py-3 border-b border-line-subtle",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-sm font-semibold text-ink leading-tight", className)}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-xs text-ink-3 mt-0.5", className)} {...props} />
  );
}

export function CardBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...props} />;
}

export function CardFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 px-4 py-3 border-t border-line-subtle",
        className,
      )}
      {...props}
    />
  );
}

export default Card;
