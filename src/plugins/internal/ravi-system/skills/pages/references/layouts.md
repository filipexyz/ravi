# Layouts de página de dados

Parte da skill pages. Pressupõe `data-pages.md` (connectors, valores, erros) e
o cliente `esqueletos/_client.js.txt`, publicado como `client.js`. Cada layout
diz de qual esqueleto partir.

## Padrões por layout

Comece sempre por `describe` e use `capabilities` para decidir o que desenhar:
sem `read`, não chame `query`; coluna fora de `writeColumns`, sem editor; sem
`create` ou `archive`, sem o botão. Esconder é só conforto: quem barra é a
view.

### Tabela

Esqueleto: `exemplo-board.md` (tabela com edição e formulário); troque o cliente inline por `client.js`.

- Cabeçalhos: `columns` do describe, na ordem. Pule `body` (a query não traz).
- Paginação: `limit` de 50 a 100 e "Carregar mais" com `nextCursor`. Não
  percorra todas as páginas sem a pessoa pedir.
- Ordenação: clique em coluna ordenável (`text`, `url`, `email`, `phone`,
  `number`, `checkbox`, `date`, `select`, `status`, `created_time`,
  `updated_time`) → `sort: [{ prop, dir }]` e recomece sem cursor.
- Filtros da tela: AST só com colunas projetadas; mudar o filtro também
  recomeça a paginação.
- Edição em linha: só células em `writeColumns`; `rows.update` com
  `{ [key]: valor }` e o `version` da linha; troque a linha pelo `output`.

### Board

Esqueleto: `esqueletos/board.html.txt`.

- `layout.groupBy` é `select` ou `status`. Uma coluna do board por opção de
  `config.options`, na ordem, mais "Sem valor". Opção arquivada só vira coluna
  se alguma linha ainda a usa. `layout.hideEmptyGroups` esconde colunas
  vazias.
- Carregue seguindo `nextCursor` até um teto (ex.: 1.000 linhas) e avise
  quando parar nele.
- Arraste só se `groupBy` estiver em `writeColumns`. Ao soltar, mova o
  cartão e chame `rows.update` com `values: { [groupBy]: optionId }` (`null`
  para "Sem valor"), `expectedVersion: row.version` e chave nova. Em erro,
  volte o cartão: `version_conflict` → posicione por `current`;
  `write_escapes_view` → a view não aceita linhas naquela coluna (ex.: view
  "em aberto" e coluna "Publicada"); `validation_failed` → coluna obrigatória ou
  opção arquivada.

### Lista e galeria

Esqueleto: `esqueletos/board.html.txt`; mantenha `load()` e troque `render()` por itens ou cartões.

- Lista: um item por linha; título = primeira coluna `text`; o resto como
  chips; clique abre o detalhe.
- Galeria: um cartão por linha, tamanho por `layout.cardSize` (`small`,
  `medium`, `large`). `layout.coverProp` é `url` (imagem: só `http(s)`,
  `loading="lazy"`, `referrerpolicy="no-referrer"`) ou `text`.

### Calendário

Esqueleto: `esqueletos/board.html.txt`; troque `load()` pela consulta do mês e `render()` por uma grade de dias.

- `layout.dateProp` é `date`, `created_time` ou `updated_time`.
- Consulte o mês visível: `filter: { "prop": <dateProp>, "op": "between",
  "value": ["2026-10-01", "2026-10-31"] }` (para intervalos, `between` testa
  sobreposição; os dias são os do fuso da base), `limit: 500`, seguindo o
  cursor.
- Data sem hora: use o texto `YYYY-MM-DD` direto. Instante: converta para o
  dia local de quem vê. Com `end`, ocupe os dias até o fim.
- Arrastar para outro dia: só se `dateProp` for `date` em `writeColumns`;
  `rows.update` com `"YYYY-MM-DD"` (ou `{ start, end }` deslocados).

### Formulário

Esqueleto: `esqueletos/formulario.html.txt`.

- `layout.type: "form"` traz `title`, `description`, `submitLabel` e
  `successMessage`. Em geral `read` é falso: não chame `query`.
