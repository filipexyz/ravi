import { describe, expect, test } from "bun:test";

import { PIECES_CSS } from "../pieces.css";
import { defaultCompiledTheme } from "../theme/default";
import type { CompiledTheme } from "../types";
import { renderPreviewDocument } from "./document";
import { normalizeStaticRecords } from "./static";
import { NOW, orderWidget } from "./test-fixtures";

function preview(overrides: Partial<Parameters<typeof renderPreviewDocument>[0]> = {}) {
  const widget = orderWidget();
  const { records, columns, users } = normalizeStaticRecords(widget.fields, [
    { titulo: "Pedido 1", status: { name: "Em produção", color: "blue", group: "in_progress" }, cliente: "Loja Exemplo", prazo: "2026-10-18", responsavel: "Ana Souza", valor: 1250 },
    { titulo: "Pedido 2", status: { name: "Entregue", color: "green", group: "done" }, valor: 90 },
  ]);
  return renderPreviewDocument({
    widget,
    theme: defaultCompiledTheme(),
    records,
    columns,
    users,
    title: "Cartão de pedido",
    locale: "pt-BR",
    now: NOW,
    timeZone: "America/Sao_Paulo",
    ...overrides,
  });
}

describe("renderPreviewDocument", () => {
  test("a standalone document with lang, theme and pieces CSS, and no script", () => {
    const html = preview();
    expect(html.startsWith("<!doctype html>\n<html lang=\"pt-BR\">")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>Cartão de pedido</title>");
    expect(html).toContain(`<style id="ravi-theme">${defaultCompiledTheme().css}</style>`);
    expect(html).toContain(`<style id="ravi-pieces">${PIECES_CSS}</style>`);
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  test("light and dark panes side by side, each with its theme variables", () => {
    const html = preview();
    const theme = defaultCompiledTheme();
    expect(html).toContain('<section class="ravi-preview-pane" data-ravi-mode="light" aria-labelledby="preview-light" style="');
    expect(html).toContain('<section class="ravi-preview-pane" data-ravi-mode="dark" aria-labelledby="preview-dark" style="');
    expect(html).toContain(`--color-background-primary: ${theme.vars.light["--color-background-primary"]}`);
    expect(html).toContain(`--color-background-primary: ${theme.vars.dark["--color-background-primary"]}`);
    expect(html).toContain("color-scheme: dark");
    expect(html).toContain('<h2 id="preview-light">Claro</h2>');
    expect(html).toContain('<h2 id="preview-dark">Escuro</h2>');
  });

  test("every variant for every record, in both panes, with buttons disabled", () => {
    const html = preview();
    for (const mode of ["light", "dark"]) {
      expect(html).toContain(`<h3 id="preview-${mode}-default">Variante default</h3>`);
      expect(html).toContain(`<h3 id="preview-${mode}-compact">Variante compact</h3>`);
    }
    expect(html.match(/<article /g)?.length).toBe(8);
    expect(html.match(/>Pedido 1<\/h4>/g)?.length).toBe(4);
    expect(html).toContain('id="light-default-0-title1"');
    expect(html).toContain('id="dark-compact-1-title1"');
    expect(html.match(/aria-label="Concluir: Pedido 1" data-ravi-action="0" disabled aria-disabled="true"/g)?.length).toBe(2);
    expect(html).not.toContain("<select");
    expect(html).toContain("Ana Souza");
    expect(html).toContain('Loja Exemplo · <time datetime="2026-10-18">em 2 dias</time>');
  });

  test("escapes the title and theme variables; keeps </style> out of styles", () => {
    const theme = defaultCompiledTheme();
    const hostile: CompiledTheme = {
      ...theme,
      css: `${theme.css}\n/* </style><script>alert(1)</script> */`,
      vars: { ...theme.vars, light: { ...theme.vars.light, "--x": '"><script>alert(1)</script>' } },
    };
    const html = preview({ theme: hostile, title: "<b>Pedido</b>", locale: "en" });
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).toContain("<title>&lt;b&gt;Pedido&lt;/b&gt;</title>");
    expect(html).toContain("\\3c /style>\\3c script>");
    expect(html.match(/<\/style>/g)?.length).toBe(3);
    // The hostile variable is dropped; the pane keeps the others.
    expect(html).toContain(`--color-background-primary: ${theme.vars.light["--color-background-primary"]}`);
    expect(html).not.toContain("--x:");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<h2 id="preview-light">Light</h2>');
  });

  test("no records shows the empty state", () => {
    const html = preview({ records: [] });
    expect(html).toContain('<p class="ravi-status">Nenhum item por aqui.</p>');
  });

  test("invalid locales fall back", () => {
    expect(preview({ locale: '"><x' })).toContain('<html lang="en">');
  });
});
