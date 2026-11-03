import { afterEach, describe, expect, test } from "bun:test";

import type { BaseViewColumn } from "@/shared/bases/types";

import { CHART_DATA_ID, type ChartData } from "./chart";
import { RaviError } from "./errors";
import { COLUMNS, describeOutput, FakeBase, kitFor, openPage, sampleRows, squash, VIEW_ID, type Handler, type Page } from "./test-harness";
import { BASES_IDS } from "./view";

let page: Page | null = null;

afterEach(async () => {
  await page?.close();
  page = null;
});

const CHART_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CHART = "44444444-4444-4444-8444-444444444444";
const STATUS_COLUMN = COLUMNS[1] as BaseViewColumn;
const AREA_COLUMN = COLUMNS[2] as BaseViewColumn;
const VALOR_COLUMN = COLUMNS[4] as BaseViewColumn;
const CRIADO_COLUMN: BaseViewColumn = { key: "criado", name: "Criado", type: "created_time", config: {}, required: false };

function chartData(spec: unknown, groups: ChartData["groups"], extra: Partial<ChartData> = {}): ChartData {
  return {
    chart: { id: CHART_ID, baseId: "22222222-2222-4222-8222-222222222222", viewId: VIEW_ID, name: "Pedidos por status", description: null, spec: spec as ChartData["chart"]["spec"], version: 1 },
    groups,
    fields: { status: STATUS_COLUMN, area: AREA_COLUMN, valor: VALOR_COLUMN, criado: CRIADO_COLUMN },
    suppressedGroups: 0,
    users: {},
    ...extra,
  };
}

const BAR = chartData(
  { mark: "bar", encoding: { x: { field: "status", type: "nominal" }, y: { aggregate: "sum", field: "valor", type: "quantitative" } } },
  [
    { x: "s-todo", y: 10 },
    { x: "s-doing", y: 20 },
    { x: null, y: 5 },
  ],
  { suppressedGroups: 2 },
);

/** A page with one `<ravi-chart>`; the kit declares charts.data for CHART_ID and OTHER_CHART unless `declared` says otherwise. */
async function openChart(data: unknown, opts: { declared?: string[]; handler?: Handler; capture?: boolean; chartMs?: number; attrs?: string } = {}) {
  const declared = opts.declared ?? [CHART_ID, OTHER_CHART];
  const base = kitFor();
  const fake = new FakeBase(describeOutput(), sampleRows());
  fake.chart = data;
  page = await openPage({
    fake,
    body: `<ravi-chart data-ravi-id="c1" chart="${CHART_ID}" ${opts.attrs ?? ""}></ravi-chart>`,
    kit: kitFor(
      { actions: [...base.actions, ...declared.map((chartId) => ({ id: CHART_DATA_ID, chartId }))], uses: [...base.uses, CHART_DATA_ID] },
      { c1: { tag: "ravi-chart", view: null, chart: CHART_ID } },
    ),
    handler: opts.handler,
    capture: opts.capture,
    install: opts.chartMs ? { chartMs: opts.chartMs } : undefined,
  });
  await page.ravi.ready;
  return page;
}

const host = (p: Page) => p.doc.querySelector("ravi-chart") as HTMLElement;
const svg = (p: Page) => host(p).querySelector("svg") as SVGSVGElement;
const marks = (p: Page, tag: string) => Array.from(host(p).querySelectorAll(`${tag}.ravi-chart-mark`));
const titles = (list: Element[]) => list.map((node) => node.querySelector("title")?.textContent);
const tableRows = (p: Page) => Array.from(host(p).querySelectorAll("table.ravi-sr-only tr"), (tr) => Array.from(tr.children, (cell) => cell.textContent));