- Campos = colunas com `key` em `writeColumns`, na ordem de `columns`;
  `required` marca o campo. Chaves de `write.set` nunca estão em
  `writeColumns`: não desenhe nem envie (o Console preenche).
- Envio: `rows.create` com os valores preenchidos e uma chave por envio; a
  mesma chave se reenviar o mesmo input depois de erro de rede.
- `validation_failed`: cada `fieldErrors[key]` sob o campo; o resto no topo.
- Sucesso: mostre `successMessage` e limpe. O output é só `{ rowId, version }`.
  Formulário sem leitura não relê a linha (`rows.get` dá `base_forbidden`).

### Detalhe e arquivar

Esqueleto: nenhum; `client.js` não tem helper para `rows.get` e `rows.archive`, chame `exec("ravi.bases.views.rows.get", { viewId, rowId })`.

- Detalhe: `rows.get { viewId, rowId }` traz a linha com `body` (se
  projetado) e `users`. `rowId` na URL (`#row=<id>`) é seguro; valores não.
- `not_found` no detalhe: a linha saiu da view, foi arquivada ou não existe.
  Tire da lista.
- Arquivar: só com `capabilities.archive`. Confirme com a pessoa, chame
  `rows.archive { viewId, rowId, expectedVersion }` e tire a linha da tela.
  `not_found` = já foi; `version_conflict` = mostre `current` e pergunte de
  novo.

### Gráficos e dashboards

Esqueleto: nenhum de página; cole o código abaixo depois de `client.js`.

`charts.data` devolve `groups`: um objeto por grupo, com chaves de canal
(`x`, `y`, `color`, `theta`, `text`). Canal de dimensão traz id de opção, user
id, número, booleano, início do bucket (`YYYY-MM-DD`) ou `null`; canal de
medida traz número (ou ISO em `min`/`max` de data). `chart.spec.encoding[canal].field`
é a chave da coluna e `fields[chave]` traz nome, tipo e opções para rotular.
O servidor ordena os grupos pelo valor cru das dimensões (vazio por último),
não pelo `sort` do spec nem pela ordem das opções: aplique os dois no cliente.
`suppressedGroups > 0`: diga que grupos com menos de 5 linhas ficaram
ocultos.

Dashboard = um `charts.data` por gráfico. Para quem não pode ver linhas, a
view do gráfico usa `"mode": "aggregate"` no `page_viewer`. Uma view com
`layout.type: "chart"` aponta o gráfico em `layout.chartId`.

SVG puro, sem biblioteca: barras (por `color`, conforme `stack` da medida:
`zero` empilha, `normalize` 100%, `null` lado a lado), linha, área (sem
empilhar), pizza ou donut e número único; gráfico só com medida vira uma barra.
Os outros marks viram tabela. Usa `exec`, `el` e `showError` do cliente (`esqueletos/_client.js.txt`).

