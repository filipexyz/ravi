import { describe, expect, test } from "bun:test";

import { EXAMPLE_WIDGET_FILES } from "@/shared/widgets/template/catalog-text";
import { DEFAULT_THEME_FILES, defaultCompiledTheme } from "@/shared/widgets/theme/default";

import { defaultCardPreviewDocument, framePreviewDocument, PREVIEW_FRAME_CSP, previewTheme, widgetPreview, widgetVariants } from "./preview";

const NOW = new Date("2026-10-16T12:00:00Z");
const withoutExample = EXAMPLE_WIDGET_FILES.filter((file) => file.path !== "example.json");

describe("framePreviewDocument", () => {
  const html = '<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n</head>\n<body></body>\n</html>\n';

  test("adds the frame policy and inert links right after <head>", () => {
    const framed = framePreviewDocument(html);
    expect(framed).toContain(`<head>\n<meta http-equiv="Content-Security-Policy" content="${PREVIEW_FRAME_CSP}">\n<base target="_blank">`);
    expect(PREVIEW_FRAME_CSP).toContain("default-src 'none'");
    expect(PREVIEW_FRAME_CSP).toContain("img-src data:");
    expect(framed).not.toContain("display: none");
    expect(framed).toContain('<html lang="pt-BR">');
  });

  test("shows one mode: hides the other pane and forces the scheme", () => {
    const dark = framePreviewDocument(html, { mode: "dark" });
    expect(dark).toContain('.ravi-preview-pane[data-ravi-mode="light"] { display: none !important; }');
    expect(dark).toContain('<html data-theme="dark" lang="pt-BR">');
    expect(framePreviewDocument(html, { mode: "light" })).toContain('.ravi-preview-pane[data-ravi-mode="dark"]');
  });

  test("shows one variant", () => {
    expect(framePreviewDocument(html, { variant: "compact" })).toContain('.ravi-preview-variant:not([aria-labelledby$="-compact"])');
    expect(framePreviewDocument(html, { variant: "all" })).not.toContain("ravi-preview-variant");
  });

  test("prepends the policy to a document without <head>", () => {
    expect(framePreviewDocument("<p>x</p>").startsWith("<meta http-equiv")).toBe(true);
  });
});

describe("previewTheme", () => {
  test("falls back to the default theme", () => {
    expect(previewTheme(null).theme.hash).toBe(defaultCompiledTheme().hash);
    expect(previewTheme([]).theme.hash).toBe(defaultCompiledTheme().hash);
  });

  test("uses the draft when the theme has errors", () => {
    const failing = JSON.stringify({
      $description: "x",
      color: { light: { text: { primary: { $type: "color", $value: "#fbfcfd" } } } },
    });
    const { theme, diagnostics } = previewTheme([{ path: "theme.json", content: failing }]);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "THEME_CONTRAST")).toBe(true);
    expect(theme.vars.light["--color-text-primary"]).toBe("#fbfcfd");
  });

  test("compiles the default theme files", () => {
    expect(previewTheme(DEFAULT_THEME_FILES).theme.hash).toBe(defaultCompiledTheme().hash);
  });
});

describe("widgetPreview", () => {
  const theme = defaultCompiledTheme();

  test("renders every variant with example.json", () => {
    const result = widgetPreview({ files: EXAMPLE_WIDGET_FILES, theme, title: "Prévia", now: NOW });
    expect(result.html).toContain("Pedido 1042");
    expect(result.html).toContain('data-ravi-mode="light"');
    expect(result.html).toContain('data-ravi-mode="dark"');
    expect(result.html).not.toContain("<script");
    expect(result.invented).toBe(false);
    expect(widgetVariants(result.widget!)).toEqual(["default", "compact"]);
  });

  test("invents values from the field types without example.json", () => {
    const result = widgetPreview({ files: withoutExample, theme, title: "Prévia", now: NOW });
    expect(result.invented).toBe(true);
    expect(result.html).toContain("Pedido de exemplo");
  });

  test("reports example values that do not fit as warnings on example.json", () => {
    const files = [...withoutExample, { path: "example.json", content: '{ "titulo": "Pedido 7", "valor": "muito" }' }];
    const result = widgetPreview({ files, theme, title: "Prévia", now: NOW });
    expect(result.html).toContain("Pedido 7");
    expect(result.dataDiagnostics.length).toBeGreaterThan(0);
    expect(result.dataDiagnostics.every((diagnostic) => diagnostic.severity === "warning" && diagnostic.file === "example.json")).toBe(true);
  });

  test("has no document when the files have errors", () => {
    const files = withoutExample.map((file) => (file.path === "widget.html" ? { ...file, content: "<ravi-card><ravi-title>{nada}</ravi-title></ravi-card>" } : file));
    const result = widgetPreview({ files, theme, title: "Prévia", now: NOW });
    expect(result.html).toBeNull();
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.file === "widget.html")).toBe(true);
  });
});

describe("defaultCardPreviewDocument", () => {
  test("renders two default cards in light and dark panes with the theme", () => {
    const theme = defaultCompiledTheme();
    const html = defaultCardPreviewDocument({ theme, title: "Cartão padrão", now: NOW });
    expect(html).toContain("<title>Cartão padrão</title>");
    expect(html.match(/class="ravi-card ravi-default-card"/g)?.length).toBe(4);
    expect(html).toContain("Pedido 1043");
    expect(html).toContain(theme.css.slice(0, 40));
    expect(html).not.toContain("<script");
  });
});
