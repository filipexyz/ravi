"use client";

import { CircleAlert, TriangleAlert } from "lucide-react";
import { forwardRef, useId } from "react";

import { cn } from "@/lib/cn";
import type { Diagnostic } from "@/shared/widgets/types";

import { diagnosticsSummary, diagnosticWhere, sortDiagnosticsForDisplay } from "./diagnostics";

/**
 * The compiler's diagnostics, errors first, each with its severity in words
 * and where it is. A diagnostic `canLocate` accepts is a button that takes
 * the caret to its file and line.
 */
export function DiagnosticsList({
  canLocate,
  className,
  diagnostics,
  onLocate,
  title = "Problemas",
}: {
  canLocate?: (diagnostic: Diagnostic) => boolean;
  className?: string;
  diagnostics: readonly Diagnostic[];
  onLocate?: (diagnostic: Diagnostic) => void;
  title?: string;
}) {
  const headingId = useId();
  const sorted = sortDiagnosticsForDisplay(diagnostics);
  return (
    <section aria-labelledby={headingId} className={cn("space-y-2", className)}>
      <h3 className="text-sm font-semibold text-ink" id={headingId}>
        {title} <span className="font-normal text-ink-3">({diagnosticsSummary(diagnostics)})</span>
      </h3>
      {sorted.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
          {sorted.map((diagnostic, index) => {
            const body = <DiagnosticText diagnostic={diagnostic} />;
            const locatable = Boolean(onLocate && (canLocate ? canLocate(diagnostic) : diagnostic.file));
            return (
              <li key={`${diagnostic.code}-${diagnosticWhere(diagnostic)}-${index}`}>
                {locatable ? (
                  <button
                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-[13px] hover:bg-hover"
                    onClick={() => onLocate?.(diagnostic)}
                    type="button"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex items-start gap-2 px-3 py-2 text-[13px]">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function DiagnosticText({ diagnostic }: { diagnostic: Diagnostic }) {
  const error = diagnostic.severity === "error";
  const Icon = error ? CircleAlert : TriangleAlert;
  const where = diagnosticWhere(diagnostic);
  return (
    <>
      <Icon aria-hidden className={cn("mt-0.5 shrink-0", error ? "text-err" : "text-warn")} size={15} />
      {/* Real spaces between the parts, so the button's accessible name reads "Erro widget.html:3:1 …". */}
      <span className="min-w-0">
        <span className={cn("font-medium", error ? "text-err" : "text-warn")}>{error ? "Erro" : "Aviso"}</span>{" "}
        {where ? (
          <>
            <span className="font-mono text-ink-2">{where}</span>{" "}
          </>
        ) : null}
        <span className="text-ink-2">{diagnostic.message}</span>
      </span>
    </>
  );
}

/** One problem in the summary; `diagnostic` is what the editor locates when it is chosen. */
export type ErrorSummaryItem = { key: string; text: React.ReactNode; target: string; diagnostic?: Diagnostic };

/**
 * What stops a save, at the top of the form: each problem links to its field
 * or line. The caller focuses it when a save is refused, and that focus is
 * what announces it (its title, then the problems). It is not a live region,
 * so the list changing while the person fixes things is not read out again.
 */
export const ErrorSummary = forwardRef<HTMLElement, { items: ErrorSummaryItem[]; onSelect: (item: ErrorSummaryItem) => void; title: string }>(function ErrorSummary(
  { items, onSelect, title },
  ref,
) {
  const headingId = useId();
  const listId = useId();
  return (
    <section
      aria-describedby={listId}
      aria-labelledby={headingId}
      className="rounded-md border border-err bg-err-soft px-4 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-err/40"
      ref={ref}
      tabIndex={-1}
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold text-err" id={headingId}>
        <CircleAlert aria-hidden size={16} />
        {title}
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-6 text-[13px] text-err" id={listId}>
        {items.map((item) => (
          <li key={item.key}>
            <a
              className="underline underline-offset-2 hover:no-underline"
              href={`#${item.target}`}
              onClick={(event) => {
                event.preventDefault();
                onSelect(item);
              }}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
});
