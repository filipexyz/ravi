// The metrics data page: one HTML file that reads the two "Painel" views
// through the Pages connectors and draws the numbers, charts and the people
// table in the browser. No row value is ever written into the HTML; only the
// view ids are. Ship it on a private route of the metrics project's host with
// `--uses` = METRICS_DASHBOARD_USES (see RUNBOOK.md).

export const METRICS_DASHBOARD_USES = ["ravi.bases.views.describe", "ravi.bases.views.query"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function renderMetricsDashboard(input: { daysViewId: string; peopleViewId: string }): string {
  if (!UUID.test(input.daysViewId) || !UUID.test(input.peopleViewId)) throw new Error("Invalid view id.");
  const config = JSON.stringify({ daysView: input.daysViewId.toLowerCase(), peopleView: input.peopleViewId.toLowerCase() });
  return TEMPLATE.replace("__RAVI_METRICS_CONFIG__", config);
}

const TEMPLATE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Uso do Ravi</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--color-background-primary, #fbfcfd);
    color: var(--color-text-primary, #17202a);
    font: var(--font-text-md-size, 1rem)/1.5 var(--font-sans, system-ui, sans-serif);
  }
  main { max-width: 72rem; margin: 0 auto; padding: var(--ravi-space-6, 2rem) var(--ravi-space-4, 1rem) 4rem; }
  header { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: var(--ravi-space-4, 1rem); margin-bottom: var(--ravi-space-5, 1.5rem); }
  h1 { margin: 0; font-size: var(--font-heading-xl-size, 1.875rem); font-weight: var(--font-weight-bold, 700); letter-spacing: -0.01em; }
  h2 { margin: 0 0 var(--ravi-space-3, 0.75rem); font-size: var(--font-heading-sm-size, 1rem); font-weight: var(--font-weight-semibold, 600); }
  .sub { margin: var(--ravi-space-1, 0.25rem) 0 0; color: var(--color-text-secondary, #5f6f80); font-size: var(--font-text-sm-size, 0.875rem); }
  .seg { display: inline-flex; padding: 2px; border-radius: var(--border-radius-lg, 8px); background: var(--color-background-secondary, #f3f5f8); }
  .seg button {
    border: 0; background: transparent; color: var(--color-text-secondary, #5f6f80); font: inherit; font-size: var(--font-text-sm-size, 0.875rem);
    padding: 0.3rem 0.8rem; border-radius: var(--border-radius-md, 6px); cursor: pointer; min-height: var(--ravi-touch-target, 24px);
  }
  .seg button[aria-pressed="true"] { background: var(--color-background-primary, #fbfcfd); color: var(--color-text-primary, #17202a); font-weight: var(--font-weight-semibold, 600); box-shadow: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 0.08)); }
  button:focus-visible, input:focus-visible { outline: var(--ravi-focus-width, 2px) solid var(--color-ring-primary, #14635a); outline-offset: 2px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr)); gap: var(--ravi-space-3, 0.75rem); margin-bottom: var(--ravi-space-5, 1.5rem); }
  .card { background: var(--color-background-primary, #fbfcfd); border: var(--border-width-regular, 1px) solid var(--color-border-secondary, #dfe4ea); border-radius: var(--border-radius-xl, 12px); padding: var(--ravi-space-4, 1rem); }
  .kpi .label { color: var(--color-text-secondary, #5f6f80); font-size: var(--font-text-sm-size, 0.875rem); }
  .kpi .value { font-size: 2rem; font-weight: var(--font-weight-bold, 700); line-height: 1.15; font-variant-numeric: tabular-nums; margin-top: var(--ravi-space-1, 0.25rem); }
  .kpi .delta { font-size: var(--font-text-xs-size, 0.75rem); color: var(--color-text-tertiary, #627181); margin-top: var(--ravi-space-1, 0.25rem); }
  .delta.up { color: var(--color-text-success, #1d6537); }
  .delta.down { color: var(--color-text-danger, #a1262b); }
  .charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--ravi-space-3, 0.75rem); margin-bottom: var(--ravi-space-5, 1.5rem); }
  .charts .wide { grid-column: 1 / -1; }
  @media (max-width: 44rem) { .charts { grid-template-columns: minmax(0, 1fr); } }
  .legend { display: flex; flex-wrap: wrap; gap: var(--ravi-space-4, 1rem); font-size: var(--font-text-xs-size, 0.75rem); color: var(--color-text-secondary, #5f6f80); margin: -0.25rem 0 var(--ravi-space-2, 0.5rem); }
  .legend i { display: inline-block; width: 0.75rem; height: 0.75rem; border-radius: 3px; margin-right: 0.35rem; vertical-align: -1px; }
  svg { display: block; width: 100%; height: auto; overflow: visible; }
  svg text { fill: var(--color-text-tertiary, #627181); font-size: 11px; font-family: var(--font-sans, system-ui, sans-serif); }
  .grid line { stroke: var(--color-border-secondary, #dfe4ea); }
  .c1 { color: var(--ravi-color-accent, #14635a); }
  .c2 { color: var(--color-text-info, #1d4f8f); }
  .tip { position: fixed; pointer-events: none; z-index: 10; background: var(--color-background-inverse, #17202a); color: var(--color-text-inverse, #fbfcfd); font-size: var(--font-text-xs-size, 0.75rem); padding: 0.35rem 0.55rem; border-radius: var(--border-radius-md, 6px); white-space: nowrap; }
  .people-head { display: flex; flex-wrap: wrap; gap: var(--ravi-space-3, 0.75rem); align-items: center; justify-content: space-between; margin-bottom: var(--ravi-space-3, 0.75rem); }
  .people-head h2 { margin: 0; }
  .tools { display: flex; flex-wrap: wrap; gap: var(--ravi-space-3, 0.75rem); align-items: center; font-size: var(--font-text-sm-size, 0.875rem); }
  input[type="search"] {
    font: inherit; padding: 0.35rem 0.6rem; min-width: 14rem; border-radius: var(--border-radius-md, 6px);
    border: var(--border-width-regular, 1px) solid var(--color-border-primary, #838f9c); background: var(--color-background-primary, #fbfcfd); color: inherit;
  }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: var(--font-text-sm-size, 0.875rem); }
  th { text-align: left; font-weight: var(--font-weight-medium, 500); color: var(--color-text-secondary, #5f6f80); padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--color-border-secondary, #dfe4ea); white-space: nowrap; }
  td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--color-border-secondary, #dfe4ea); vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td .email, td .muted { color: var(--color-text-tertiary, #627181); font-size: var(--font-text-xs-size, 0.75rem); }
  .chip { display: inline-block; margin: 0 0.25rem 0.25rem 0; padding: 0 0.45rem; border-radius: var(--border-radius-full, 9999px); font-size: var(--font-text-xs-size, 0.75rem); background: var(--ravi-option-blue-bg, #dde9fb); color: var(--ravi-option-blue-text, #1d4f8f); }
  .chip.staff { background: var(--ravi-option-gray-bg, #e8ecf1); color: var(--ravi-option-gray-text, #3d4752); }
  .dot { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%; margin-right: 0.4rem; background: var(--color-border-secondary, #dfe4ea); }
  @media (max-width: 44rem) {
    #people-table th:nth-child(2), #people-table td:nth-child(2), #people-table th:nth-child(4), #people-table td:nth-child(4),
    #people-table th:nth-child(5), #people-table td:nth-child(5), #people-table th:nth-child(6), #people-table td:nth-child(6) { display: none; }
    #people-table td:first-child { min-width: 10rem; }
    .tools, input[type="search"] { width: 100%; min-width: 0; }
  }
  .dot.on { background: var(--color-text-success, #1d6537); }
  #banner { padding: 0.75rem 1rem; border-radius: var(--border-radius-lg, 8px); background: var(--color-background-danger, #fbdcdc); color: var(--color-text-danger, #a1262b); }
  .empty { color: var(--color-text-secondary, #5f6f80); padding: 1rem 0; }
  footer { margin-top: var(--ravi-space-5, 1.5rem); color: var(--color-text-tertiary, #627181); font-size: var(--font-text-xs-size, 0.75rem); }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Uso do Ravi</h1>
      <p class="sub" id="asof">Carregando…</p>
    </div>
    <div class="seg" role="group" aria-label="Período dos gráficos">
      <button type="button" data-days="30" aria-pressed="false">30 dias</button>
      <button type="button" data-days="90" aria-pressed="true">90 dias</button>
      <button type="button" data-days="120" aria-pressed="false">120 dias</button>
    </div>
  </header>
  <p id="banner" hidden></p>
  <section class="kpis" id="kpis" aria-label="Últimos 7 dias"></section>
  <section class="charts">
    <div class="card wide">
      <h2>Pessoas ativas</h2>
      <div class="legend"><span><i style="background: currentColor" class="c1"></i>em 7 dias</span><span><i style="background: var(--color-background-tertiary, #e8ecf1)"></i>no dia</span></div>
      <div id="chart-people"></div>
    </div>
    <div class="card">
      <h2>Publicações no Pages por dia</h2>
      <div id="chart-publishes"></div>
    </div>
    <div class="card">
      <h2>Requisições do Pages por dia</h2>
      <div class="legend"><span><i style="background: currentColor" class="c1"></i>públicas</span><span><i style="background: currentColor" class="c2"></i>privadas</span></div>
      <div id="chart-requests"></div>
    </div>
  </section>
  <section class="card">
    <div class="people-head">
      <h2 id="people-title">Pessoas</h2>
      <div class="tools">
        <input type="search" id="q" placeholder="Buscar nome, email ou org" aria-label="Buscar pessoas">
        <label><input type="checkbox" id="staff"> Mostrar a equipe Ravi</label>
      </div>
    </div>
    <div class="scroll"><table id="people-table">
      <thead><tr><th>Pessoa</th><th>Orgs</th><th>Áreas em 30 dias</th><th class="num">Ações 30d</th><th class="num">Publicações 30d</th><th class="num">Páginas abertas 30d</th><th>Última atividade</th></tr></thead>
      <tbody id="people"></tbody>
    </table></div>
  </section>
  <footer>Atualizado uma vez por dia pelo Console. Números de pessoas não contam a equipe Ravi. Requisições contam arquivos servidos, não visitantes.</footer>
</main>
<div class="tip" id="tip" hidden></div>
<script>
const CONFIG = __RAVI_METRICS_CONFIG__;
function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k !== null && k !== undefined && k !== ""));
  return node;
}
class ExecError extends Error {
  constructor(code, status, requestId) { super(code); Object.assign(this, { code, status, requestId }); }
}
async function exec(id, input, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch("/_ravi/connectors/exec", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ id, input }) });
    } catch { throw new ExecError("network_error", 0, null); }
    if (res.status === 429 && attempt < retries) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    let body = null;
    try { body = await res.json(); } catch {}
    if (res.ok && body && body.ok === true) return body.output;
    throw new ExecError(body && typeof body.error === "string" ? body.error : "connector_unavailable", res.status, res.headers.get("x-request-id"));
  }
}
async function queryAll(viewId) {
  const rows = [];
  let cursor = null;
  do {
    const out = await exec("ravi.bases.views.query", cursor ? { viewId, limit: 500, cursor } : { viewId, limit: 500 });
    rows.push(...out.rows);
    cursor = out.nextCursor;
  } while (cursor && rows.length < 5000);
  return rows;
}
function showError(err) {
  const node = document.getElementById("banner");
  node.hidden = false;
  const code = err && err.code;
  if (code === "connector_session_required" || code === "connector_unauthorized") {
    node.replaceChildren("Sua sessão expirou. ", el("a", { href: location.pathname, textContent: "Entrar de novo" }));
    return;
  }
  const text = code === "connector_not_allowlisted" ? "O host não liberou a leitura das views. Refaça o ship com o --uses do RUNBOOK."
    : code === "not_found" || code === "base_forbidden" ? "As views de métricas não estão liberadas para este site. Rode o tick de métricas de novo."
    : "Não deu para carregar as métricas.";
  node.textContent = err && err.requestId ? text + " (código " + err.requestId + ")" : text;
}

const nf = new Intl.NumberFormat("pt-BR");
const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" });
const longFmt = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const dateStart = (v) => (v && typeof v === "object" ? v.start : v) || null;
const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
const asDate = (day) => new Date(day + "T12:00:00Z");

let days = [];
let people = [];
let areaNames = new Map();
let period = 90;

function renderKpis() {
  const last = days[days.length - 1];
  const before = days[days.length - 8];
  const sum7 = (key) => days.slice(-7).reduce((total, d) => total + num(d.values[key]), 0);
  const items = [
    ["Pessoas em 7 dias", "pessoas_7d"],
    ["Orgs em 7 dias", "orgs_7d"],
    ["Publicaram no Pages", "publicadores_7d"],
    ["Abriram página privada", "leitores_7d"],
    ["Requisições no Pages", null],
    ["Instalações ativas", "instalacoes_7d"],
  ];
  const cards = items.map(([label, key]) => {
    const value = key ? num(last.values[key]) : sum7("req_publicas") + sum7("req_privadas");
    let delta = null;
    if (key && before) {
      const diff = value - num(before.values[key]);
      delta = el("div", { className: "delta " + (diff > 0 ? "up" : diff < 0 ? "down" : ""), textContent: (diff > 0 ? "+" : "") + nf.format(diff) + " na semana" });
    } else if (!key) {
      delta = el("div", { className: "delta", textContent: "em 7 dias" });
    }
    return el("div", { className: "card kpi" }, el("div", { className: "label", textContent: label }), el("div", { className: "value", textContent: key ? nf.format(value) : compact.format(value) }), delta);
  });
  document.getElementById("kpis").replaceChildren(...cards);
}

const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.append(...kids);
  return node;
}
// Whole-number ticks: the smallest step of 1, 2 or 5 x 10^k that covers the max in at most 4 steps.
function niceScale(value) {
  const max = Math.max(1, value);
  for (let k = 0; ; k++) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** k;
      if (step * 4 >= max) return { step, top: Math.ceil(max / step) * step };
    }
  }
}
const tip = document.getElementById("tip");
function hover(node, text) {
  node.addEventListener("mousemove", (e) => { tip.hidden = false; tip.textContent = text; tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY - 28 + "px"; });
  node.addEventListener("mouseleave", () => { tip.hidden = true; });
}
// series: [{ key, color: "c1"|"c2"|"muted", kind: "bar"|"line", label }]; bars with the same kind stack.
function chart(target, rows, series, height) {
  const holder = document.getElementById(target);
  const W = Math.max(280, Math.round(holder.clientWidth)), H = height, L = 40, R = 8, T = 8, B = 22;
  const iw = W - L - R, ih = H - T - B;
  const bars = series.filter((s) => s.kind === "bar");
  const lines = series.filter((s) => s.kind === "line");
  const stacked = rows.map((r) => bars.reduce((t, s) => t + num(r.values[s.key]), 0));
  const scale = niceScale(Math.max(...stacked, ...rows.flatMap((r) => lines.map((s) => num(r.values[s.key])))));
  const max = scale.top;
  const x = (i) => L + (rows.length <= 1 ? iw / 2 : (i + 0.5) * (iw / rows.length));
  const y = (v) => T + ih - (v / max) * ih;
  const bw = Math.max(1, (iw / Math.max(rows.length, 1)) * 0.7);
  const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img" });
  const grid = svgEl("g", { class: "grid" });
  for (let v = 0; v <= max; v += scale.step) {
    grid.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v) }), svgEl("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, compact.format(v)));
  }
  svg.append(grid);
  const every = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 90)));
  rows.forEach((r, i) => {
    if (i % every === 0) svg.append(svgEl("text", { x: x(i), y: H - 4, "text-anchor": "middle" }, dayFmt.format(asDate(r.day))));
  });
  rows.forEach((r, i) => {
    let base = 0;
    for (const s of bars) {
      const v = num(r.values[s.key]);
      if (v <= 0) continue;
      const fill = s.color === "muted" ? "var(--color-background-tertiary, #e8ecf1)" : "currentColor";
      const rect = svgEl("rect", { x: x(i) - bw / 2, y: y(base + v), width: bw, height: Math.max(0.5, y(base) - y(base + v)), rx: Math.min(2, bw / 3), fill, class: s.color === "muted" ? "" : s.color });
      hover(rect, dayFmt.format(asDate(r.day)) + " · " + s.label + ": " + nf.format(v));
      svg.append(rect);
      base += v;
    }
  });
  for (const s of lines) {
    const d = rows.map((r, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(num(r.values[s.key])).toFixed(1)).join(" ");
    svg.append(svgEl("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linejoin": "round", class: s.color }));
    rows.forEach((r, i) => {
      const hit = svgEl("rect", { x: x(i) - iw / rows.length / 2, y: T, width: iw / rows.length, height: ih, fill: "transparent" });
      const extra = bars.map((b) => b.label + ": " + nf.format(num(r.values[b.key]))).join(" · ");
      hover(hit, dayFmt.format(asDate(r.day)) + " · " + s.label + ": " + nf.format(num(r.values[s.key])) + (extra ? " · " + extra : ""));
      svg.append(hit);
    });
  }
  holder.replaceChildren(svg);
}
function renderCharts() {
  const rows = days.slice(-period);
  chart("chart-people", rows, [
    { key: "pessoas_ativas", kind: "bar", color: "muted", label: "no dia" },
    { key: "pessoas_7d", kind: "line", color: "c1", label: "em 7 dias" },
  ], 220);
  chart("chart-publishes", rows, [{ key: "publicacoes", kind: "bar", color: "c1", label: "publicações" }], 180);
  chart("chart-requests", rows, [
    { key: "req_publicas", kind: "bar", color: "c1", label: "públicas" },
    { key: "req_privadas", kind: "bar", color: "c2", label: "privadas" },
  ], 180);
}

function ago(iso) {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 60) return "agora há pouco";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return "há " + hours + " h";
  const d = Math.round(hours / 24);
  return d === 1 ? "ontem" : "há " + d + " dias";
}
function renderPeople() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  const withStaff = document.getElementById("staff").checked;
  const shown = people.filter((p) => {
    if (!withStaff && p.values.equipe_ravi === true) return false;
    if (!q) return true;
    return [p.values.nome, p.values.email, p.values.orgs].some((v) => typeof v === "string" && v.toLowerCase().includes(q));
  });
  const active = people.filter((p) => p.values.equipe_ravi !== true && p.values.ativa_7d === true).length;
  document.getElementById("people-title").textContent = "Pessoas · " + nf.format(active) + " ativas em 7 dias";
  const body = document.getElementById("people");
  if (!shown.length) {
    body.replaceChildren(el("tr", {}, el("td", { colSpan: 7, className: "empty", textContent: q ? "Ninguém com essa busca." : "Ninguém com atividade nos últimos 90 dias." })));
    return;
  }
  body.replaceChildren(...shown.map((p) => {
    const v = p.values;
    const areas = (Array.isArray(v.areas) ? v.areas : []).map((id) => el("span", { className: "chip", textContent: areaNames.get(id) || id }));
    const who = el("td", {},
      el("div", {}, el("span", { className: "dot" + (v.ativa_7d ? " on" : ""), title: v.ativa_7d ? "ativa em 7 dias" : "" }), v.nome || ""),
      el("div", { className: "email", textContent: v.email || "" }),
      v.equipe_ravi ? el("span", { className: "chip staff", textContent: "equipe Ravi" }) : null);
    const last = dateStart(v.ultima_atividade);
    return el("tr", {}, who,
      el("td", { className: "muted", textContent: v.orgs || "" }),
      el("td", {}, ...areas, v.usa_cli ? el("span", { className: "chip staff", textContent: "CLI ou agente" }) : null),
      el("td", { className: "num", textContent: nf.format(num(v.acoes_30d)) }),
      el("td", { className: "num", textContent: nf.format(num(v.publicacoes_30d)) }),
      el("td", { className: "num", textContent: nf.format(num(v.aberturas_30d)) }),
      el("td", { className: "muted", textContent: ago(last), title: last ? new Date(last).toLocaleString("pt-BR") : "" }));
  }));
}

document.querySelectorAll(".seg button").forEach((button) => button.addEventListener("click", () => {
  period = Number(button.dataset.days);
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  if (days.length) renderCharts();
}));
let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (days.length) renderCharts(); }, 150); });
document.getElementById("q").addEventListener("input", renderPeople);
document.getElementById("staff").addEventListener("change", renderPeople);

(async () => {
  try {
    const [dayRows, peopleRows, describe] = await Promise.all([
      queryAll(CONFIG.daysView),
      queryAll(CONFIG.peopleView),
      exec("ravi.bases.views.describe", { viewId: CONFIG.peopleView }),
    ]);
    for (const column of describe.columns || []) {
      if (column.key === "areas") for (const option of (column.config && column.config.options) || []) areaNames.set(option.id, option.name);
    }
    days = dayRows.map((r) => ({ day: dateStart(r.values.dia), values: r.values })).filter((d) => d.day).sort((a, b) => a.day.localeCompare(b.day));
    people = peopleRows;
    if (!days.length) {
      document.getElementById("asof").textContent = "Ainda sem dados. O primeiro cálculo roda no próximo tick de métricas.";
      return;
    }
    document.getElementById("asof").textContent = "Até " + longFmt.format(asDate(days[days.length - 1].day)) + ", sem contar a equipe Ravi.";
    renderKpis();
    renderCharts();
    renderPeople();
  } catch (err) {
    document.getElementById("asof").textContent = "";
    showError(err);
  }
})();
</script>
</body>
</html>
`;
