import { forwardRef, useId } from "react";

import { cn } from "@/lib/cn";

const control =
  "w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3 " +
  "transition-colors hover:border-ink-3 focus:border-focus focus:outline-none focus-visible:outline-none " +
  "focus:ring-2 focus:ring-focus/25 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-err";

/**
 * Label, control, hint and error in one block. The control is passed as a
 * render function so it gets the ids it needs for labelling.
 */
export function Field({
  children,
  className,
  error,
  hint,
  label,
  optional,
}: {
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => React.ReactNode;
  className?: string;
  error?: string | null;
  hint?: React.ReactNode;
  label: React.ReactNode;
  optional?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label className="flex items-baseline gap-2 text-sm font-medium text-ink" htmlFor={id}>
        {label}
        {optional ? <span className="text-xs font-normal text-ink-3">Optional</span> : null}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && !error ? (
        <p className="text-[13px] text-ink-3" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="text-[13px] text-err" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input {...props} className={cn(control, "h-9", className)} ref={ref} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea {...props} className={cn(control, "min-h-24 py-2 leading-relaxed", className)} ref={ref} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      {...props}
      className={cn(
        control,
        // The chevron lives in theme.css (.rv-select): tailwind-merge drops arbitrary url backgrounds.
        "rv-select h-9 appearance-none pr-9",
        className,
      )}
      ref={ref}
    >
      {children}
    </select>
  );
});

/**
 * An on/off setting that applies right away: a label, a sentence about what
 * it does, and the switch on the right.
 */
export function Switch({
  checked,
  className,
  description,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  className?: string;
  description?: React.ReactNode;
  disabled?: boolean;
  label: React.ReactNode;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0 space-y-0.5">
        <label className="text-sm font-medium text-ink" htmlFor={id}>
          {label}
        </label>
        {description ? (
          <p className="text-[13px] text-ink-3" id={`${id}-description`}>
            {description}
          </p>
        ) : null}
      </div>
      <button
        aria-checked={checked}
        aria-describedby={description ? `${id}-description` : undefined}
        className={cn(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "border-accent bg-accent" : "border-line-strong bg-sunken",
        )}
        disabled={disabled}
        id={id}
        onClick={() => onChange(!checked)}
        role="switch"
        type="button"
      >
        <span
          aria-hidden
          className={cn(
            "inline-block size-3.5 rounded-full shadow-sm transition-transform",
            checked ? "translate-x-[18px] bg-accent-ink" : "translate-x-[2px] bg-surface ring-1 ring-line-strong",
          )}
        />
      </button>
    </div>
  );
}

/** A one-line form error or notice above the actions. */
export function FormMessage({ children, tone = "err" }: { children: React.ReactNode; tone?: "err" | "ok" }) {
  return (
    <p
      className={cn(
        "rounded-md px-3 py-2 text-[13px]",
        tone === "err" ? "bg-err-soft text-err" : "bg-ok-soft text-ok",
      )}
      role={tone === "err" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}