describe("<ravi-chart>", () => {
  test("bar: a captioned figure, an img svg named by kind and chart, one titled rect per group, the hidden table and the suppressed note", async () => {
    const p = await openChart(BAR);
    expect(p.calls.filter((call) => call.id === CHART_DATA_ID)).toEqual([{ id: CHART_DATA_ID, input: { chartId: CHART_ID }, runtime: "1.1.0" }]);
    expect(host(p).querySelector("figure.ravi-chart > figcaption")?.textContent).toBe("Pedidos por status");
    expect(svg(p).getAttribute("role")).toBe("img");
    expect(svg(p).getAttribute("aria-label")).toBe("Gráfico de barras: Pedidos por status");
    expect(svg(p).getAttribute("viewBox")).toBe("0 0 640 320");
    expect(titles(marks(p, "rect"))).toEqual(["A fazer · Valor: 10", "Fazendo · Valor: 20", "Sem valor · Valor: 5"]);
    // Taller bar for the larger value, all on one baseline.
    const [todo, doing] = marks(p, "rect").map((rect) => Number(rect.getAttribute("height")));
    expect(doing).toBeGreaterThan(todo as number);
    expect(tableRows(p)).toEqual([
      ["Status", "Valor"],
      ["A fazer", "10"],
      ["Fazendo", "20"],
      ["Sem valor", "5"],
    ]);
    expect(host(p).querySelector("table.ravi-sr-only caption")?.textContent).toBe("Pedidos por status");
    expect(squash(host(p).textContent)).toContain("2 grupos ocultos por terem menos de 5 registros.");
    // One series: the caption names it, no legend.
    expect(host(p).querySelector(".ravi-legend")).toBeNull();
    expect(host(p).hasAttribute("aria-busy")).toBe(false);
  });

  test("a color channel stacks the series and adds a legend with option colors; count titles say Contagem", async () => {
    const p = await openChart(
      chartData({ mark: "bar", encoding: { x: { field: "status", type: "nominal" }, y: { aggregate: "count", type: "quantitative" }, color: { field: "area", type: "nominal" } } }, [
        { x: "s-todo", y: 6, color: "a-ops" },
        { x: "s-todo", y: 7, color: "a-fin" },
        { x: "s-done", y: 8, color: "a-ops" },
      ]),
    );
    const legend = Array.from(host(p).querySelectorAll(".ravi-legend li"));
    expect(legend.map((li) => li.textContent)).toEqual(["Operações", "Financeiro"]);
    expect(legend.map((li) => li.querySelector(".ravi-swatch")?.getAttribute("class"))).toEqual(["ravi-swatch ravi-chart-o-orange", "ravi-swatch ravi-chart-o-purple"]);
    expect(legend.every((li) => li.querySelector(".ravi-swatch")?.getAttribute("aria-hidden") === "true")).toBe(true);
    // Two categories by two series.
    expect(marks(p, "rect").length).toBe(4);
    expect(titles(marks(p, "rect"))[0]).toBe("A fazer · Operações · Contagem: 6");
    expect(tableRows(p)[0]).toEqual(["Status", "Contagem", "Área"]);
  });

  test("arc: one path per slice with its share; a donut keeps the inner radius", async () => {
    const p = await openChart(
      chartData({ mark: { type: "arc", innerRadius: 50 }, encoding: { theta: { aggregate: "count", type: "quantitative" }, color: { field: "status", type: "nominal" } } }, [
        { theta: 3, color: "s-todo" },
        { theta: 1, color: "s-done" },
      ]),
    );
    expect(svg(p).getAttribute("aria-label")).toBe("Gráfico de pizza: Pedidos por status");
    const slices = marks(p, "path");
    expect(titles(slices)).toEqual(["A fazer · 3 (75%)", "Feito · 1 (25%)"]);
    expect(slices.every((path) => (path.getAttribute("d") ?? "").includes("A50,50"))).toBe(true);
    expect(Array.from(host(p).querySelectorAll(".ravi-legend li"), (li) => li.textContent)).toEqual(["A fazer", "Feito"]);
  });

  test("text: one big number, no svg", async () => {
    const p = await openChart(chartData({ mark: "text", encoding: { text: { aggregate: "sum", field: "valor", type: "quantitative" } } }, [{ text: 35 }]));
    expect(host(p).querySelector("svg")).toBeNull();
    expect(host(p).querySelector("p.ravi-big")?.textContent).toBe("35");
    expect(tableRows(p)).toEqual([["Valor"], ["35"]]);
  });

  test("rect: a heatmap whose cells carry their value as text", async () => {
    const p = await openChart(
      chartData({ mark: "rect", encoding: { x: { field: "status", type: "nominal" }, y: { field: "area", type: "nominal" }, color: { aggregate: "count", type: "quantitative" } } }, [
        { x: "s-todo", y: "a-ops", color: 4 },
        { x: "s-done", y: "a-fin", color: 9 },
      ]),
    );
    expect(svg(p).getAttribute("aria-label")).toBe("Mapa de calor: Pedidos por status");
    expect(marks(p, "rect").length).toBe(2);
    expect(Array.from(host(p).querySelectorAll("text.ravi-chart-label"), (text) => text.textContent)).toEqual(["4", "9"]);
    expect(titles(marks(p, "rect"))).toEqual(["A fazer · Operações · Contagem: 4", "Feito · Financeiro · Contagem: 9"]);
  });

  test("line over a time unit: a path, a point per bucket, buckets in time order on the axis", async () => {
    const p = await openChart(
      chartData({ mark: "line", encoding: { x: { field: "criado", type: "temporal", timeUnit: "month" }, y: { aggregate: "count", type: "quantitative" } } }, [
        { x: "2026-02-01T00:00:00.000Z", y: 4 },
        { x: "2026-01-01T00:00:00.000Z", y: 2 },
      ]),
    );
    expect(svg(p).getAttribute("aria-label")).toBe("Gráfico de linhas: Pedidos por status");
    expect(host(p).querySelectorAll("path.ravi-chart-line").length).toBe(1);
    expect(marks(p, "circle").length).toBe(2);
    const axis = Array.from(svg(p).querySelectorAll("text"), (text) => text.textContent ?? "").filter((text) => text.includes("2026"));
    expect(axis.length).toBe(2);
    expect(axis[0]).toMatch(/^jan/);
    expect(axis[1]).toMatch(/^fev/);
  });

  test("bar with the measure on x is horizontal: every bar starts at the left baseline", async () => {
    const p = await openChart(
      chartData({ mark: "bar", encoding: { y: { field: "status", type: "nominal" }, x: { aggregate: "sum", field: "valor", type: "quantitative" } } }, [
        { y: "s-todo", x: 10 },
        { y: "s-done", x: 30 },
      ]),
    );
    const bars = marks(p, "rect");
    expect(new Set(bars.map((rect) => rect.getAttribute("x")))).toEqual(new Set(["120"]));
    expect(Number(bars[1]?.getAttribute("width"))).toBeGreaterThan(Number(bars[0]?.getAttribute("width")));
  });

  test("no groups: says so", async () => {
    const p = await openChart(chartData(BAR.chart.spec, []));
    expect(host(p).querySelector("figcaption")?.textContent).toBe("Pedidos por status");
    expect(squash(host(p).querySelector("figure")?.textContent)).toContain("Sem dados para este gráfico.");
  });

  test("a chart the kit does not declare is refused locally, with inline text", async () => {
    const p = await openChart(BAR, { declared: [] });
    expect(p.calls.filter((call) => call.id === CHART_DATA_ID)).toEqual([]);
    expect(host(p).querySelector(".ravi-error")).not.toBeNull();
    expect(host(p).querySelector("svg")).toBeNull();
  });

  test("load errors: inline text and Tentar de novo for retryable kinds; retrying draws the chart", async () => {
    let fail = true;
    const p = await openChart(BAR, { handler: (call) => (call.id === CHART_DATA_ID && fail ? { status: 400, error: "cursor_invalid" } : undefined) });
    expect(host(p).querySelector(".ravi-error")?.textContent).toBe("Não foi possível carregar os dados.");
    fail = false;
    (host(p).querySelector('[data-ravi-op="retry"]') as HTMLButtonElement).click();
    await p.flush();
    expect(host(p).querySelector("figcaption")?.textContent).toBe("Pedidos por status");
  });

  test("re-reads on its interval while visible and redraws only when the data changed", async () => {
    const p = await openChart(BAR, { chartMs: 20 });
    const reads = () => p.calls.filter((call) => call.id === CHART_DATA_ID).length;
    const figure = host(p).querySelector("figure");
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(reads()).toBeGreaterThan(1);
    // Same data: the same figure stays.
    expect(host(p).querySelector("figure")).toBe(figure);
    p.fake.chart = { ...BAR, groups: [{ x: "s-todo", y: 99 }] };
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(titles(marks(p, "rect"))).toEqual(["A fazer · Valor: 99"]);
    Object.defineProperty(p.doc, "hidden", { configurable: true, get: () => true });
    const before = reads();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(reads()).toBe(before);
  });

  test("changing the chart attribute reads the new chart", async () => {
    const p = await openChart(BAR);
    host(p).setAttribute("chart", OTHER_CHART);
    await p.flush();
    expect(p.calls.at(-1)).toMatchObject({ id: CHART_DATA_ID, input: { chartId: OTHER_CHART } });
  });

  test("a thumbnail browser gets the neutral placeholder and reads nothing", async () => {
    const p = await openChart(BAR, { capture: true });
    expect(squash(host(p).textContent)).toBe("Os dados aparecem quando a página é aberta.");
    expect(p.calls.filter((call) => call.id === CHART_DATA_ID)).toEqual([]);
  });
});

