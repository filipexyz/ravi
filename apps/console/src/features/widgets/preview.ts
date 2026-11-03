// Previews of themes and widgets in the Console, computed in the browser with
// the shared engine and shown in an `<iframe sandbox="" srcdoc>` (no
// scripts, opaque origin). Only example data ever reaches them: a widget's
// example.json, or values invented from its field types (decision W9).

import { normalizeStaticRecords, exampleFromTypes } from "@/shared/widgets/render/static";
import { renderPreviewDocument } from "@/shared/widgets/render/document";
import { renderDefaultCard } from "@/shared/widgets/render/card";
import { messageLocale, messages } from "@/shared/widgets/render/messages";
import { escapeAttr, escapeHtml, h, toHtml, type VNode } from "@/shared/widgets/render/vnode";
import { PIECES_CSS } from "@/shared/widgets/pieces.css";
import { compileWidget } from "@/shared/widgets/template/compile";
import { compileTheme } from "@/shared/widgets/theme/compile";
import { defaultCompiledTheme } from "@/shared/widgets/theme/default";
import {
  WIDGET_VARIANTS,
  type CompiledTheme,
  type CompiledWidget,
  type Diagnostic,
  type LibraryFileText,
  type RenderRecord,
  type ThemeMode,
  type WidgetFieldSpec,
  type WidgetManifest,
  type WidgetVariant,
} from "@/shared/widgets/types";

export type PreviewMode = "both" | ThemeMode;
export type PreviewVariant = "all" | WidgetVariant;
export type PreviewView = { mode: PreviewMode; variant: PreviewVariant };

/**
 * The frame's own policy on top of the sandbox: inline styles and `data:`
 * images only, so a preview never fetches anything (an example image URL
 * shows its alt text instead).
 */
export const PREVIEW_FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'";

/**
 * A preview document ready for `srcdoc`: the CSP, links that cannot
 * navigate the frame (`target=_blank` without `allow-popups` does nothing),
 * the color scheme of a single mode, and CSS that hides the panes and
 * variants outside `view`.
 */
export function framePreviewDocument(html: string, view: Partial<PreviewView> = {}, csp: string = PREVIEW_FRAME_CSP) {
  const hidden: string[] = [];
  if (view.mode === "light") hidden.push('.ravi-preview-pane[data-ravi-mode="dark"]');
  if (view.mode === "dark") hidden.push('.ravi-preview-pane[data-ravi-mode="light"]');
  if (view.variant && view.variant !== "all") hidden.push(`.ravi-preview-variant:not([aria-labelledby$="-${view.variant}"])`);
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<base target="_blank">',
    ...(hidden.length ? [`<style>${hidden.join(", ")} { display: none !important; }</style>`] : []),
  ].join("\n");
  let out = /<head>/i.test(html) ? html.replace(/<head>/i, `<head>\n${head}`) : `${head}\n${html}`;
  if (view.mode === "light" || view.mode === "dark") out = out.replace(/<html(\s|>)/i, `<html data-theme="${view.mode}"$1`);
  return out;
}

/** The theme a preview uses: the files compiled (the draft when they have errors), else the default theme. */
export function previewTheme(files: readonly LibraryFileText[] | null | undefined): { theme: CompiledTheme; diagnostics: Diagnostic[] } {
  if (!files) return { theme: defaultCompiledTheme(), diagnostics: [] };
  const result = compileTheme(files);
  return { theme: result.theme ?? result.draft ?? defaultCompiledTheme(), diagnostics: result.diagnostics };
}

/** Variants a compiled widget renders, `default` first. */
export function widgetVariants(widget: Pick<CompiledWidget, "variants">): WidgetVariant[] {
  const present = WIDGET_VARIANTS.filter((variant) => Array.isArray(widget.variants[variant]));
  return ["default", ...present.filter((variant) => variant !== "default")];
}

export type WidgetPreviewResult = {
  /** Null when the files have errors. */
  html: string | null;
  widget: CompiledWidget | null;
  manifest: WidgetManifest | null;
  diagnostics: Diagnostic[];
  /** Example values that do not fit their field: shown as warnings on example.json, never blocking. */
  dataDiagnostics: Diagnostic[];
  /** True when the values were invented from the field types (no example.json). */
  invented: boolean;
  /** The records the preview renders, in order (what widget.js code gets as `ctx.record`). */
  records: RenderRecord[];
};

