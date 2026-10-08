# Exemplo: página completa sobre uma view

> Este exemplo traz o cliente inline (`exec`, `showError` dentro do HTML). Em página nova, use `client.js`, cópia de `esqueletos/_client.js.txt`, e não duplique o cliente.
> Apesar do nome do arquivo, é uma tabela com formulário e edição em linha; o board pronto está em `esqueletos/board.html.txt`.
> A "tabela acima" citada no código é a de "Valores", em `data-pages.md`. Antes do ship, confira o `--uses` com a união do host (`data-pages.md`, "Ship").

## Exemplo completo

Página genérica sobre uma view: describe, tabela com paginação e ordenação,
formulário de criação e edição em linha. Troque `VIEW_ID`. `--uses`:
`ravi.bases.views.describe,ravi.bases.views.query,ravi.bases.views.rows.create,ravi.bases.views.rows.update`.

```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Base</title>
<style>
  body { font: 14px/1.45 system-ui, sans-serif; margin: 24px; color: #1f2328; background: #fff; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; vertical-align: top; }
  th[data-sort] { cursor: pointer; }
  .chip { display: inline-block; padding: 0 6px; border-radius: 4px; margin: 0 4px 2px 0; }
  .err { color: #b42318; }
  .ok { color: #067647; }
  form label { display: block; margin: 8px 0; }
  form small { display: block; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<h1 id="title">Carregando…</h1>
<p id="banner" hidden></p>
<form id="create" hidden></form>
<table id="grid" hidden><thead><tr></tr></thead><tbody></tbody></table>
<button id="more" type="button" hidden>Carregar mais</button>
<script>
const VIEW_ID = "00000000-0000-0000-0000-000000000000"; // id da view (ravi bases views list)
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((kid) => kid !== null && kid !== undefined && kid !== ""));
  return node;
}

// --- cliente do host bridge -------------------------------------------------
class ExecError extends Error {
  constructor(code, status, body, requestId) {
    super(code);
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.fieldErrors = body && typeof body.fieldErrors === "object" ? body.fieldErrors : null;
    this.current = body && typeof body.current === "object" ? body.current : null;
  }
}
async function exec(id, input) {
  let res;
  try {
    res = await fetch("/_ravi/connectors/exec", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, input }),
    });
  } catch {
    throw new ExecError("network_error", 0, null, null);
  }
  let body = null;
  try { body = await res.json(); } catch { /* corpo não JSON */ }
  if (res.ok && body && body.ok === true) return body.output;
  const code = body && typeof body.error === "string" ? body.error : "connector_unavailable";
  throw new ExecError(code, res.status, body, res.headers.get("x-request-id"));
}
const MESSAGES = {
  not_found: "Isto não está disponível para você, ou saiu desta lista.",
  base_forbidden: "Esta tela não permite essa ação.",
  view_invalid: "Esta tela está em manutenção. Avise quem cuida da base.",
  write_escapes_view: "Essa mudança tiraria a linha desta lista.",
  base_archived: "A base está só para leitura.",
  query_timeout: "A consulta demorou demais. Tente de novo.",
  connector_rate_limited: "Muitas ações seguidas. Espere alguns segundos.",
  network_error: "Sem conexão. Tente de novo.",
};
function banner(...parts) {
  const node = $("banner");
  node.className = "err";
  node.hidden = false;
  node.replaceChildren(...parts);
}
function showError(err) {
  if (err.code === "connector_session_required" || err.code === "connector_unauthorized") {
    return banner("Sua sessão expirou. ", el("button", { type: "button", textContent: "Entrar de novo", onclick: () => location.reload() }));
  }
  const text = MESSAGES[err.code] || "Algo deu errado. Tente de novo.";
  banner(err.requestId ? `${text} (código ${err.requestId})` : text);
}

// --- valores ------------------------------------------------------------------
const COLORS = { gray: "#eceff3", brown: "#efe3d7", orange: "#fde7d3", yellow: "#fdf3c7", green: "#dcf3e3", blue: "#dde9fb", purple: "#ebe2fb", pink: "#fbe2ef", red: "#fbdcdc" };
const SORTABLE = new Set(["text", "url", "email", "phone", "number", "checkbox", "date", "select", "status", "created_time", "updated_time"]);
// Este exemplo só edita estes tipos. `person` e `ref` aparecem só para leitura; se a view
// permitir escrevê-los, adicione um editor que mande user ids ou `{ type, id }` (tabela acima).
const EDITABLE = new Set(["text", "url", "email", "phone", "number", "checkbox", "date", "select", "status", "multi_select"]);
let view = null;
let rows = [];
let cursor = null;
let sort = null;
const users = {};

function chip(col, id) {
  const option = (col.config.options || []).find((candidate) => candidate.id === id);
  const node = el("span", { className: "chip", textContent: option ? option.name : id });
  node.style.background = COLORS[option && option.color] || COLORS.gray;
  return node;
}
function dateText(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("pt-BR");
  }
  return new Date(value).toLocaleString("pt-BR");
}
function numberText(col, value) {
  const { format, currency, precision } = col.config;
  const digits = precision === undefined ? {} : { minimumFractionDigits: precision, maximumFractionDigits: precision };
  if (format === "percent") return new Intl.NumberFormat("pt-BR", { style: "percent", ...digits }).format(value);
  if (format === "currency" && currency) return new Intl.NumberFormat("pt-BR", { style: "currency", currency, ...digits }).format(value);
  return new Intl.NumberFormat("pt-BR", digits).format(value);
}
function link(href, text) {
  try {
    if (!["http:", "https:", "mailto:", "tel:"].includes(new URL(href).protocol)) return text;
  } catch {
    return text;
  }
  return el("a", { href, textContent: text, target: "_blank", rel: "noopener noreferrer" });
}
const userName = (id) => (users[id] && users[id].displayName) || "Sem nome";
function show(col, value) {
  if (value === undefined || value === null) return "";
  switch (col.type) {
    case "select": case "status": return chip(col, value);
    case "multi_select": return el("span", {}, ...value.map((id) => chip(col, id)));
    case "person": return value.map(userName).join(", ");
    case "created_by": case "updated_by": return userName(value);
    case "date": return value.end ? `${dateText(value.start)} → ${dateText(value.end)}` : dateText(value.start);
    case "created_time": case "updated_time": return dateText(value);
    case "checkbox": return value ? "✓" : "";
    case "number": return numberText(col, value);
    case "url": return link(value, value);
    case "email": return link(`mailto:${value}`, value);
    case "phone": return link(`tel:${value.replace(/[^+0-9]/g, "")}`, value);
    case "ref": return value.map((ref) => `${ref.type}:${ref.id}`).join(", ");
    default: return String(value);
  }
}
function localInputDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function field(col, value) {
  const type = col.type;
  let node;
  if (type === "select" || type === "status" || type === "multi_select") {
    node = el("select", { multiple: type === "multi_select" });
    if (type !== "multi_select") node.append(el("option", { value: "", textContent: "—" }));
    const current = type === "multi_select" ? value || [] : [value];
    for (const option of col.config.options || []) {
      const selected = current.includes(option.id);
      if (option.archived && !selected) continue; // arquivada: só aparece se já é o valor
      node.append(el("option", { value: option.id, textContent: option.name, selected }));
    }
  } else if (type === "checkbox") {
    node = el("input", { type: "checkbox", checked: value === true });
  } else if (type === "date") {
    const withTime = col.config.includeTime === true;
    node = el("input", { type: withTime ? "datetime-local" : "date", value: value ? (withTime ? localInputDate(value.start) : value.start) : "" });
  } else if (type === "body") {
    node = el("textarea", { rows: 4, value: value || "" });
  } else {
    const inputType = { number: "number", url: "url", email: "email", phone: "tel" }[type] || "text";
    node = el("input", { type: inputType, value: value === undefined || value === null ? "" : String(value) });
    if (type === "number") node.step = "any";
  }
  node.name = col.key;
  node.required = col.required && type !== "checkbox";
  return node;
}
function read(col, node) {
  if (col.type === "checkbox") return node.checked;
  if (col.type === "multi_select") return [...node.selectedOptions].map((option) => option.value);
  if (node.value === "") return null;
  if (col.type === "number") return Number(node.value);
  if (col.type === "date") return col.config.includeTime ? new Date(node.value).toISOString() : node.value;
  return node.value;
}

// --- tabela: consulta, paginação, ordenação, edição -----------------------------
const shownColumns = () => view.columns.filter((col) => col.type !== "body");
const writable = (col) => view.capabilities.writeColumns.includes(col.key) && EDITABLE.has(col.type);

function renderHeader() {
  const tr = $("grid").tHead.rows[0];
  tr.replaceChildren(...shownColumns().map((col) => {
    const mark = sort && sort.prop === col.key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
    const th = el("th", { textContent: col.name + mark });
    if (SORTABLE.has(col.type)) {
      th.dataset.sort = col.key;
      th.onclick = () => {
        sort = { prop: col.key, dir: sort && sort.prop === col.key && sort.dir === "asc" ? "desc" : "asc" };
        renderHeader();
        load(true);
      };
    }
    return th;
  }));
}
function renderRows() {
  $("grid").tBodies[0].replaceChildren(...rows.map((row) => el("tr", {}, ...shownColumns().map((col) => {
    if (!writable(col)) return el("td", {}, show(col, row.values[col.key]));
    const input = field(col, row.values[col.key]);
    input.onchange = () => {
      let value = read(col, input);
      const prev = row.values[col.key];
      // O campo edita só o início; uma data só apagaria o fim do intervalo.
      if (col.type === "date" && value !== null && prev && prev.end) value = { start: value, end: prev.end };
      save(row, { [col.key]: value });
    };
    return el("td", {}, input);
  }))));
}
let loadSeq = 0; // só a consulta mais recente aplica o resultado
async function load(reset) {
  const mine = ++loadSeq;
  if (reset) { cursor = null; rows = []; }
  $("more").disabled = true;
  try {
    const page = await exec("ravi.bases.views.query", {
      viewId: VIEW_ID,
      limit: 50,
      ...(sort ? { sort: [sort] } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (mine !== loadSeq) return;
    rows.push(...page.rows);
    Object.assign(users, page.users);
    cursor = page.nextCursor;
    $("more").hidden = !cursor;
    renderRows();
  } catch (err) {
    if (mine !== loadSeq) return;
    if (err.code === "cursor_invalid" && !reset) return load(true);
    showError(err);
  } finally {
    if (mine === loadSeq) $("more").disabled = false;
  }
}
async function save(row, values, expectedVersion = row.version) {
  try {
    const updated = await exec("ravi.bases.views.rows.update", {
      viewId: VIEW_ID, rowId: row.rowId, values, expectedVersion, idempotencyKey: crypto.randomUUID(),
    });
    Object.assign(row, updated);
    $("banner").hidden = true;
  } catch (err) {
    if (err.code === "version_conflict" && err.current) {
      Object.assign(row, err.current);
      banner(
        "Alguém mudou esta linha antes de você. ",
        el("button", { type: "button", textContent: "Reaplicar minha mudança", onclick: () => save(row, values, row.version) }),
      );
    } else if (err.code === "not_found") {
      rows = rows.filter((candidate) => candidate !== row);
      showError(err);
    } else if (err.code === "validation_failed" && err.fieldErrors) {
      banner(Object.values(err.fieldErrors).join(" "));
    } else {
      showError(err);
    }
  }
  renderRows();
}

// --- formulário de criação ------------------------------------------------------
let pending = null; // { json, key }: a mesma chave só para repetir o mesmo envio
function buildForm() {
  const form = $("create");
  const cols = view.columns.filter((col) => view.capabilities.writeColumns.includes(col.key) && (EDITABLE.has(col.type) || col.type === "body"));
  const layout = view.layout.type === "form" ? view.layout : {};
  form.replaceChildren(
    el("h2", { textContent: layout.title || "Novo registro" }),
    ...(layout.description ? [el("p", { textContent: layout.description })] : []),
    ...cols.map((col) => el("label", {}, col.name + (col.required ? " *" : ""), el("br"), field(col),
      el("small", { className: "err", id: `err-${col.key}` }))),
    el("p", { className: "err", id: "err-form" }),
    el("button", { type: "submit", textContent: layout.submitLabel || "Enviar" }),
  );
  form.onsubmit = async (event) => {
    event.preventDefault();
    const values = {};
    let body;
    for (const col of cols) {
      const value = read(col, form.elements.namedItem(col.key));
      if (col.type === "body") { if (value !== null) body = value; }
      else if (value !== null && !(Array.isArray(value) && !value.length)) values[col.key] = value;
    }
    const input = { viewId: VIEW_ID, values, ...(body !== undefined ? { body } : {}) };
    const json = JSON.stringify(input);
    if (!pending || pending.json !== json) pending = { json, key: crypto.randomUUID() };
    form.querySelectorAll(".err, .ok").forEach((node) => { node.textContent = ""; });
    $("err-form").className = "err";
    $("banner").hidden = true;
    form.querySelector("button[type=submit]").disabled = true;
    try {
      await exec("ravi.bases.views.rows.create", { ...input, idempotencyKey: pending.key });
      pending = null;
      form.reset();
      $("err-form").className = "ok";
      $("err-form").textContent = layout.successMessage || "Enviado.";
      if (view.capabilities.read) await load(true);
    } catch (err) {
      $("err-form").className = "err";
      if (err.code === "validation_failed" && err.fieldErrors) {
        for (const [key, message] of Object.entries(err.fieldErrors)) {
          const slot = document.getElementById(`err-${key}`) || $("err-form");
          slot.textContent = slot.textContent ? `${slot.textContent} ${message}` : message;
        }
      } else {
        showError(err);
      }
    } finally {
      form.querySelector("button[type=submit]").disabled = false;
    }
  };
  form.hidden = false;
}

// --- início ---------------------------------------------------------------------
async function main() {
  try {
    view = await exec("ravi.bases.views.describe", { viewId: VIEW_ID });
  } catch (err) {
    $("title").textContent = "Indisponível";
    return showError(err);
  }
  document.title = view.name;
  $("title").textContent = view.name;
  if (!view.valid) return showError({ code: "view_invalid" });
  if (view.capabilities.create) buildForm();
  if (view.capabilities.read) {
    $("grid").hidden = false;
    $("more").onclick = () => load(false);
    renderHeader();
    await load(true);
  }
}
main();
</script>
</body>
</html>
```