describe("ravi.bases.chart", () => {
  test("data() reads the chart's groups; ids that are not UUIDs are refused", async () => {
    const p = await openChart(BAR);
    const bases = p.ravi.bases as { chart: (id: string) => { id: string; data: () => Promise<ChartData> } };
    const handle = bases.chart(CHART_ID.toUpperCase());
    expect(handle.id).toBe(CHART_ID);
    expect((await handle.data()).groups).toEqual(BAR.groups);
    expect(() => bases.chart("vendas")).toThrow(RaviError);
  });

  test("exec declared(): charts.data matches kit actions by chartId, views ids by viewId", async () => {
    const p = await openChart(BAR, { declared: [CHART_ID] });
    expect(p.rt.exec.declared(CHART_DATA_ID, { chartId: CHART_ID })).toBe(true);
    expect(p.rt.exec.declared(CHART_DATA_ID, { chartId: OTHER_CHART })).toBe(false);
    expect(p.rt.exec.declared(BASES_IDS.query, { viewId: VIEW_ID })).toBe(true);
    expect(p.rt.exec.declared(BASES_IDS.query, { viewId: CHART_ID })).toBe(false);
    await expect(p.rt.exec.exec(CHART_DATA_ID, { chartId: OTHER_CHART })).rejects.toMatchObject({ code: "not_declared" });
  });
});
