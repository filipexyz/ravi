// Widgets with widget.js in the page kit (JS-CONTRACT section 4): the code is
// inlined once per file after the runtime, never in the kit JSON, and a
// version without a passing audit is KIT_WIDGET_UNAUDITED.

import { describe, expect, test } from "bun:test";

import { sha256Hex } from "@/shared/widgets/hash";
import type { PageKit, WidgetScriptAudit } from "@/shared/widgets/types";

import { buildPageKit, type KitLibrarySource, type PageKitDeps } from "./build";
import { scanKitDocument } from "./html";

const WIDGET_ID = "33333333-3333-4333-8333-333333333333";
const RUNTIME = { version: "1.0.0", js: "window.ravi=window.ravi||{};", sha256: "a".repeat(64) };
const SCRIPT = 'export function mount(card, ctx) { ctx.canvas(0).textContent = "</script><!--"; return {}; }\n';
const SHA = sha256Hex(SCRIPT);
const MANIFEST = JSON.stringify({
  name: "Vendas",
  description: "Vendas do mês.",
  fields: { titulo: { type: "text", required: true }, total: { type: "number" } },
});
const HTML = '<ravi-card><ravi-title>{titulo}</ravi-title><ravi-canvas label="Vendas por dia"></ravi-canvas></ravi-card>';
const PASS: WidgetScriptAudit = { status: "pass", violations: [], scriptSha256: SHA, auditedBy: "u1", auditedAt: "2026-10-17T00:00:00Z" };
const AUDIT_URL = "https://console.test/org/library/org/vendas?kind=widget";

function source(audit: WidgetScriptAudit | null): KitLibrarySource {
  return {
    itemId: WIDGET_ID,
    ref: "org/vendas",
    version: 3,
    files: [
      { path: "widget.html", content: HTML },
      { path: "widget.json", content: MANIFEST },
      { path: "widget.js", content: SCRIPT },
    ],
    scriptAudit: audit,
    auditUrl: AUDIT_URL,
  };
}

function deps(audit: WidgetScriptAudit | null): PageKitDeps {
  return {
    resolveTheme: async () => ({ ok: true, source: null }),
    resolveWidget: async () => ({ ok: true, source: source(audit) }),
    resolveWidgetItem: async () => ({ ok: true, source: source(audit) }),
    describeView: async () => ({ ok: false, message: "no view" }),
    previousPresentation: async () => null,
    now: () => new Date("2026-10-16T12:00:00Z"),
    runtime: RUNTIME,
  };
}

const page = (body: string) => `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
const TWO_TAGS = `<ravi-widget use="vendas" data='{"titulo":"Out"}'></ravi-widget>\n<ravi-widget use="org/vendas" data='{"titulo":"Nov"}'></ravi-widget>`;

function kitOf(html: string): PageKit {
  const match = /<script type="application\/json" id="ravi-kit">([^<]*)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("no kit JSON");
  return JSON.parse(match[1]) as PageKit;
}

describe("page kit and widget.js", () => {
  test("inlines the code once per file after the runtime, escaped, as text/plain; the kit JSON has only the sha", async () => {
    const result = await buildPageKit({ route: "/", visibility: "private", theme: null, files: [{ path: "index.html", html: page(TWO_TAGS) }] }, deps(PASS));
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const html = result.files[0]?.html ?? "";
    const id = `ravi-widget-js-${SHA.slice(0, 16)}`;
    const block = `<script type="text/plain" id="${id}" data-ravi-widget="org/vendas@3">`;
    expect(html.split(block)).toHaveLength(2);
    expect(html.indexOf(block)).toBeGreaterThan(html.indexOf('id="ravi-runtime"'));
    expect(html).toContain('"<\\/script><\\!--"');
    const kit = kitOf(html);
    expect(kit.widgets["org/vendas"]?.script).toEqual({ sha256: SHA, bytes: new TextEncoder().encode(SCRIPT).length });
    expect(JSON.stringify(kit)).not.toContain("export function");
    // The static prerender is unchanged: an empty labelled region.
    expect(html).toContain('<div class="ravi-canvas" role="region" aria-label="Vendas por dia" data-ravi-canvas="0"></div>');
    expect(result.presentation.widgets).toEqual([{ itemId: WIDGET_ID, ref: "org/vendas", version: 3 }]);
  });

  test("re-shipping a downloaded page removes the old code blocks first", async () => {
    const first = await buildPageKit({ route: "/", visibility: "public", theme: null, files: [{ path: "index.html", html: page(TWO_TAGS) }] }, deps(PASS));
    const html = first.files[0]?.html ?? "";
    expect(scanKitDocument(html).injected.map((block) => block.id)).toContain(`ravi-widget-js-${SHA.slice(0, 16)}`);
    const again = await buildPageKit({ route: "/", visibility: "public", theme: null, files: [{ path: "index.html", html }] }, deps(PASS));
    expect(again.files[0]).toEqual({ path: "index.html", changed: false });
  });

  test("KIT_WIDGET_UNAUDITED without a passing audit for this script, with the widget and the audit URL", async () => {
    for (const audit of [null, { ...PASS, status: "fail" as const }, { ...PASS, scriptSha256: "b".repeat(64) }]) {
      const result = await buildPageKit({ route: "/", visibility: "public", theme: null, files: [{ path: "index.html", html: page(TWO_TAGS) }] }, deps(audit));
      const unaudited = result.diagnostics.filter((diagnostic) => diagnostic.code === "KIT_WIDGET_UNAUDITED");
      expect(unaudited).toHaveLength(2);
      expect(unaudited[0]).toMatchObject({ severity: "error", widget: "org/vendas@3", url: AUDIT_URL, path: "index.html", line: 7 });
      expect(unaudited[0]?.message).toContain(AUDIT_URL);
    }
  });
});
