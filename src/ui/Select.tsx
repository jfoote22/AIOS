import { forwardRef } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  selectSize?: "sm" | "md" | "lg";
  options?: SelectOption[];
}

const SIZES = {
  sm: "h-8 text-xs pl-2.5 pr-8",
  md: "h-9 text-sm pl-3 pr-9",
  lg: "h-11 text-sm pl-3.5 pr-9",
};

/** Native <select> styled to match the design system (reliable, accessible). */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, selectSize = "md", options, className, children, ...props },
  ref,
) {
  return (
    <div className="relative inline-flex w-full items-center">
      <select
        ref={ref}
        className={cn(
          "w-full appearance-none bg-surface-2 border border-line rounded-[var(--radius-md)] text-ink",
          "transition-colors duration-150 focus-ring hover:border-line-strong focus:border-accent",
          "disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
          SIZES[selectSize],
          invalid && "border-danger focus:border-danger",
          className,
        )}
        aria-invalid={invalid || undefined}
        {...props}
      >
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown
        className="absolute right-2.5 w-4 h-4 text-ink-3 pointer-events-none"
        aria-hidden
      />
    </div>
  );
});

export default Select;