/** Compiles a widget's files and renders its preview with `theme` and its example data. */
export function widgetPreview(input: {
  files: readonly LibraryFileText[];
  theme: CompiledTheme;
  /** The document's heading; the widget's name when absent. */
  title?: string;
  now?: Date;
}): WidgetPreviewResult {
  const compiled = compileWidget(input.files);
  const { widget, manifest, diagnostics } = compiled;
  if (!widget) return { html: null, widget: null, manifest, diagnostics, dataDiagnostics: [], invented: false, records: [] };
  const invented = compiled.example.length === 0;
  const data = invented ? [exampleFromTypes(widget.fields, { locale: input.theme.locale })] : compiled.example;
  const normalized = normalizeStaticRecords(widget.fields, data);
  const html = renderPreviewDocument({
    widget,
    theme: input.theme,
    records: normalized.records,
    columns: normalized.columns,
    users: normalized.users,
    title: input.title ?? widget.name,
    locale: input.theme.locale,
    ...(input.now ? { now: input.now } : {}),
  });
  const dataDiagnostics = normalized.diagnostics.map((diagnostic): Diagnostic => ({
    ...diagnostic,
    severity: "warning",
    file: diagnostic.file ?? "example.json",
  }));
  return { html, widget, manifest, diagnostics, dataDiagnostics, invented, records: normalized.records };
}

// ---------------------------------------------------------------------------
// The default card: what pages draw when no widget applies

const CARD_FIELDS: Record<string, WidgetFieldSpec> = {
  titulo: { type: "text", label: "Pedido" },
  status: { type: "status", label: "Status" },
  prazo: { type: "date", label: "Prazo" },
  responsavel: { type: "person", label: "Responsável" },
  etiquetas: { type: "multi_select", label: "Etiquetas" },
  valor: { type: "number", label: "Valor" },
};

const CARD_RECORDS = [
  {
    titulo: "Pedido 1042",
    status: { name: "Em andamento", group: "in_progress" },
    prazo: "2026-10-20",
    responsavel: { name: "Ana Souza" },
    etiquetas: ["Urgente", "Atacado"],
    valor: 1890.5,
  },
  {
    titulo: "Pedido 1043",
    status: { name: "Concluído", group: "done" },
    prazo: "2026-10-12",
    responsavel: { name: "Bruno Lima" },
    etiquetas: ["Varejo"],
    valor: 320,
  },
];

const FRAME_CSS = `
  body { margin: 0; background: var(--color-background-secondary, #f3f5f8); color: var(--color-text-primary, #17202a); font-family: var(--font-sans, system-ui, sans-serif); }
  .ravi-preview { padding: 1rem; }
  .ravi-preview > h1 { margin: 0 0 1rem; font-size: var(--font-heading-md-size, 1.25rem); }
  .ravi-preview-panes { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); }
  .ravi-preview-pane { min-inline-size: 0; padding: 1rem; background: var(--color-background-primary); color: var(--color-text-primary); border: 1px solid var(--color-border-secondary); border-radius: var(--border-radius-xl, 12px); }
  .ravi-preview-pane > h2 { margin: 0 0 0.75rem; font-size: var(--font-heading-sm-size, 1rem); }
  .ravi-preview-frame { max-inline-size: 24rem; }
`;

function styleText(css: string) {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

function paneStyle(vars: Record<string, string>, mode: ThemeMode) {
  return [...Object.entries(vars).map(([name, value]) => `${name}: ${value}`), `color-scheme: ${mode}`].join("; ");
}

/** A standalone document with the default card for two invented records, light and dark side by side. No script. */
export function defaultCardPreviewDocument(input: { theme: CompiledTheme; title: string; now?: Date }) {
  const { theme } = input;
  const lang = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(theme.locale) ? theme.locale : messageLocale(theme.locale);
  const msgs = messages(lang);
  const { records, columns, users } = normalizeStaticRecords(CARD_FIELDS, CARD_RECORDS);
  const pane = (mode: ThemeMode): VNode => {
    const headingId = `preview-${mode}`;
    return h(
      "section",
      { class: "ravi-preview-pane", "data-ravi-mode": mode, "aria-labelledby": headingId, style: paneStyle(theme.vars[mode], mode) },
      h("h2", { id: headingId }, mode === "light" ? msgs.previewLight : msgs.previewDark),
      h(
        "ul",
        { class: "ravi-list ravi-preview-frame", role: "list" },
        records.map((record, index) =>
          h(
            "li",
            null,
            renderDefaultCard(
              { record, titleKey: "titulo", fieldKeys: Object.keys(CARD_FIELDS), coverKey: null },
              {
                locale: lang,
                timeZone: "UTC",
                now: input.now ?? new Date(),
                fields: theme.fields,
                users,
                columns,
                can: { write: new Set(), create: false, archive: false },
                variant: "default",
                headingLevel: 3,
                idPrefix: `${mode}-card-${index}`,
                interactive: false,
              },
            ),
          ),
        ),
      ),
    );
  };
  const body = toHtml(h("main", { class: "ravi-preview" }, h("h1", null, input.title), h("div", { class: "ravi-preview-panes" }, pane("light"), pane("dark"))));
  return [
    "<!doctype html>",
    `<html lang="${escapeAttr(lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style id="ravi-theme">${styleText(theme.css)}</style>`,
    `<style id="ravi-pieces">${styleText(PIECES_CSS)}</style>`,
    `<style>${styleText(FRAME_CSS)}</style>`,
    "</head>",
    `<body>${body}</body>`,
    "</html>",
    "",
  ].join("\n");
}
