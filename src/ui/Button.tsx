import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "outline"
  | "danger"
  | "subtle"
  | "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-ink font-semibold hover:bg-accent-hover active:bg-accent-active shadow-sm hover:shadow-[var(--glow-accent)]",
  secondary:
    "bg-surface-2 text-ink border border-line hover:bg-elevated hover:border-line-strong",
  outline:
    "bg-transparent text-ink-2 border border-line hover:bg-surface-2 hover:text-ink",
  ghost: "bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink",
  subtle: "bg-accent-soft text-accent border border-accent-line hover:bg-accent/20",
  danger: "bg-danger text-white hover:bg-danger/90 active:bg-danger/80 shadow-sm",
  link: "bg-transparent text-accent hover:underline underline-offset-4 px-0",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-7 px-2.5 text-xs gap-1.5 rounded-[var(--radius-sm)]",
  sm: "h-8 px-3 text-xs gap-1.5 rounded-[var(--radius-md)]",
  md: "h-9 px-3.5 text-sm gap-2 rounded-[var(--radius-md)]",
  lg: "h-11 px-5 text-sm gap-2 rounded-[var(--radius-lg)]",
  icon: "h-9 w-9 p-0 justify-center rounded-[var(--radius-md)]",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    leftIcon,
    rightIcon,
    fullWidth,
    className,
    children,
    disabled,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        "focus-ring inline-flex items-center justify-center font-medium whitespace-nowrap select-none",
        "transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        fullWidth && "w-full",
        className,
      )}
      {...props}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden />
      ) : (
        leftIcon && <span className="shrink-0 inline-flex">{leftIcon}</span>
      )}
      {(size !== "icon" || !loading) && children}
      {!loading && rightIcon && (
        <span className="shrink-0 inline-flex">{rightIcon}</span>
      )}
    </button>
  );
});

export interface IconButtonProps extends ButtonProps {
  "aria-label": string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ size = "icon", variant = "ghost", ...props }, ref) {
    return <Button ref={ref} size={size} variant={variant} {...props} />;
  },
);

export default Button;
