"use client";

import { useMemo } from "react";

import { cn } from "@/lib/cn";
import { Segmented } from "@/ui/tabs";
import type { WidgetVariant } from "@/shared/widgets/types";

import { framePreviewDocument, type PreviewMode, type PreviewVariant, type PreviewView } from "./preview";

/**
 * A preview document in a sandboxed frame: `sandbox=""` (no scripts, no
 * forms, no popups, opaque origin, so it cannot reach the Console) and the
 * frame CSP from `framePreviewDocument`. Drag the bottom edge to make it taller.
 */
export function PreviewFrame({
  className,
  height = 480,
  html,
  title,
  view,
}: {
  className?: string;
  height?: number;
  html: string;
  title: string;
  view?: Partial<PreviewView>;
}) {
  const mode = view?.mode;
  const variant = view?.variant;
  const srcDoc = useMemo(() => framePreviewDocument(html, { mode, variant }), [html, mode, variant]);
  return (
    <div className={cn("resize-y overflow-hidden rounded-lg border border-line bg-canvas", className)} style={{ height }}>
      <iframe className="block size-full" loading="lazy" referrerPolicy="no-referrer" sandbox="" srcDoc={srcDoc} title={title} />
    </div>
  );
}

const MODE_OPTIONS: { value: PreviewMode; label: string }[] = [
  { value: "both", label: "Claro e escuro" },
  { value: "light", label: "Claro" },
  { value: "dark", label: "Escuro" },
];

/** Light/dark and variant choice for a preview. */
export function PreviewControls({
  onChange,
  variants,
  view,
}: {
  onChange: (view: PreviewView) => void;
  variants?: readonly WidgetVariant[];
  view: PreviewView;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-[13px] text-ink-3">
          Modo
        </span>
        <Segmented label="Modo da prévia" onChange={(mode) => onChange({ ...view, mode })} options={MODE_OPTIONS} value={view.mode} />
      </div>
      {variants && variants.length > 1 ? (
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-[13px] text-ink-3">
            Variante
          </span>
          <Segmented<PreviewVariant>
            label="Variante da prévia"
            onChange={(variant) => onChange({ ...view, variant })}
            options={[{ value: "all", label: "Todas" }, ...variants.map((variant) => ({ value: variant, label: variant }))]}
            value={view.variant}
          />
        </div>
      ) : null}
    </div>
  );
}
