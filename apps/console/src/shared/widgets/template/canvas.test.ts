// `<ravi-canvas>` and `widget.js` in the compiler, the renderer and the
// accessibility lint (JS-CONTRACT sections 1-3).

import { describe, expect, test } from "bun:test";

import { sha256Hex } from "../hash";
import { makeCtx } from "../render/test-fixtures";
import { toHtml } from "../render/vnode";
import { renderWidget } from "../render/widget";
import { normalizeStaticRecord } from "../render/static";
import type { LibraryFileText } from "../types";
import { catalogText } from "./catalog-text";
import { compileWidget } from "./compile";

const JSON_FILE = `{
  "name": "Vendas",
  "description": "Vendas do mês com gráfico.",
  "fields": {
    "titulo": { "type": "text", "required": true },
    "total": { "type": "number" }
  }
}`;

const HTML = `<ravi-card>
  <ravi-title>{titulo}</ravi-title>
  <ravi-canvas label="Vendas por dia" height="20rem"></ravi-canvas>
  <ravi-canvas label="{titulo}"></ravi-canvas>
</ravi-card>`;

const SCRIPT = "export function mount(card, ctx) { return { update() {}, destroy() {} }; }\n";

const files = (html = HTML, script: string | null = SCRIPT, json = JSON_FILE): LibraryFileText[] => [
  { path: "widget.json", content: json },
  { path: "widget.html", content: html },
  ...(script === null ? [] : [{ path: "widget.js", content: script }]),
];

const codes = (list: LibraryFileText[]) => compileWidget(list).diagnostics.map((diagnostic) => diagnostic.code);

describe("widget.js in the compiler", () => {
  test("compiled widget carries the script's sha and size, never the code", () => {
    const { widget, diagnostics } = compileWidget(files());
    expect(diagnostics).toEqual([]);
    expect(widget?.script).toEqual({ sha256: sha256Hex(SCRIPT), bytes: SCRIPT.length });
    expect(JSON.stringify(widget)).not.toContain("export function");
  });

  test("the hash covers the script; without one it is what it was before widgets had code", () => {
    const base = compileWidget(files(HTML.replace(/<ravi-canvas[^\n]*\n/g, ""), null)).widget;
    const withScript = compileWidget(files(HTML.replace(/<ravi-canvas[^\n]*\n/g, ""))).widget;
    const other = compileWidget(files(HTML.replace(/<ravi-canvas[^\n]*\n/g, ""), `${SCRIPT}// v2\n`)).widget;
    expect(base?.script).toBeNull();
    expect(withScript?.hash).not.toBe(base?.hash);
    expect(other?.hash).not.toBe(withScript?.hash);
  });

  test("script diagnostics refuse the widget", () => {
    const result = compileWidget(files(HTML, "export default 1;"));
    expect(result.widget).toBeNull();
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.file])).toEqual([["WIDGET_JS_NO_MOUNT", "widget.js"]]);
  });

  test("scriptActions in widget.json is reserved", () => {
    const json = JSON_FILE.replace('"fields"', '"scriptActions": [],\n  "fields"');
    expect(codes(files(HTML, SCRIPT, json))).toContain("WIDGET_JS_ACTIONS_UNSUPPORTED");
  });
});

describe("<ravi-canvas>", () => {
  test("needs widget.js", () => {
    const result = compileWidget(files(HTML, null));
    expect(result.widget).toBeNull();
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "WIDGET_CANVAS_WITHOUT_SCRIPT")).toHaveLength(2);
    expect(result.diagnostics[0]).toMatchObject({ file: "widget.html", line: 3 });
  });

  test("needs a label (A11Y_CANVAS_LABEL)", () => {
    expect(codes(files("<ravi-card><ravi-title>{titulo}</ravi-title><ravi-canvas></ravi-canvas></ravi-card>"))).toEqual(["A11Y_CANVAS_LABEL"]);
  });

  test("height takes a CSS length only, and the canvas takes no children", () => {
    expect(codes(files('<ravi-card><ravi-title>a</ravi-title><ravi-canvas label="x" height="calc(1px)"></ravi-canvas></ravi-card>'))).toEqual([
      "TEMPLATE_ATTRIBUTE_VALUE",
    ]);
    expect(codes(files('<ravi-card><ravi-title>a</ravi-title><ravi-canvas label="x">oi</ravi-canvas></ravi-card>'))).not.toEqual([]);
  });

  test("renders an empty labelled region numbered within the card", () => {
    const { widget } = compileWidget(files());
    if (!widget) throw new Error("no widget");
    const { record, columns } = normalizeStaticRecord(widget.fields, { titulo: "Outubro", total: 10 });
    const html = toHtml(renderWidget(widget, record, makeCtx({ columns })));
    expect(html).toContain('<div class="ravi-canvas" role="region" aria-label="Vendas por dia" data-ravi-canvas="0" style="--ravi-canvas-height: 20rem"></div>');
    expect(html).toContain('<div class="ravi-canvas" role="region" aria-label="Outubro" data-ravi-canvas="1"></div>');
  });

  test("a field label that renders empty falls back to the widget's name", () => {
    const json = JSON_FILE.replace('"required": true', '"required": false');
    const { widget } = compileWidget(files(HTML, SCRIPT, json));
    if (!widget) throw new Error("no widget");
    const { record, columns } = normalizeStaticRecord(widget.fields, {});
    expect(toHtml(renderWidget(widget, record, makeCtx({ columns })))).toContain('aria-label="Vendas" data-ravi-canvas="1"');
  });
});

describe("catalog", () => {
  test("marks widgets with code and documents widget.js and the canvas", () => {
    const text = catalogText({
      widgets: [{ ref: "org/vendas", name: "Vendas", description: "d", fields: {}, variants: ["default"], script: true }],
    });
    expect(text).toContain("### `org/vendas`: Vendas (com código)");
    expect(text).toContain("### widget.js (optional code)");
    expect(text).toContain("`ravi-canvas`");
    expect(text).toContain("KIT_WIDGET_UNAUDITED");
  });
});