```js
const SVG_NS = "http://www.w3.org/2000/svg";
const PALETTE = ["#4269d0", "#efb118", "#ff725c", "#6cc5b0", "#3ca951", "#ff8ab7", "#a463f2", "#97bbf5"];
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function groupLabel(field, def, value, users) {
  if (value === null || value === undefined) return "(vazio)";
  if (def && def.timeUnit && typeof value === "string") {
    const [y, m, d] = value.slice(0, 10).split("-").map(Number);
    if (def.timeUnit === "year") return String(y);
    if (def.timeUnit === "quarter") return `T${Math.floor((m - 1) / 3) + 1}/${y}`;
    const date = new Date(y, m - 1, d);
    return def.timeUnit === "month" ? date.toLocaleDateString("pt-BR", { month: "short", year: "numeric" }) : date.toLocaleDateString("pt-BR");
  }
  const type = field && field.type;
  if (type === "select" || type === "status" || type === "multi_select") {
    const option = (field.config.options || []).find((candidate) => candidate.id === value);
    return option ? option.name : String(value);
  }
  if (type === "person" || type === "created_by" || type === "updated_by") return (users[value] && users[value].displayName) || "Sem nome";
  if (type === "checkbox") return value ? "Sim" : "Não";
  return String(value);
}
const measureText = (value) =>
  typeof value === "number" ? new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value) : value === null || value === undefined ? "—" : String(value);
// Opções na ordem da propriedade, o resto pelo valor, vazio por último; o `sort` do spec por cima.
function ordered(values, def, field, measure, total) {
  const options = (field && field.config && field.config.options) || [];
  const rank = (v) => { const i = options.findIndex((o) => o.id === v); return i < 0 ? options.length : i; };
  const base = (a, b) => (options.length ? rank(a) - rank(b) : a < b ? -1 : a > b ? 1 : 0);
  const sort = def && typeof def.sort === "string" ? def.sort : "";
  const dir = sort === "descending" || sort.startsWith("-") ? -1 : 1;
  const byMeasure = measure && sort.replace("-", "") === measure;
  return [...values].sort((a, b) => (a === null) - (b === null) || dir * ((byMeasure ? total(a) - total(b) : 0) || base(a, b)));
}
// Barras e linhas: uma dimensão (o canal sem aggregate entre x e y), uma medida, `color` opcional como série.
// Sem dimensão (só a medida), uma categoria só. `null` em `color` é o grupo vazio, não "sem série": daí NO_SERIES.
const NO_SERIES = {};
function axes(enc) {
  const dim = enc.x && !enc.x.aggregate ? "x" : enc.y && !enc.y.aggregate ? "y" : null;
  return { dim, measure: dim === "x" ? "y" : dim === "y" ? "x" : enc.y ? "y" : "x" };
}
function seriesChart(groups, enc, label, kind, fieldOf) {
  const { dim, measure } = axes(enc);
  const catOf = (g) => (dim ? g[dim] : "");
  const catLabel = (cat) => (dim ? label(dim, cat) : "");
  const num = (g) => (g && typeof g[measure] === "number" ? g[measure] : 0);
  const sumOf = (cat) => groups.filter((g) => catOf(g) === cat).reduce((sum, g) => sum + num(g), 0);
  const cats = dim ? ordered([...new Set(groups.map(catOf))], enc[dim], fieldOf(dim), measure, sumOf) : [""];
  const series = enc.color ? ordered([...new Set(groups.map((g) => g.color))], enc.color, fieldOf("color")) : [NO_SERIES];
  const at = (cat, s) => groups.find((g) => catOf(g) === cat && (s === NO_SERIES || g.color === s));
  const stack = enc[measure] && enc[measure].stack !== undefined ? enc[measure].stack : "zero";
  const percent = kind === "bar" && stack === "normalize";
  const side = kind === "bar" && stack === null && series.length > 1;
  const share = (cat, g) => (percent ? num(g) / (sumOf(cat) || 1) : num(g));
  const tip = (cat, s, g) => {
    const head = [catLabel(cat), s === NO_SERIES ? "" : label("color", s)].filter(Boolean).join(" · ");
    const text = measureText(g ? g[measure] : null);
    return head ? `${head}: ${text}` : text;
  };
  const W = 640, H = 280, P = 36;
  const max = percent ? 1 : Math.max(1, ...(kind === "bar" && !side ? cats.map(sumOf) : groups.map(num)));
  const scale = (v) => (v / max) * (H - P * 2);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img" });
  const step = (W - P * 2) / Math.max(cats.length, 1);
  cats.forEach((cat, i) => {
    root.append(svg("text", { x: P + i * step + step / 2, y: H - P + 16, "text-anchor": "middle", "font-size": 11 }, catLabel(cat)));
  });
  series.forEach((s, j) => {
    const color = PALETTE[j % PALETTE.length];
    if (kind === "bar") {
      const width = Math.max((step - 8) / (side ? series.length : 1), 1);
      cats.forEach((cat, i) => {
        const g = at(cat, s);
        const below = side ? 0 : series.slice(0, j).reduce((sum, prev) => sum + share(cat, at(cat, prev)), 0);
        const height = scale(share(cat, g));
        const rect = svg("rect", { x: P + i * step + 4 + (side ? j * width : 0), y: H - P - scale(below) - height, width, height, fill: color });
        rect.append(svg("title", {}, tip(cat, s, g)));
        root.append(rect);
      });
      return;
    }
    // categoria sem grupo nesta série não vira ponto zero: fica fora da linha
    const points = cats.flatMap((cat, i) => {
      const g = at(cat, s);
      return g ? [[P + i * step + step / 2, H - P - scale(num(g))]] : [];
    });
    const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join("");
    if (kind === "area" && points.length) {
      root.append(svg("path", { d: `${line}L${points[points.length - 1][0]},${H - P}L${points[0][0]},${H - P}Z`, fill: color, "fill-opacity": 0.2 }));
    }
    root.append(svg("path", { d: line, fill: "none", stroke: color, "stroke-width": 2 }));
  });
  return root;
}
function arcChart(groups, enc, label, innerRadius, fieldOf) {
  const order = ordered(groups.map((g) => g.color), enc.color, fieldOf("color"));
  groups = [...groups].sort((a, b) => order.indexOf(a.color) - order.indexOf(b.color));
  const total = groups.reduce((sum, g) => sum + (typeof g.theta === "number" ? g.theta : 0), 0) || 1;
  const R = 110, C = 120, r = Math.min(innerRadius || 0, R - 10);
  const root = svg("svg", { viewBox: "0 0 240 240", width: 240, role: "img" });
  const point = (radius, angle) => `${C + radius * Math.cos(angle)},${C + radius * Math.sin(angle)}`;
  let start = -Math.PI / 2;
  groups.forEach((g, j) => {
    const value = typeof g.theta === "number" ? g.theta : 0;
    const end = Math.min(start + (value / total) * 2 * Math.PI, start + 2 * Math.PI - 1e-4);
    const large = end - start > Math.PI ? 1 : 0;
    const d = r
      ? `M${point(R, start)}A${R},${R} 0 ${large} 1 ${point(R, end)}L${point(r, end)}A${r},${r} 0 ${large} 0 ${point(r, start)}Z`
      : `M${C},${C}L${point(R, start)}A${R},${R} 0 ${large} 1 ${point(R, end)}Z`;
    const slice = svg("path", { d, fill: PALETTE[j % PALETTE.length] });
    slice.append(svg("title", {}, `${label("color", g.color)}: ${measureText(g.theta)}`));
    root.append(slice);
    start = end;
  });
  return root;
}
async function renderChart(chartId, mount) {
  let data;
  try {
    data = await exec("ravi.bases.charts.data", { chartId });
  } catch (err) {
    return showError(err);
  }
  const { chart, groups, fields, suppressedGroups, users } = data;
  const enc = chart.spec.encoding;
  const mark = typeof chart.spec.mark === "string" ? chart.spec.mark : chart.spec.mark.type;
  const fieldOf = (channel) => fields[enc[channel] && enc[channel].field];
  const label = (channel, value) => groupLabel(fieldOf(channel), enc[channel], value, users);
  let body;
  if (mark === "text") body = el("p", { className: "kpi", textContent: measureText(groups[0] ? groups[0].text : null) });
  else if (mark === "arc") body = arcChart(groups, enc, label, chart.spec.mark.innerRadius, fieldOf);
  else if (mark === "bar" || mark === "line" || mark === "area") body = seriesChart(groups, enc, label, mark, fieldOf);
  else {
    const channels = Object.keys(enc);
    body = el("table", {}, el("tr", {}, ...channels.map((c) => el("th", { textContent: enc[c].title || (fields[enc[c].field] || {}).name || c }))),
      ...groups.map((g) => el("tr", {}, ...channels.map((c) => el("td", { textContent: enc[c].aggregate ? measureText(g[c]) : label(c, g[c]) })))));
  }
  mount.replaceChildren(
    el("h3", { textContent: chart.spec.title || chart.name }),
    body,
    suppressedGroups ? el("p", { textContent: `${suppressedGroups} grupo(s) com menos de 5 linhas ocultos.` }) : "",
  );
}
```
