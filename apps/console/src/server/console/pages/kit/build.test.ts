import { describe, expect, test } from "bun:test";

import type { BaseViewDescribeResponse } from "@/shared/bases/types";
import { defaultCompiledTheme } from "@/shared/widgets/theme/default";
import type { PageKit, PagePresentation } from "@/shared/widgets/types";

import { buildPageKit, PAGE_KIT_MAX_OUTPUT_BYTES, type KitDiagnostic, type KitLibrarySource, type PageKitDeps, type PageKitInput } from "./build";

const VIEW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_VIEW_ID = "22222222-2222-4222-8222-222222222222";
const WIDGET_ID = "33333333-3333-4333-8333-333333333333";
const THEME_ID = "44444444-4444-4444-8444-444444444444";
const RUNTIME = { version: "1.0.0", js: 'window.ravi=window.ravi||{};"</script>"', sha256: "a".repeat(64) };
const THEME_LIVE = { js: 'window.raviThemeLive=1;"</script>"', sha256: "c".repeat(64) };

const WIDGET_MANIFEST = {
  name: "Cartão de pedido",
  description: "Pedido com status e valor.",
  fields: {
    titulo: { type: "text", required: true, label: "Pedido" },
    status: { type: "status" },
    valor: { type: "number", role: "highlight", label: "Valor" },
  },
  variants: ["default", "compact"],
};
const WIDGET_HTML = [
  '<ravi-variant name="default"><ravi-card>',
  "  <ravi-title>{titulo}</ravi-title>",
  '  <ravi-field name="status"></ravi-field>',
  '  <ravi-metric value="{valor}" label="Valor"></ravi-metric>',
  '  <ravi-button action="update" set="status=@done">Concluir</ravi-button>',
  "</ravi-card></ravi-variant>",
  '<ravi-variant name="compact"><ravi-card tone="subtle"><ravi-title>{titulo}</ravi-title></ravi-card></ravi-variant>',
].join("\n");

function widgetSource(overrides: { manifest?: unknown; html?: string; version?: number } = {}): KitLibrarySource {
  return {
    itemId: WIDGET_ID,
    ref: "org/pedido-card",
    version: overrides.version ?? 2,
    files: [
      { path: "widget.html", content: overrides.html ?? WIDGET_HTML },
      { path: "widget.json", content: JSON.stringify(overrides.manifest ?? WIDGET_MANIFEST) },
    ],
  };
}

function themeSource(input: { version?: number; locale?: string } = {}): KitLibrarySource {
  const theme = {
    $description: "Tema da clínica.",
    $extensions: { ravi: { name: "Clínica", locale: input.locale ?? "pt-BR" } },
    color: { light: { text: { primary: { $type: "color", $value: "#102030" } } } },
  };
  return { itemId: THEME_ID, ref: "org/clinica", version: input.version ?? 3, files: [{ path: "theme.json", content: JSON.stringify(theme) }] };
}

const STATUS_OPTIONS = [
  { id: "o1", name: "A fazer", color: "gray", group: "todo" },
  { id: "o2", name: "Feito", color: "green", group: "done" },
];

function view(overrides: Partial<BaseViewDescribeResponse> = {}): BaseViewDescribeResponse {
  return {
    id: VIEW_ID,
    baseId: "55555555-5555-4555-8555-555555555555",
    name: "Pedidos",
    description: null,
    layout: { type: "list" },
    version: 1,
    columns: [
      { key: "pedido", name: "Pedido", type: "text", config: {}, required: true },
      { key: "fase", name: "Fase", type: "status", config: { options: STATUS_OPTIONS }, required: false },
      { key: "total", name: "Total", type: "number", config: {}, required: false },
    ],
    capabilities: { read: true, aggregateOnly: false, writeColumns: ["fase"], create: true, archive: false, manage: false },
    valid: true,
    ...overrides,
  } as BaseViewDescribeResponse;
}

function deps(overrides: Partial<PageKitDeps> & { theme?: KitLibrarySource | null; views?: Record<string, BaseViewDescribeResponse | null> } = {}): PageKitDeps {
  const views = overrides.views ?? { [VIEW_ID]: view() };
  return {
    resolveTheme: async (ref) => {
      if (ref === null) return { ok: true, source: overrides.theme === undefined ? null : overrides.theme };
      if (ref === "org/clinica" || ref === "clinica") return { ok: true, source: themeSource() };
      return { ok: false, code: "KIT_THEME_NOT_FOUND", message: `Theme ${ref} does not exist.` };
    },
    resolveWidget: async (ref) =>
      ref === "pedido-card" || ref === "org/pedido-card"
        ? { ok: true, source: widgetSource() }
        : { ok: false, code: "KIT_WIDGET_NOT_FOUND", message: `Widget ${ref} does not exist.` },
    resolveWidgetItem: async (itemId) =>
      itemId === WIDGET_ID ? { ok: true, source: widgetSource() } : { ok: false, code: "KIT_WIDGET_NOT_FOUND", message: "the item no longer exists" },
    describeView: async (viewId) => {
      const found = views[viewId];
      return found ? { ok: true, view: found } : { ok: false, message: "not found in this project, or the view does not admit you" };
    },
    previousPresentation: async () => null,
    now: () => new Date("2026-10-16T12:00:00Z"),
    runtime: RUNTIME,
    themeLive: THEME_LIVE,
    ...overrides,
  };
}

