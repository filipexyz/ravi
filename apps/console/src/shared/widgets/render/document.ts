// Standalone preview of a widget (`POST widgets/preview`, Console previews):
// theme CSS and pieces CSS inline, every variant rendered for each record,
// a light pane and a dark pane side by side (each pane carries its mode's
// theme variables in its style attribute), and no script. Buttons and
// editors render as they would for a viewer who may do everything, disabled.

import type { BaseUserRef } from "@/shared/bases/types";

import { PIECES_CSS } from "../pieces.css";
import { WIDGET_VARIANTS, type CompiledTheme, type CompiledWidget, type RenderColumn, type RenderContext, type RenderRecord, type ThemeMode, type WidgetVariant } from "../types";
import { messageLocale, messages } from "./messages";
import { escapeAttr, escapeHtml, h, safeStyle, toHtml, type VNode } from "./vnode";
import { renderWidget } from "./widget";

export type PreviewDocumentInput = {
  widget: CompiledWidget;
  theme: CompiledTheme;
  records: RenderRecord[];
  columns: Record<string, RenderColumn>;
  title: string;
  locale: string;
  /** People named by the records (from `normalizeStaticRecords`). */
  users?: Record<string, BaseUserRef>;
  /** Defaults to the current time; fixed in tests. */
  now?: Date;
  timeZone?: string;
};

const PREVIEW_CSS = `
  body { margin: 0; background: var(--color-background-secondary, #f3f5f8); color: var(--color-text-primary, #17202a); font-family: var(--font-sans, system-ui, sans-serif); }
  .ravi-preview { padding: 1rem; }
  .ravi-preview > h1 { margin: 0 0 1rem; font-size: var(--font-heading-md-size, 1.25rem); }
  .ravi-preview-panes { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); }
  .ravi-preview-pane { min-inline-size: 0; padding: 1rem; background: var(--color-background-primary); color: var(--color-text-primary); border: 1px solid var(--color-border-secondary); border-radius: var(--border-radius-xl, 12px); }
  .ravi-preview-pane > h2 { margin: 0 0 0.75rem; font-size: var(--font-heading-sm-size, 1rem); }
  .ravi-preview-variant + .ravi-preview-variant { margin-block-start: 1.5rem; }
  .ravi-preview-variant > h3 { margin: 0 0 0.5rem; font-size: var(--font-text-sm-size, 0.875rem); color: var(--color-text-secondary); font-weight: var(--font-weight-medium, 500); }
  .ravi-preview-frame { max-inline-size: 24rem; }
`;

/** CSS has no use for `<` outside strings and comments; escaping it keeps `</style>` and `<script` out of the document. */
function styleText(css: string): string {
  return css.replace(/</g, "\\3c ");
}

/** The mode's theme variables as a style attribute; a declaration `safeStyle` refuses is left out alone. */
function varsStyle(vars: Record<string, string>, mode: ThemeMode): string {
  const declarations = Object.entries(vars)
    .map(([name, value]) => (typeof value === "string" ? safeStyle(`${name}: ${value}`) : null))
    .filter((declaration): declaration is string => declaration !== null);
  declarations.push(`color-scheme: ${mode}`);
  return declarations.join("; ");
}

function safeLang(locale: string): string {
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(locale) ? locale : messageLocale(locale);
}

function previewVariants(widget: CompiledWidget): WidgetVariant[] {
  const present = WIDGET_VARIANTS.filter((variant) => Array.isArray(widget.variants[variant]));
  return ["default" as const, ...present.filter((variant) => variant !== "default")];
}

export function renderPreviewDocument(input: PreviewDocumentInput): string {
  const { widget, theme } = input;
  const lang = safeLang(input.locale);
  const msgs = messages(lang);
  const now = input.now ?? new Date();
  const variants = previewVariants(widget);
  const write = new Set(Object.keys(widget.fields));

  const pane = (mode: ThemeMode): VNode => {
    const headingId = `preview-${mode}`;
    return h(
      "section",
      { class: "ravi-preview-pane", "data-ravi-mode": mode, "aria-labelledby": headingId, style: varsStyle(theme.vars[mode], mode) },
      h("h2", { id: headingId }, mode === "light" ? msgs.previewLight : msgs.previewDark),
      variants.map((variant) => {
        const variantId = `preview-${mode}-${variant}`;
        const ctx = (index: number): RenderContext => ({
          locale: lang,
          timeZone: input.timeZone ?? "UTC",
          now,
          fields: theme.fields,
          users: input.users ?? {},
          columns: input.columns,
          can: { write, create: true, archive: true },
          variant,
          headingLevel: 4,
          idPrefix: `${mode}-${variant}-${index}`,
          interactive: false,
        });
        return h(
          "section",
          { class: "ravi-preview-variant", "aria-labelledby": variantId },
          h("h3", { id: variantId }, msgs.previewVariant(variant)),
          input.records.length
            ? h(
                "ul",
                { class: "ravi-list ravi-preview-frame", role: "list" },
                input.records.map((record, index) => h("li", null, renderWidget(widget, record, ctx(index)))),
              )
            : h("p", { class: "ravi-status" }, msgs.empty),
        );
      }),
    );
  };

  const body = toHtml(
    h("main", { class: "ravi-preview" }, h("h1", null, input.title), h("div", { class: "ravi-preview-panes" }, pane("light"), pane("dark"))),
  );

  return [
    "<!doctype html>",
    `<html lang="${escapeAttr(lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style id="ravi-theme">${styleText(theme.css)}</style>`,
    `<style id="ravi-pieces">${styleText(PIECES_CSS)}</style>`,
    `<style>${styleText(PREVIEW_CSS)}</style>`,
    "</head>",
    `<body>${body}</body>`,
    "</html>",
    "",
  ].join("\n");
}
