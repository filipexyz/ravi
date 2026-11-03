// `<ravi-chart chart="<uuid>">` and `ravi.bases.chart(id)`: one Bases chart
// through `ravi.bases.charts.data` (the kit pairs the id with the chart in
// `kit.actions`). The element draws the declared Vega-Lite subset as SVG
// built with `createElementNS` (never HTML): bar (stacked, grouped or
// normalized; horizontal when x is the measure), line, area, point (scatter
// when both axes are measures), arc (pie and donut), rect (heatmap, each cell
// labelled with its value) and text (one number). The figure is captioned
// with the chart name; identity is never color alone (a legend names each
// series, every mark has a `<title>`), and a visually hidden table holds
// every group. It re-reads every 60 s while the page is visible.

import type { BaseChartDatum, BaseChartFieldDef, BaseChartPublic, BaseUserRef, BaseViewColumn } from "@/shared/bases/types";
import { optionColor } from "@/shared/widgets/render/fields";
import { formatNumberByColumn, formatValue, intlLocale, optionFor } from "@/shared/widgets/render/format";

import { el, kids } from "./dom";
import { asRaviError, RaviError } from "./errors";
import type { Mounted, Rt } from "./runtime";

export const CHART_DATA_ID = "ravi.bases.charts.data";
export const CHART_MS = 60_000;

export type ChartData = {
  chart: BaseChartPublic;
  groups: BaseChartDatum[];
  fields: Record<string, BaseViewColumn>;
  suppressedGroups: number;
  users: Record<string, BaseUserRef>;
};

/** `ravi.bases.chart(id)`. */
export type ChartHandle = { readonly id: string; data(): Promise<ChartData> };

type Channel = "x" | "y" | "color" | "theta" | "text";
type Value = string | number | boolean | null | undefined;

const SVG = "http://www.w3.org/2000/svg";
const W = 640;
const H = 320;
const T = 28;
const B = 48;
const R = 16;
const CHANNELS: Channel[] = ["x", "y", "color", "theta", "text"];
const round = (n: number) => Math.round(n * 10) / 10;
const key = (value: Value) => JSON.stringify(value ?? null);

/** A round step near `span` (1, 2 or 5 times a power of ten). */
function niceStep(span: number) {
  const power = 10 ** Math.floor(Math.log10(span || 1));
  const f = span / power;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * power;
}

