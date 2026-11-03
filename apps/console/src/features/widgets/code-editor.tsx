"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/cn";

import { lineCount, lineRange } from "./code-lines";

export type CodeEditorHandle = {
  /** Focuses the text area with the caret at `line` (and `column`), scrolled into view. */
  focusLine: (line: number, column?: number) => void;
};

const LINE_HEIGHT = 20;

/**
 * A plain text area for one file, monospace, with line numbers beside it.
 * Lines never wrap, so the gutter's numbers stay on their lines. Tab moves
 * focus as usual; the gutter is decoration (the diagnostics list says the
 * same in text).
 */
export const CodeEditor = forwardRef<
  CodeEditorHandle,
  {
    id: string;
    label: React.ReactNode;
    hint?: React.ReactNode;
    value: string;
    onChange: (value: string) => void;
    rows?: number;
    /** Lines with a diagnostic: errors get a mark, warnings a lighter one. */
    marks?: ReadonlyMap<number, "error" | "warning">;
    invalid?: boolean;
    describedBy?: string;
  }
>(function CodeEditor({ describedBy, hint, id, invalid, label, marks, onChange, rows = 14, value }, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const hintId = `${id}-hint`;
  const count = lineCount(value);

  useImperativeHandle(
    ref,
    () => ({
      focusLine(line, column) {
        const element = area.current;
        if (!element) return;
        const range = lineRange(element.value, line, column);
        element.focus({ preventScroll: true });
        element.setSelectionRange(range.caret, range.caret);
        element.scrollTop = Math.max(0, (range.line - 1) * LINE_HEIGHT - element.clientHeight / 3);
        if (gutter.current) gutter.current.scrollTop = element.scrollTop;
        element.scrollIntoView({ block: "nearest", behavior: "smooth" });
      },
    }),
    [],
  );

  return (
    <div className="space-y-1.5">
      <label className="block font-mono text-[13px] font-medium text-ink" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <p className="text-[13px] text-ink-3" id={hintId}>
          {hint}
        </p>
      ) : null}
      <div
        className={cn(
          "flex overflow-hidden rounded-md border bg-surface transition-colors focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/30",
          invalid ? "border-err" : "border-line-strong",
        )}
      >
        {/* The numbers sit in an absolutely placed column, so a long file never makes the editor taller than its text area. */}
        <div
          aria-hidden
          className="relative shrink-0 border-r border-line bg-sunken font-mono text-[12.5px] text-ink-3 select-none"
          style={{ width: `calc(${String(count).length + 2}ch + 1.25rem)` }}
        >
          <div className="absolute inset-0 overflow-hidden pt-2 pr-2 pb-10 text-right" ref={gutter} style={{ lineHeight: `${LINE_HEIGHT}px` }}>
            {Array.from({ length: count }, (_, index) => {
              const mark = marks?.get(index + 1);
              return (
                <div className={cn(mark === "error" && "font-semibold text-err", mark === "warning" && "text-warn")} key={index}>
                  {mark ? <span className="mr-1">{mark === "error" ? "●" : "○"}</span> : null}
                  {index + 1}
                </div>
              );
            })}
          </div>
        </div>
        <textarea
          aria-describedby={[hint ? hintId : null, describedBy].filter(Boolean).join(" ") || undefined}
          aria-invalid={invalid || undefined}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="min-w-0 flex-1 resize-y overflow-auto bg-transparent px-3 py-2 font-mono text-[12.5px] whitespace-pre text-ink outline-none focus-visible:outline-none"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
          }}
          ref={area}
          rows={rows}
          spellCheck={false}
          style={{ lineHeight: `${LINE_HEIGHT}px` }}
          value={value}
          wrap="off"
        />
      </div>
    </div>
  );
});
