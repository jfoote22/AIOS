import { forwardRef, useId } from "react";
import { cn } from "./cn";

const fieldBase =
  "w-full bg-surface-2 border border-line rounded-[var(--radius-md)] text-ink placeholder:text-ink-4 " +
  "transition-colors duration-150 focus-ring hover:border-line-strong " +
  "focus:border-accent disabled:opacity-50 disabled:pointer-events-none";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  inputSize?: "sm" | "md" | "lg";
  leftIcon?: React.ReactNode;
  rightSlot?: React.ReactNode;
}

const SIZES = {
  sm: "h-8 text-xs px-2.5",
  md: "h-9 text-sm px-3",
  lg: "h-11 text-sm px-3.5",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, inputSize = "md", leftIcon, rightSlot, className, ...props },
  ref,
) {
  if (leftIcon || rightSlot) {
    return (
      <div className="relative flex items-center">
        {leftIcon && (
          <span className="absolute left-3 text-ink-3 pointer-events-none inline-flex">
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          className={cn(
            fieldBase,
            SIZES[inputSize],
            !!leftIcon && "pl-9",
            !!rightSlot && "pr-9",
            invalid && "border-danger focus:border-danger",
            className,
          )}
          aria-invalid={invalid || undefined}
          {...props}
        />
        {rightSlot && (
          <span className="absolute right-2.5 text-ink-3 inline-flex">
            {rightSlot}
          </span>
        )}
      </div>
    );
  }
  return (
    <input
      ref={ref}
      className={cn(
        fieldBase,
        SIZES[inputSize],
        invalid && "border-danger focus:border-danger",
        className,
      )}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
});

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ invalid, className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          fieldBase,
          "py-2 px-3 text-sm leading-relaxed resize-y min-h-[80px] scrollbar-thin",
          invalid && "border-danger focus:border-danger",
          className,
        )}
        aria-invalid={invalid || undefined}
        {...props}
      />
    );
  },
);

export function Label({
  className,
  required,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }) {
  return (
    <label
      className={cn(
        "text-xs font-medium text-ink-2 select-none flex items-center gap-1",
        className,
      )}
      {...props}
    >
      {children}
      {required && <span className="text-danger">*</span>}
    </label>
  );
}

export interface FieldProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}

/** Vertical label + control + hint/error stack with wired aria via context-free ids. */
export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  className,
  children,
}: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <Label htmlFor={id} required={required}>
          {label}
        </Label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-danger-ink">{error}</p>
      ) : (
        hint && <p className="text-xs text-ink-3">{hint}</p>
      )}
    </div>
  );
}

export default Input;