/** The figure for one chart's data. */
export function renderChart(rt: Rt, data: ChartData): HTMLElement {
  const { doc, msgs } = rt;
  const spec = data.chart.spec;
  const enc = spec.encoding;
  const mark = typeof spec.mark == "string" ? spec.mark : spec.mark.type;
  const groups = data.groups ?? [];
  const ctx = { ...rt.base(), users: data.users ?? {} };
  const num = (n: number) => n.toLocaleString(intlLocale(rt.locale), { maximumFractionDigits: 2 });

  const def = (channel: Channel) => enc[channel] as BaseChartFieldDef | undefined;
  const col = (channel: Channel) => {
    const field = def(channel)?.field;
    return field ? data.fields?.[field] : undefined;
  };
  const measure = (channel: Channel) => !!def(channel)?.aggregate;
  const title = (channel: Channel) => def(channel)?.title || (def(channel)?.aggregate == "count" ? msgs.chartCount : col(channel)?.name) || channel;
  const text = (channel: Channel, value: Value): string => {
    const one = def(channel);
    const column = col(channel);
    if (value == null) return msgs.noValue;
    if (one?.aggregate || !column) {
      if (typeof value != "number") return String(value);
      return column?.type == "number" && !/^count/.test(one?.aggregate ?? "") ? formatNumberByColumn(value, column, rt.locale) : num(value);
    }
    if (one?.timeUnit && typeof value == "string") {
      const at = new Date(Date.parse(value));
      if (!Number.isNaN(at.getTime())) {
        const unit = one.timeUnit;
        if (unit == "quarter") return `${msgs.locale == "pt-BR" ? "T" : "Q"}${Math.floor(at.getUTCMonth() / 3) + 1} ${at.getUTCFullYear()}`;
        return at.toLocaleDateString(intlLocale(rt.locale), {
          timeZone: "UTC",
          year: "numeric",
          ...(unit == "year" ? {} : unit == "month" ? { month: "short" } : { month: "short", day: "numeric" }),
        });
      }
    }
    const shown = formatValue({ key: column.key, name: column.name, type: column.type, config: column.config ?? {} }, column.type == "approval" ? { state: value } : value, ctx);
    return shown || String(value);
  };
  /** Series color class: the option's color for option columns, else the series slot. */
  const tint = (channel: Channel, value: Value, index: number) => {
    const column = col(channel);
    const option = column && /select|status/.test(column.type) ? optionFor(column, value) : null;
    return option ? `ravi-chart-o-${optionColor(option.color)}` : `ravi-chart-s${index % 9}`;
  };

  const s = (tag: string, attrs: Record<string, Value>, ...kids: Array<Node | string | null | false>) => {
    const node = doc.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) if (value != null) node.setAttribute(name, String(value));
    node.append(...(kids.filter(Boolean) as Array<Node | string>));
    return node;
  };
  const tip = (...parts: string[]) => s("title", {}, parts.filter(Boolean).join(" · "));
  const label = (x: number, y: number, content: string, anchor = "middle", cls = "ravi-chart-axis") =>
    s("text", { x: round(x), y: round(y), "text-anchor": anchor, class: cls }, content.length > 18 ? `${content.slice(0, 17)}…` : content);

  const legend: Array<[string, string]> = [];
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${msgs.chartKinds[mark]}: ${data.chart.name}`, focusable: "false" });
  let body: HTMLElement | SVGElement = svg;

  if (!groups.length) body = el(doc, "p", { className: "ravi-status" }, msgs.chartEmpty);
  else if (mark == "text") {
    const channel = CHANNELS.find((one) => def(one) && measure(one)) ?? "text";
    body = el(doc, "p", { className: "ravi-big" }, text(channel, groups[0]?.[channel]));
  } else if (mark == "arc") {
    const total = groups.reduce((sum, group) => sum + Math.max(0, Number(group.theta) || 0), 0) || 1;
    const radius = (H - 16) / 2;
    const raw = typeof spec.mark == "object" ? (spec.mark.innerRadius ?? 0) : 0;
    const inner = Math.max(0, Math.min(raw, radius - 8));
    const at = (angle: number, length: number) => `${round(W / 2 + length * Math.cos(angle))},${round(H / 2 + length * Math.sin(angle))}`;
    let start = -Math.PI / 2;
    groups.forEach((group, index) => {
      const share = Math.max(0, Number(group.theta) || 0) / total;
      const end = start + Math.min(share * 2 * Math.PI, 2 * Math.PI - 1e-4);
      const large = end - start > Math.PI ? 1 : 0;
      const name = text("color", group.color);
      const cls = tint("color", group.color, index);
      legend.push([name, cls]);
      const d =
        `M${at(start, radius)}A${radius},${radius} 0 ${large} 1 ${at(end, radius)}` +
        (inner ? `L${at(end, inner)}A${inner},${inner} 0 ${large} 0 ${at(start, inner)}Z` : `L${W / 2},${H / 2}Z`);
      svg.append(s("path", { d, class: `ravi-chart-mark ${cls}`, fill: "currentColor" }, tip(name, `${text("theta", group.theta)} (${Math.round(share * 100)}%)`)));
      start += share * 2 * Math.PI;
    });
  } else {
    // Cartesian: one band axis (categories) and one value axis, unless both axes are measures (scatter) or both dimensions (heatmap).
    const heat = mark == "rect";
    const scatter = !heat && measure("x") && measure("y");
    const horiz = !heat && !scatter && measure("x") && !measure("y");
    const band: Channel = horiz ? "y" : "x";
    const vc: Channel = heat ? "color" : horiz ? "x" : "y";
    const series = heat || !def("color") || measure("color") ? [null] : [...new Map(groups.map((group) => [key(group.color), group.color])).values()];
    const uniq = (channel: Channel) => {
      const list = [...new Map(groups.map((group) => [key(group[channel]), group[channel]])).values()];
      return def(channel)?.type == "temporal" ? list.sort((a, b) => String(a).localeCompare(String(b))) : list;
    };
    const cats = uniq(band);
    const rows = heat ? uniq("y") : [];
    const L = horiz || heat ? 120 : 56;
    const pw = W - L - R;
    const ph = H - T - B;
    const value = (cat: Value, ser: Value) =>
      groups.reduce((sum, group) => (key(group[band]) == key(cat) && (ser === null || key(group.color) == key(ser)) ? sum + (Number(group[vc]) || 0) : sum), 0);
    const stack = def(vc)?.stack;
    const stacked = series.length > 1 && (mark == "bar" || mark == "area") && stack !== null;
    const share = stacked && stack == "normalize";
    const totals = cats.map((cat) => series.reduce((sum: number, ser) => sum + value(cat, ser), 0));
    const all = groups.map((group) => Number(group[vc]) || 0);
    let lo = Math.min(0, ...all);
    let hi = share ? 1 : stacked ? Math.max(0, ...totals) : Math.max(0, ...all);
    const step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step || step;
    const scale = (n: number, length = horiz ? pw : ph) => ((n - lo) / (hi - lo)) * length;
    const fmtValue = (n: number) => (share ? `${Math.round(n * 100)}%` : text(vc, n));
    const point = (b: number, v: number) => (horiz ? [L + scale(v), T + b] : [L + b, T + ph - scale(v)]);

    if (!heat) {
      // Value axis: grid lines and ticks, its title above the plot.
      for (let tick = lo; tick <= hi + step / 2; tick += step) {
        const [x, y] = point(0, tick) as [number, number];
        svg.append(
          horiz ? s("line", { x1: round(x), x2: round(x), y1: T, y2: T + ph, class: "ravi-chart-grid" }) : s("line", { x1: L, x2: L + pw, y1: round(y), y2: round(y), class: "ravi-chart-grid" }),
          horiz ? label(x, T + ph + 16, fmtValue(tick)) : label(L - 6, y + 4, fmtValue(tick), "end"),
        );
      }
      svg.append(label(horiz ? L + pw : 4, horiz ? H - 6 : 14, title(vc), horiz ? "end" : "start"));
    }

    if (scatter) {
      const xs = groups.map((group) => Number(group.x) || 0);
      const xlo = Math.min(0, ...xs);
      const xhi = Math.max(...xs, xlo + 1);
      groups.forEach((group) => {
        const ser = series.findIndex((one) => key(one) == key(group.color));
        svg.append(
          s(
            "circle",
            { cx: round(L + ((Number(group.x) - xlo) / (xhi - xlo)) * pw), cy: round(T + ph - scale(Number(group.y) || 0)), r: 5, class: `ravi-chart-mark ${tint("color", group.color, Math.max(0, ser))}`, fill: "currentColor" },
            tip(`${title("x")}: ${text("x", group.x)}`, `${title("y")}: ${text("y", group.y)}`, def("color") ? text("color", group.color) : ""),
          ),
        );
      });
      svg.append(label(L + pw, H - 6, title("x"), "end"));
    } else if (heat) {
      const bw = pw / Math.max(1, cats.length);
      const bh = ph / Math.max(1, rows.length);
      const top = Math.max(1, ...all.map(Math.abs));
      for (const group of groups) {
        const cx = cats.findIndex((one) => key(one) == key(group.x));
        const cy = rows.findIndex((one) => key(one) == key(group.y));
        const n = Number(group.color) || 0;
        svg.append(
          s("rect", { x: round(L + cx * bw), y: round(T + cy * bh), width: round(bw), height: round(bh), class: "ravi-chart-mark ravi-chart-s0", fill: "currentColor", "fill-opacity": round(0.12 + 0.78 * (Math.abs(n) / top)) }, tip(text("x", group.x), text("y", group.y), `${title("color")}: ${text("color", n)}`)),
          label(L + cx * bw + bw / 2, T + cy * bh + bh / 2 + 4, text("color", n), "middle", "ravi-chart-label"),
        );
      }
      rows.forEach((row, index) => svg.append(label(L - 6, T + index * bh + bh / 2 + 4, text("y", row), "end")));
    } else {
      const length = horiz ? ph : pw;
      const bw = length / Math.max(1, cats.length);
      const grouped = mark == "bar" && !stacked && series.length > 1;
      const inner = grouped ? (bw * 0.8) / series.length : bw * 0.7;
      const base: number[] = cats.map(() => 0);
      series.forEach((ser, index) => {
        const cls = tint("color", ser, index);
        if (ser !== null) legend.push([text("color", ser), cls]);
        const g = s("g", { class: cls });
        const tops: string[] = [];
        const bottoms: string[] = [];
        cats.forEach((cat, at) => {
          const raw = value(cat, ser);
          const n = share ? raw / (totals[at] || 1) : raw;
          const from = stacked ? (base[at] as number) : 0;
          const to = from + n;
          if (stacked) base[at] = to;
          const name = tip(text(band, cat), ser === null ? "" : text("color", ser), `${title(vc)}: ${share ? `${fmtValue(n)} (${text(vc, raw)})` : text(vc, raw)}`);
          const center = at * bw + bw / 2;
          if (mark == "bar") {
            const b0 = grouped ? at * bw + bw * 0.1 + index * inner : center - inner / 2;
            const v = round(Math.abs(scale(to) - scale(from)));
            const box = horiz
              ? { x: round(L + scale(Math.min(from, to))), y: round(T + b0), width: v, height: round(inner) }
              : { x: round(L + b0), y: round(T + ph - scale(Math.max(from, to))), width: round(inner), height: v };
            g.append(s("rect", { ...box, class: "ravi-chart-mark", fill: "currentColor" }, name));
          } else {
            tops.push((point(center, to) as number[]).map(round).join(","));
            bottoms.unshift((point(center, from) as number[]).map(round).join(","));
            const [x, y] = point(center, to) as [number, number];
            g.append(s("circle", { cx: round(x), cy: round(y), r: mark == "point" ? 5 : 4, class: "ravi-chart-mark", fill: "currentColor" }, name));
          }
        });
        if (mark == "line" || mark == "area") {
          g.prepend(
            mark == "line"
              ? s("path", { d: `M${tops.join("L")}`, class: "ravi-chart-line" })
              : s("path", { d: `M${tops.join("L")}L${bottoms.join("L")}Z`, fill: "currentColor", "fill-opacity": 0.35, class: "ravi-chart-line" }),
          );
        }
        svg.append(g);
      });
      // Band axis: every label that fits.
      const every = Math.max(1, Math.ceil((cats.length * (horiz ? 18 : 64)) / length));
      cats.forEach((cat, at) => {
        if (at % every) return;
        const [x, y] = point(at * bw + bw / 2, lo) as [number, number];
        svg.append(horiz ? label(L - 6, y + 4, text(band, cat), "end") : label(x, T + ph + 16, text(band, cat)));
      });
      if (!horiz) svg.append(label(L + pw, H - 6, title(band), "end"));
    }
  }

  // The data as a table for assistive technology and text readers.
  const used = CHANNELS.filter((channel) => def(channel));
  const table = el(
    doc,
    "table",
    { className: "ravi-sr-only" },
    el(doc, "caption", null, data.chart.name),
    el(doc, "thead", null, el(doc, "tr", null, used.map((channel) => el(doc, "th", { scope: "col" }, title(channel))))),
    el(doc, "tbody", null, groups.map((group) => el(doc, "tr", null, used.map((channel) => el(doc, "td", null, text(channel, group[channel])))))),
  );
  return el(
    doc,
    "figure",
    { className: "ravi-chart" },
    el(doc, "figcaption", null, data.chart.name),
    data.chart.description && el(doc, "p", { className: "ravi-status" }, data.chart.description),
    body,
    legend.length > 1 &&
      el(
        doc,
        "ul",
        { className: "ravi-legend", role: "list" },
        legend.map(([name, cls]) => el(doc, "li", null, el(doc, "span", { className: `ravi-swatch ${cls}`, "aria-hidden": "true" }), name)),
      ),
    data.suppressedGroups > 0 && el(doc, "p", { className: "ravi-status" }, msgs.chartSuppressed(data.suppressedGroups)),
    table,
  );
}

/** The `<ravi-chart>` element. */
export function mountChart(rt: Rt, host: HTMLElement): Mounted {
  const { doc, msgs } = rt;
  let timer: number | null = null;
  let shown = "";
  let stamp = 0;
  let stopped = false;
  let settle!: () => void;
  const first = new Promise<void>((ok) => (settle = ok));
  const say = (text: string, retry = false, error = false) =>
    host.replaceChildren(
      ...kids([
        el(doc, "p", { className: error ? "ravi-error" : "ravi-status", role: "status" }, text),
        retry && el(doc, "button", { type: "button", className: "ravi-button ravi-button-secondary", "data-ravi-op": "retry" }, msgs.retry),
      ]),
    );
  const chartId = () => host.getAttribute("chart")?.trim() || rt.kit.instances[host.getAttribute("data-ravi-id") ?? ""]?.chart || "";

  const load = async (quiet: boolean) => {
    try {
      const data = await rt.chart(chartId()).data();
      stamp = rt.now();
      const next = JSON.stringify(data);
      if (!stopped && next != shown) {
        shown = next;
        host.replaceChildren(renderChart(rt, data));
        rt.fire(host, "ravi:render", { groups: data.groups?.length ?? 0 });
      }
    } catch (thrown) {
      const error = asRaviError(thrown);
      if (stopped) return;
      if (!quiet) {
        rt.report(error, { target: host });
        shown = "";
        say(rt.stateText(error), /^(busy|invalid)$/.test(error.kind), true);
      } else if (/^(session|paused)$/.test(error.kind)) rt.report(error, { target: host });
    }
  };
  const tick = () => {
    if (!doc.hidden && !rt.sessionExpired && rt.exec.used() < 45 && rt.now() - stamp >= rt.chartMs - 1000) void load(true);
  };
  const start = async () => {
    host.setAttribute("aria-busy", "true");
    if (rt.capture) say(msgs.capture);
    else {
      await load(false);
      timer ??= rt.win.setInterval(tick, rt.chartMs);
    }
    host.removeAttribute("aria-busy");
    settle();
  };
  doc.addEventListener("visibilitychange", tick);
  void start();
  return {
    first,
    on: (event) => {
      if (event.type == "click" && (event.target as Element).closest?.('[data-ravi-op="retry"]')) void start();
    },
    attr: (name) => name == "chart" && void start(),
    stop: () => {
      stopped = true;
      if (timer !== null) rt.win.clearInterval(timer);
      doc.removeEventListener("visibilitychange", tick);
      settle();
    },
  };
}

/** A chart handle whose `data()` reads the chart's groups through `read` (raw for the element, reporting for `ravi.bases.chart`). */
export function chartHandle(id: string, uuid: RegExp, read: (id: string, input: unknown) => Promise<unknown>): ChartHandle {
  const chartId = String(id ?? "").trim().toLowerCase();
  if (!uuid.test(chartId)) throw new RaviError("payload_invalid");
  return { id: chartId, data: () => read(CHART_DATA_ID, { chartId }) as Promise<ChartData> };
}