function input(html: string, overrides: Partial<PageKitInput> = {}): PageKitInput {
  return { route: "/", visibility: "public", theme: null, files: [{ path: "index.html", html }], ...overrides };
}

function page(body: string) {
  return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Pedidos</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

function kitOf(html: string): PageKit {
  const match = /<script type="application\/json" id="ravi-kit">([^<]*)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("no kit JSON");
  return JSON.parse(match[1]) as PageKit;
}

const errors = (result: { diagnostics: KitDiagnostic[] }) => result.diagnostics.filter((item) => item.severity === "error");
/** Diagnostics other than the default-theme notice most tests ship under (no theme pointer). */
const noted = (result: { diagnostics: KitDiagnostic[] }) => result.diagnostics.filter((item) => item.code !== "KIT_THEME_DEFAULT");

describe("buildPageKit files", () => {
  test("a file with no tags and no theme stays byte-identical", async () => {
    const html = page("<p>Olá</p>");
    const result = await buildPageKit(input(html), deps());
    // An unchanged file is not sent back.
    expect(result.files).toEqual([{ path: "index.html", changed: false }]);
    expect(result.uses).toEqual([]);
    expect(result.presentation).toEqual({ v: 1, runtime: null, theme: null, themeSource: "effective", widgets: [] });
    expect(result.diagnostics).toEqual([]);
  });

  test("with an org theme and no tags, a public page gets the theme style and lang only", async () => {
    const result = await buildPageKit(input(page("<p>Olá</p>")), deps({ theme: themeSource() }));
    const [file] = result.files;
    expect(file?.changed).toBe(true);
    expect(file?.html).toContain('<html lang="pt-BR">');
    expect(file?.html).toMatch(/<meta charset="utf-8"><style id="ravi-theme" data-ravi-theme="[0-9a-f]{64}">@layer ravi\.theme/);
    expect(file?.html).not.toContain("ravi-pieces");
    expect(file?.html).not.toContain("ravi-runtime");
    expect(result.presentation.theme).toMatchObject({ itemId: THEME_ID, ref: "org/clinica", version: 3 });
    expect(result.presentation.runtime).toBeNull();
    expect(result.uses).toEqual([]);
  });

  test("a private page without tags following the pointer gets the theme-live script, not the runtime", async () => {
    const result = await buildPageKit(input(page("<p>Olá</p>"), { visibility: "private" }), deps({ theme: themeSource() }));
    const html = result.files[0]?.html ?? "";
    expect(html).toContain(`<script id="ravi-runtime" data-ravi-runtime="theme-live">window.raviThemeLive=1;"<\\/script>"</script>`);
    expect(html).not.toContain(RUNTIME.js.slice(0, 20));
    expect(html).not.toContain("ravi-pieces");
    const kit = kitOf(html);
    expect(kit.theme).toMatchObject({ ref: { itemId: THEME_ID, ref: "org/clinica", version: 3 }, live: true, locale: "pt-BR" });
    expect(kit.instances).toEqual({});
    expect(kit.uses).toEqual(["ravi.pages.theme.get"]);
    // Always allowlisted by the exec host, so never declared: declaring it would drop the curated platform ids.
    expect(result.uses).toEqual([]);
    expect(result.presentation.runtime).toEqual({ version: "1.0.0", sha256: THEME_LIVE.sha256 });
    const again = await buildPageKit(input(html, { visibility: "private" }), deps({ theme: themeSource() }));
    expect(again.files).toEqual([{ path: "index.html", changed: false }]);

    const explicit = await buildPageKit(input(page("<p>Olá</p>"), { visibility: "private", theme: "org/clinica" }), deps());
    expect(explicit.files[0]?.html).not.toContain("ravi-runtime");
    expect(explicit.uses).toEqual([]);
    expect(explicit.presentation.themeSource).toBe("explicit");
  });

  test("a private page with tags gets the whole runtime; ravi.pages.theme.get stays in the page kit only", async () => {
    const source = page(`<ravi-view view="${VIEW_ID}"></ravi-view>`);
    for (const theme of [themeSource(), null]) {
      const result = await buildPageKit(input(source, { visibility: "private" }), deps({ theme }));
      const html = result.files[0]?.html ?? "";
      expect(html).toContain('<script id="ravi-runtime" data-version="1.0.0">');
      expect(html).not.toContain("theme-live");
      expect(kitOf(html).theme?.live).toBe(true);
      expect(kitOf(html).uses).toContain("ravi.pages.theme.get");
      expect(result.uses).not.toContain("ravi.pages.theme.get");
      expect(result.presentation.runtime).toEqual({ version: "1.0.0", sha256: RUNTIME.sha256 });
    }
  });

  test("theme none with tags gets the default theme, no Library theme in the presentation, and no live refresh", async () => {
    const result = await buildPageKit(
      input(page(`<ravi-view view="${VIEW_ID}"></ravi-view>`), { visibility: "private", theme: "none" }),
      deps({ theme: themeSource() }),
    );
    const html = result.files[0]?.html ?? "";
    expect(html).toContain(`data-ravi-theme="${defaultCompiledTheme().hash}"`);
    expect(html).toContain('<style id="ravi-pieces">@layer ravi.pieces');
    expect(kitOf(html).theme).toMatchObject({ ref: null, live: false });
    expect(result.presentation.theme).toBeNull();
    expect(result.presentation.themeSource).toBe("none");
    expect(result.uses).not.toContain("ravi.pages.theme.get");
  });

  test("re-shipping a shipped page gives the same bytes", async () => {
    const source = page(
      `<ravi-view view="${VIEW_ID}" widget="pedido-card"></ravi-view>\n<ravi-widget use="org/pedido-card" data='{"titulo":"Pedido 1","valor":1200}'></ravi-widget>`,
    );
    const first = await buildPageKit(input(source, { visibility: "private" }), deps({ theme: themeSource() }));
    const shipped = first.files[0]?.html ?? "";
    const second = await buildPageKit(input(shipped, { visibility: "private" }), deps({ theme: themeSource() }));
    expect(second.files).toEqual([{ path: "index.html", changed: false }]);
    expect(second.uses).toEqual(first.uses);
  });

  test("several tags get r1, r2, r3 in order, with the loading placeholder and prerendered static widgets", async () => {
    const source = page(
      [
        `<ravi-view view="${VIEW_ID}" widget="pedido-card" data-ravi-id="stale">old content</ravi-view>`,
        `<ravi-widget use="org/pedido-card" data='{"titulo":"Pedido 7","status":"Feito","valor":1200}' variant="compact"></ravi-widget>`,
        `<ravi-form view="${VIEW_ID}" fields="pedido,total" submit-label="Enviar"><p>sem script</p></ravi-form>`,
      ].join("\n"),
    );
    const result = await buildPageKit(input(source), deps());
    expect(errors(result)).toEqual([]);
    const html = result.files[0]?.html ?? "";
    expect(html).toContain(`<ravi-view view="${VIEW_ID}" widget="pedido-card" data-ravi-id="r1"><p class="ravi-status" role="status">Carregando…</p></ravi-view>`);
    expect(html).toMatch(/<ravi-widget data-ravi-id="r2" use="org\/pedido-card"[^>]*><article[^>]*class="ravi-card[^"]*"[^>]*data-ravi-row=""[^>]*>.*Pedido 7.*<\/article><\/ravi-widget>/);
    expect(html).toContain(`<ravi-form data-ravi-id="r3" view="${VIEW_ID}" fields="pedido,total" submit-label="Enviar"><p>sem script</p></ravi-form>`);

    const kit = kitOf(html);
    expect(Object.keys(kit.instances)).toEqual(["r1", "r2", "r3"]);
    expect(kit.instances.r1).toEqual({ tag: "ravi-view", view: VIEW_ID, widget: "org/pedido-card", fields: { titulo: "pedido", status: "fase", valor: "total" }, variant: "default" });
    expect(kit.instances.r2).toEqual({ tag: "ravi-widget", view: null, widget: "org/pedido-card", fields: {}, variant: "compact" });
    expect(kit.instances.r3).toEqual({ tag: "ravi-form", view: VIEW_ID, widget: null, fields: {}, variant: "default" });
    expect(Object.keys(kit.widgets)).toEqual(["org/pedido-card"]);
    expect(kit.widgets["org/pedido-card"]?.ref).toEqual({ itemId: WIDGET_ID, ref: "org/pedido-card", version: 2 });
    expect(kit.actions).toEqual([
      { id: "ravi.bases.views.describe", viewId: VIEW_ID },
      { id: "ravi.bases.views.query", viewId: VIEW_ID },
      { id: "ravi.bases.views.rows.create", viewId: VIEW_ID },
      // The widget's update derives rows.update, and the record dialog that comes with it reads the row.
      { id: "ravi.bases.views.rows.get", viewId: VIEW_ID },
      { id: "ravi.bases.views.rows.update", viewId: VIEW_ID },
      { id: "ravi.bases.views.version", viewId: VIEW_ID },
    ]);
    expect(result.presentation.widgets).toEqual([{ itemId: WIDGET_ID, ref: "org/pedido-card", version: 2 }]);
  });
});

describe("buildPageKit resolution", () => {
  test("a view tag without widget uses the view's layout.widget and its field map", async () => {
    const bound = view({
      layout: { type: "board", groupBy: "fase", widget: { itemId: WIDGET_ID, ref: "org/pedido-card", fields: { titulo: "pedido", valor: "total" }, variant: "compact" } },
      columns: [
        { key: "pedido", name: "Pedido", type: "text", config: {}, required: true },
        { key: "nome", name: "Nome", type: "text", config: {}, required: false },
        { key: "fase", name: "Fase", type: "status", config: { options: STATUS_OPTIONS }, required: false },
        { key: "total", name: "Total", type: "number", config: {}, required: false },
      ],
    } as Partial<BaseViewDescribeResponse>);
    const result = await buildPageKit(input(page(`<ravi-view view="${VIEW_ID}" readonly></ravi-view>`)), deps({ views: { [VIEW_ID]: bound } }));
    expect(errors(result)).toEqual([]);
    const kit = kitOf(result.files[0]?.html ?? "");
    expect(kit.instances.r1).toEqual({ tag: "ravi-view", view: VIEW_ID, widget: "org/pedido-card", fields: { titulo: "pedido", status: "fase", valor: "total" }, variant: "compact" });
    // readonly drops the board move, but the widget's update button still needs rows.update (and the record dialog, rows.get).
    expect(result.uses).toEqual([
      "ravi.bases.views.describe",
      "ravi.bases.views.query",
      "ravi.bases.views.rows.get",
      "ravi.bases.views.rows.update",
      "ravi.bases.views.version",
    ]);
  });

  test("uses follow the tag: board, create, archive, readonly and the default card's editors", async () => {
    const run = async (attributes: string, described: BaseViewDescribeResponse = view()) =>
      (await buildPageKit(input(page(`<ravi-view view="${VIEW_ID}" ${attributes}></ravi-view>`)), deps({ views: { [VIEW_ID]: described } }))).uses;
    // created_time has no editor, so a plain view derives no write.
    const plain = view({ columns: [{ key: "criado", name: "Criado", type: "created_time", config: {}, required: false }] } as Partial<BaseViewDescribeResponse>);
    expect(await run("", plain)).toEqual(["ravi.bases.views.describe", "ravi.bases.views.query", "ravi.bases.views.version"]);
    expect(await run('layout="board"', plain)).toContain("ravi.bases.views.rows.update");
    expect(await run('layout="board" readonly', plain)).not.toContain("ravi.bases.views.rows.update");
    expect(await run("create archive", plain)).toEqual([
      "ravi.bases.views.describe",
      "ravi.bases.views.query",
      "ravi.bases.views.rows.archive",
      "ravi.bases.views.rows.create",
      "ravi.bases.views.version",
    ]);
    // The default card turns a status column into an editor.
    expect(await run("")).toContain("ravi.bases.views.rows.update");
    expect(await run("readonly")).not.toContain("ravi.bases.views.rows.update");
  });

  test("a required widget field without a column is an error with the tag's position and the candidate columns", async () => {
    const narrow = view({
      columns: [
        { key: "fase", name: "Fase", type: "status", config: { options: STATUS_OPTIONS }, required: false },
        { key: "total", name: "Total", type: "number", config: {}, required: false },
        { key: "outro", name: "Outro", type: "number", config: {}, required: false },
      ],
    } as Partial<BaseViewDescribeResponse>);
    const result = await buildPageKit(
      input(page(`  <ravi-view view="${VIEW_ID}" widget="pedido-card" fields="valor:total"></ravi-view>`)),
      deps({ views: { [VIEW_ID]: narrow } }),
    );
    const [error] = errors(result);
    expect(error).toMatchObject({ severity: "error", code: "WIDGET_FIELD_MISSING", path: "index.html", line: 8, column: 3 });
    expect(error?.message).toContain("titulo");
    expect(error?.message).toContain("fase: status");
  });

  test("an explicit map to a missing column is an error; a view the caller cannot see is an error only for required fields", async () => {
    const missing = await buildPageKit(input(page(`<ravi-view view="${VIEW_ID}" widget="pedido-card" fields="titulo:nada"></ravi-view>`)), deps());
    expect(errors(missing).map((item) => item.code)).toEqual(["WIDGET_FIELD_COLUMN_MISSING"]);

    const hidden = await buildPageKit(input(page(`<ravi-view view="${OTHER_VIEW_ID}" widget="pedido-card"></ravi-view>`)), deps());
    expect(errors(hidden).map((item) => item.code)).toEqual(["KIT_VIEW_UNAVAILABLE"]);

    const optional = await buildPageKit(input(page(`<ravi-view view="${OTHER_VIEW_ID}"></ravi-view>`)), deps());
    expect(errors(optional)).toEqual([]);
    expect(noted(optional)).toEqual([expect.objectContaining({ severity: "warning", code: "KIT_VIEW_UNAVAILABLE", line: 8, column: 1 })]);
    expect(optional.uses).toEqual(["ravi.bases.views.describe", "ravi.bases.views.query", "ravi.bases.views.version"]);
  });

  test("unknown widgets, themes, attributes, unclosed and nested tags are diagnostics with line and column", async () => {
    const source = [
      "<html><body>",
      '<ravi-widget use="nada"></ravi-widget>',
      `  <ravi-view view="${VIEW_ID}" colour="red" onclick="x()" data-x="1" aria-label="Pedidos"></ravi-view>`,
      `<p><ravi-view view="${VIEW_ID}"><ravi-widget use="pedido-card"></ravi-widget></ravi-view></p>`,
      // Not closed: everything after it up to </body> is inside it.
      `<ravi-view view="${VIEW_ID}"/>`,
      "</body></html>",
    ].join("\n");
    const result = await buildPageKit(input(source, { theme: "org/nada" }), deps());
    const summary = result.diagnostics.map((item) => [item.severity, item.code, item.line ?? null, item.column ?? null]);
    expect(summary).toEqual([
      ["error", "KIT_THEME_NOT_FOUND", null, null],
      ["error", "KIT_WIDGET_NOT_FOUND", 2, 1],
      ["warning", "KIT_ATTRIBUTE_UNKNOWN", 3, 3],
      ["warning", "KIT_ATTRIBUTE_UNKNOWN", 3, 3],
      ["error", "KIT_TAG_NESTED", 4, 59],
      ["error", "KIT_TAG_UNCLOSED", 5, 1],
    ]);
    expect(result.diagnostics[2]?.message).toContain("colour");
    expect(result.diagnostics[3]?.message).toContain("onclick");
  });

  test("static data in the wrong shape is an error", async () => {
    const notJson = await buildPageKit(input(page(`<ravi-widget use="pedido-card" data='{"titulo":'></ravi-widget>`)), deps());
    expect(errors(notJson).map((item) => item.code)).toEqual(["KIT_DATA_INVALID"]);
    const list = await buildPageKit(input(page(`<ravi-widget use="pedido-card" data='[1]'></ravi-widget>`)), deps());
    expect(errors(list).map((item) => item.code)).toEqual(["KIT_DATA_INVALID"]);
    const wrongType = await buildPageKit(input(page(`<ravi-widget use="pedido-card" data='{"titulo":"x","valor":"muito"}'></ravi-widget>`)), deps());
    expect(errors(wrongType).length).toBeGreaterThan(0);
  });

  test("kit JSON in the page is escaped", async () => {
    const separator = String.fromCharCode(0x2028);
    const manifest = { ...WIDGET_MANIFEST, name: `Pedido${separator}</script><script>alert(1)</script>` };
    const result = await buildPageKit(
      input(page(`<ravi-widget use="pedido-card" data='{"titulo":"a"}'></ravi-widget>`)),
      deps({ resolveWidget: async () => ({ ok: true, source: widgetSource({ manifest }) }) }),
    );
    expect(errors(result)).toEqual([]);
    const html = result.files[0]?.html ?? "";
    const json = /id="ravi-kit">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(json).toContain("\\u003c/script>");
    expect(json).toContain("\\u2028");
    expect(json).not.toContain(separator);
    expect(kitOf(html).widgets["org/pedido-card"]?.name).toBe(manifest.name);
    // The runtime's own "</script>" cannot end its block early.
    expect(html).toContain('"<\\/script>"</script>');
  });

  test("an English theme localizes the placeholder and lang", async () => {
    const result = await buildPageKit(input(page(`<ravi-view view="${VIEW_ID}"></ravi-view>`)), deps({ theme: themeSource({ locale: "en" }) }));
    const html = result.files[0]?.html ?? "";
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<p class="ravi-status" role="status">Loading…</p>');
  });

  test("warns when the theme changed since the route's last publish", async () => {
    const previous = (version: number | null): PagePresentation => ({
      v: 1,
      runtime: null,
      theme: version === null ? null : { itemId: THEME_ID, ref: "org/clinica", version, hash: "b".repeat(64) },
      widgets: [],
    });
    const run = (presentation: PagePresentation | null, theme: KitLibrarySource | null = themeSource({ version: 3 })) =>
      buildPageKit(input(page("<p>x</p>"), { route: "/pedidos" }), deps({ theme, previousPresentation: async () => presentation }));
    expect((await run(previous(2))).warnings).toEqual(["Theme changed since the last publish of /pedidos: org/clinica v2 -> v3."]);
    expect((await run(previous(3))).warnings).toEqual([]);
    expect((await run(previous(null))).warnings).toEqual(["Theme changed since the last publish of /pedidos: none -> org/clinica v3."]);
    expect((await run(previous(2), null)).warnings).toEqual(["Theme changed since the last publish of /pedidos: org/clinica v2 -> none."]);
    expect((await run(null)).warnings).toEqual([]);
  });
});

describe("buildPageKit charts and view attributes", () => {
  const CHART_ID = "66666666-6666-4666-8666-666666666666";
  const charts = (known: Record<string, string>) => ({
    describeChart: async (chartId: string) =>
      known[chartId]
        ? ({ ok: true, chart: { name: known[chartId] as string, viewId: VIEW_ID } } as const)
        : ({ ok: false, message: "not found in this project, or the view does not admit you" } as const),
  });

  test("<ravi-chart> becomes a chart instance, declares charts.data with its chartId and prerenders the loading text", async () => {
    const result = await buildPageKit(
      input(page(`<ravi-chart chart="${CHART_ID.toUpperCase()}"></ravi-chart>\n<ravi-view view="${VIEW_ID}" readonly></ravi-view>`)),
      deps(charts({ [CHART_ID]: "Pedidos por status" })),
    );
    expect(noted(result)).toEqual([]);
    const html = result.files[0]?.html ?? "";
    const kit = kitOf(html);
    expect(kit.instances.r1).toEqual({ tag: "ravi-chart", view: null, widget: null, fields: {}, variant: "default", chart: CHART_ID });
    expect(kit.actions).toContainEqual({ id: "ravi.bases.charts.data", chartId: CHART_ID });
    expect(kit.actions).toContainEqual({ id: "ravi.bases.views.query", viewId: VIEW_ID });
    expect(result.uses).toContain("ravi.bases.charts.data");
    expect(html).toContain(`<ravi-chart data-ravi-id="r1" chart="${CHART_ID}"><p class="ravi-status" role="status">Carregando…</p></ravi-chart>`);
  });

  test("a chart without an id or with a bad id is an error; one the caller cannot read warns and still ships", async () => {
    const codes = async (body: string) => (await buildPageKit(input(page(body)), deps(charts({})))).diagnostics.filter((item) => item.code !== "KIT_THEME_DEFAULT");
    expect((await codes("<ravi-chart></ravi-chart>")).map((item) => [item.severity, item.code])).toEqual([["error", "KIT_CHART_REQUIRED"]]);
    expect((await codes('<ravi-chart chart="vendas"></ravi-chart>')).map((item) => [item.severity, item.code])).toEqual([["error", "KIT_CHART_INVALID"]]);
    const hidden = await buildPageKit(input(page(`<ravi-chart chart="${CHART_ID}"></ravi-chart>`)), deps(charts({})));
    expect(errors(hidden)).toEqual([]);
    expect(noted(hidden)).toEqual([expect.objectContaining({ severity: "warning", code: "KIT_CHART_UNAVAILABLE", line: 8, column: 1 })]);
    expect(hidden.uses).toEqual(["ravi.bases.charts.data"]);
    // Without describeChart (older deps) the chart ships unchecked.
    const unchecked = await buildPageKit(input(page(`<ravi-chart chart="${CHART_ID}"></ravi-chart>`)), deps());
    expect(noted(unchecked)).toEqual([]);
  });

  test("search and searchable are known ravi-view attributes; calendar and writable views also derive rows.get", async () => {
    const run = async (attributes: string, described: BaseViewDescribeResponse = view()) =>
      buildPageKit(input(page(`<ravi-view view="${VIEW_ID}" ${attributes}></ravi-view>`)), deps({ views: { [VIEW_ID]: described } }));
    const searched = await run('search="ana" searchable where="total>10"');
    expect(noted(searched)).toEqual([]);
    const plain = view({ columns: [{ key: "pedido", name: "Pedido", type: "text", config: {}, required: true }], capabilities: { read: true, aggregateOnly: false, writeColumns: [], create: false, archive: false, manage: false, approve: [] } } as Partial<BaseViewDescribeResponse>);
    expect((await run("readonly", plain)).uses).not.toContain("ravi.bases.views.rows.get");
    expect((await run('layout="calendar" readonly', plain)).uses).toContain("ravi.bases.views.rows.get");
    // The form layout creates rows, so it derives rows.create without the create attribute (not when readonly).
    expect((await run('layout="form"', plain)).uses).toContain("ravi.bases.views.rows.create");
    expect((await run('layout="form" readonly', plain)).uses).not.toContain("ravi.bases.views.rows.create");
    // A text column is now editable inline, so the default card derives update and the record dialog's rows.get.
    expect((await run("", plain)).uses).toEqual([
      "ravi.bases.views.describe",
      "ravi.bases.views.query",
      "ravi.bases.views.rows.get",
      "ravi.bases.views.rows.update",
      "ravi.bases.views.version",
    ]);
  });
});

describe("buildPageKit limits and checks", () => {
  test("rewritten HTML past the response budget is KIT_TOO_LARGE, saying how many files fit; unchanged files do not count", async () => {
    const big = page(`<p>${"a".repeat(1_500_000)}</p>`);
    const files = ["a.html", "b.html", "c.html"].map((path) => ({ path, html: big }));
    const themed = await buildPageKit(input("", { files }), deps({ theme: themeSource() }));
    const [error] = errors(themed);
    expect(error).toMatchObject({ severity: "error", code: "KIT_TOO_LARGE", path: "c.html" });
    expect(error?.message).toContain("2 of the 3 rewritten files fit");
    expect(error?.message).toContain("--theme none");
    expect(3 * big.length).toBeGreaterThan(PAGE_KIT_MAX_OUTPUT_BYTES);

    const untouched = await buildPageKit(input("", { files }), deps());
    expect(errors(untouched)).toEqual([]);
    expect(untouched.files.every((file) => file.html === undefined && !file.changed)).toBe(true);
  });

  test("a big logo is not inlined: 50 tagless private files with a ~62 KB logo stay under budget", async () => {
    const path = `<path d="M${"1 2 L3 4 ".repeat(100)}Z" fill="#102030"/>`;
    const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${path.repeat(Math.floor(62_000 / path.length))}</svg>`;
    expect(logo.length).toBeGreaterThan(60_000);
    expect(logo.length).toBeLessThan(64 * 1024);
    const base = themeSource();
    const theme = { ...base, files: [...base.files, { path: "logo.svg", content: logo }] };
    const files = Array.from({ length: 50 }, (_, index) => ({ path: `p${index}.html`, html: page(`<p>Página ${index}</p>`) }));
    const result = await buildPageKit(input("", { visibility: "private", files }), deps({ theme }));
    expect(errors(result)).toEqual([]);
    const html = result.files[0]?.html ?? "";
    expect(html).toContain('data-ravi-runtime="theme-live"');
    const kit = kitOf(html);
    expect(kit.theme?.live).toBe(true);
    expect(kit.theme).not.toHaveProperty("logo");
    expect(kit.theme).not.toHaveProperty("fields");
    const total = result.files.reduce((sum, file) => sum + (file.html?.length ?? 0), 0);
    expect(total).toBeLessThan(PAGE_KIT_MAX_OUTPUT_BYTES / 10);

    // Files with tags keep the display rules the runtime reads, still without the logo.
    const tagged = await buildPageKit(input(page(`<ravi-view view="${VIEW_ID}"></ravi-view>`), { visibility: "private" }), deps({ theme }));
    const taggedKit = kitOf(tagged.files[0]?.html ?? "");
    expect(taggedKit.theme).toHaveProperty("fields");
    expect(taggedKit.theme).not.toHaveProperty("logo");
  });

  test("heading-level is read on ravi-widget too, and its prerender uses it", async () => {
    const data = `data='{"titulo":"Pedido 7"}'`;
    const level3 = await buildPageKit(input(page(`<ravi-widget use="pedido-card" heading-level="3" ${data}></ravi-widget>`)), deps());
    expect(noted(level3).map((item) => item.code)).toEqual(["KIT_ACTIONS_NEED_VIEW"]);
    expect(level3.files[0]?.html).toMatch(/<h3[^>]*>Pedido 7<\/h3>/);

    const invalid = await buildPageKit(input(page(`<ravi-widget use="pedido-card" heading-level="9" ${data}></ravi-widget>`)), deps());
    expect(noted(invalid).map((item) => [item.severity, item.code])).toEqual([
      ["warning", "KIT_ATTRIBUTE_INVALID"],
      ["warning", "KIT_ACTIONS_NEED_VIEW"],
    ]);
    expect(invalid.files[0]?.html).toMatch(/<h2[^>]*>Pedido 7<\/h2>/);
  });

  test("page-size takes 1 to 200 like the runtime; above 200 warns that 200 is used", async () => {
    const run = async (value: string) =>
      (await buildPageKit(input(page(`<ravi-view view="${VIEW_ID}" page-size="${value}"></ravi-view>`)), deps())).diagnostics
        .filter((item) => item.code !== "KIT_THEME_DEFAULT")
        .map((item) => item.message);
    expect(await run("200")).toEqual([]);
    expect(await run("201")).toEqual(['page-size="201" is more than the 200 rows a view loads at once; 200 is used.']);
    expect(await run("500")).toEqual(['page-size="500" is more than the 200 rows a view loads at once; 200 is used.']);
    expect(await run("0")).toEqual(['page-size="0" must be a whole number from 1 to 200; it is ignored.']);
    expect(await run("dez")).toEqual(['page-size="dez" must be a whole number from 1 to 200; it is ignored.']);
  });

  test("static data with person, email or phone values on a public route warns KIT_PERSONAL_DATA_PUBLIC", async () => {
    const manifest = {
      ...WIDGET_MANIFEST,
      fields: { ...WIDGET_MANIFEST.fields, cliente: { type: "person" }, email: { type: "email" }, telefone: { type: "phone" } },
    };
    const contactDeps = deps({ resolveWidget: async () => ({ ok: true, source: widgetSource({ manifest }) }) });
    const tag = (data: Record<string, unknown>) => page(`<ravi-widget use="pedido-card" data='${JSON.stringify(data)}'></ravi-widget>`);
    const personal = (result: { diagnostics: KitDiagnostic[] }) => result.diagnostics.filter((item) => item.code === "KIT_PERSONAL_DATA_PUBLIC");

    const filled = { titulo: "Pedido 7", cliente: "Ana Souza", email: "ana@example.com", telefone: "" };
    const onPublic = await buildPageKit(input(tag(filled)), contactDeps);
    expect(personal(onPublic)).toEqual([expect.objectContaining({ severity: "warning", path: "index.html", line: 8, column: 1 })]);
    expect(personal(onPublic)[0]?.message).toContain("cliente (person), email (email) on a public route");
    expect(personal(onPublic)[0]?.message).not.toContain("telefone");
    expect(errors(onPublic)).toEqual([]);

    expect(personal(await buildPageKit(input(tag(filled), { visibility: "private" }), contactDeps))).toEqual([]);
    expect(personal(await buildPageKit(input(tag({ titulo: "Pedido 7", email: " ", telefone: null })), contactDeps))).toEqual([]);
  });

  test("a widget with row actions used with data warns KIT_ACTIONS_NEED_VIEW, and its buttons stay out", async () => {
    const result = await buildPageKit(input(page(`<ravi-widget use="pedido-card" data='{"titulo":"Pedido 7"}'></ravi-widget>`)), deps());
    expect(errors(result)).toEqual([]);
    expect(noted(result)).toEqual([
      {
        severity: "warning",
        code: "KIT_ACTIONS_NEED_VIEW",
        message:
          'org/pedido-card\'s actions ("Concluir") only appear on a view\'s rows; with data they are left out. To show them, use <ravi-view view="<view uuid>" widget="org/pedido-card">.',
        path: "index.html",
        line: 8,
        column: 1,
      },
    ]);
    const prerender = /<ravi-widget[^>]*>([\s\S]*)<\/ravi-widget>/.exec(result.files[0]?.html ?? "")?.[1] ?? "";
    expect(prerender).toContain("Pedido 7");
    expect(prerender).not.toContain("Concluir");
    // Without actions, or on a view, nothing to say.
    const plain = deps({
      resolveWidget: async () => ({ ok: true, source: widgetSource({ html: '<ravi-card><ravi-title>{titulo}</ravi-title></ravi-card>' }) }),
    });
    expect(noted(await buildPageKit(input(page(`<ravi-widget use="pedido-card" data='{"titulo":"Pedido 7"}'></ravi-widget>`)), plain))).toEqual([]);
    expect(noted(await buildPageKit(input(page(`<ravi-view view="${VIEW_ID}" widget="pedido-card"></ravi-view>`)), deps())).map((item) => item.code)).not.toContain(
      "KIT_ACTIONS_NEED_VIEW",
    );
  });

  test("tags with no Library theme in effect warn KIT_THEME_DEFAULT once; --theme none and a theme in effect do not", async () => {
    const body = page(`<ravi-view view="${VIEW_ID}"></ravi-view>`);
    const defaulted = await buildPageKit({ ...input(body), files: [{ path: "index.html", html: body }, { path: "b.html", html: body }] }, deps());
    expect(defaulted.diagnostics.filter((item) => item.code === "KIT_THEME_DEFAULT")).toEqual([
      {
        severity: "warning",
        code: "KIT_THEME_DEFAULT",
        message: "No Library theme is active for this org or project, so the page uses Ravi's default theme. An admin can set one with `ravi themes use <ref> --execute`.",
      },
    ]);
    expect(errors(defaulted)).toEqual([]);
    const codes = (result: { diagnostics: KitDiagnostic[] }) => result.diagnostics.map((item) => item.code);
    expect(codes(await buildPageKit(input(body, { theme: "none" }), deps()))).not.toContain("KIT_THEME_DEFAULT");
    expect(codes(await buildPageKit(input(body), deps({ theme: themeSource() })))).not.toContain("KIT_THEME_DEFAULT");
    expect(codes(await buildPageKit(input(body, { theme: "org/clinica" }), deps()))).not.toContain("KIT_THEME_DEFAULT");
    // A page without tags gets no theme and no notice.
    expect(codes(await buildPageKit(input(page("<p>oi</p>")), deps()))).toEqual([]);
  });
});
