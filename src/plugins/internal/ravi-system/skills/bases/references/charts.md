# Gráficos

Um gráfico é uma view mais um encoding. O spec é um subconjunto de Vega-Lite.
A agregação roda no servidor pelo Query AST; o cliente só recebe grupos
agregados. O gráfico herda o acesso de leitura da view, inclusive princípios
em modo `aggregate`.

Não há tela de gráficos no Console. O agent cria o gráfico pelo CLI e o
desenha numa Ravi Page gerada, com os dados de `ravi.bases.charts.data`
(`ravi skills show pages --file references/layouts.md`, seção Gráficos e
dashboards).

```bash
ravi bases charts list tarefas --json
ravi bases charts create tarefas --view <view-id> --name "Horas por mês" --spec @chart.json --json
ravi bases charts show tarefas <chart-id> --json
ravi bases charts update tarefas <chart-id> --spec '{"spec":{"mark":"line","encoding":{...}}}' --json
ravi bases charts data tarefas <chart-id> --json
ravi bases charts archive tarefas <chart-id> --json --execute
```

`--spec` aceita o corpo completo `{viewId, name, description?, spec: {mark, encoding, title?}}`
ou só `{mark, encoding, title?}` junto com `--view` e `--name`.

## Spec

| campo | valores |
|---|---|
| `mark` | `bar`, `line`, `area`, `point`, `arc` (pizza; `{ "type": "arc", "innerRadius": 60 }` vira donut), `rect` (heatmap), `text` (número único); objeto `{type, innerRadius?, point?}` |
| canais | `x`, `y`, `color`, `theta`, `text` |
| `field` | chave de uma coluna da view (omita só com `aggregate: "count"`) |
| `type` | `nominal`, `ordinal`, `quantitative`, `temporal` |
| `aggregate` | `count`, `count_values`, `sum`, `avg`, `min`, `max` |
| `timeUnit` | `day`, `week`, `month`, `quarter`, `year` (obrigatório para agrupar datas) |
| `sort` | `ascending`, `descending`, `x`, `-x`, `y`, `-y` |
| `stack` | em `y` de `bar`/`area`: `zero`, `normalize`, ou `null` (sem empilhar) |
| `title` | rótulo do eixo/gráfico |

Os canais sem `aggregate` viram dimensões (no máximo 2, como no `aggregate`);
os com `aggregate` viram medidas.

## Exemplos

Horas por mês de prazo, empilhadas por status:

```json
{ "mark": "bar",
  "encoding": {
    "x": { "field": "prazo", "timeUnit": "month", "type": "temporal", "title": "Mês" },
    "y": { "field": "horas", "aggregate": "sum", "type": "quantitative", "title": "Horas" },
    "color": { "field": "status", "type": "nominal" } } }
```

Distribuição por status (donut):

```json
{ "mark": { "type": "arc", "innerRadius": 60 },
  "encoding": {
    "theta": { "aggregate": "count", "type": "quantitative" },
    "color": { "field": "status", "type": "nominal" } } }
```

Número único (total de horas):

```json
{ "mark": "text", "encoding": { "text": { "field": "horas", "aggregate": "sum", "type": "quantitative" } } }
```

Para um total "só das entregues", o filtro vai na view do gráfico, não no spec.

## Dados

`charts data` no CLI devolve `{ chart, fields, data, suppressedGroups, users }`.
O connector `ravi.bases.charts.data` (input `{ chartId }`) devolve o mesmo com
`groups` no lugar de `data`: `{ chart, groups, fields, suppressedGroups, users }`.

- `chart`: `{ id, baseId, viewId, name, description, spec, version }`.
- `data` / `groups`: uma entrada por grupo, com chaves de canal (`x`, `y`,
  `color`, `theta`, `text`). Dimensões trazem id de opção, user id, número,
  booleano, início do bucket (`YYYY-MM-DD`) ou `null`; medidas trazem número
  (ou ISO em min/max de data). Os grupos vêm ordenados pelo valor cru das
  dimensões (vazio por último); o `sort` do spec e a ordem das opções não são
  aplicados no servidor: aplique no cliente.
- `fields`: descritores das colunas usadas, por chave (nome, tipo, opções) para
  traduzir ids em rótulos. `users` traduz user ids.
- `suppressedGroups`: grupos com menos de 5 linhas escondidos para quem lê em
  modo `aggregate`. Num time pequeno, mostre linhas.

## Na Ravi Page

1. View do gráfico com `page_viewer` do site em `access.read` (com
   `"mode": "aggregate"` quando quem vê não pode ver linhas).
2. `ravi bases charts create ...` e guarde o `id`.
3. A página chama `ravi.bases.charts.data` com o `chartId` constante e desenha
   em SVG puro com o renderizador de `layouts.md` (skill pages): barras
   empilhadas, linha, área, pizza/donut, número único; os outros marks viram
   tabela.
4. Ship com `--uses ravi.bases.charts.data` (mais `ravi.bases.views.describe`
   se a página ler o `layout.chartId` de uma view `chart`), somado aos ids das
   outras páginas de dados do host.

Use SVG próprio por padrão. Biblioteca de gráfico via CDN é opcional; a
página continua sem token e sem dados embutidos. O spec salvo não serve direto
ao Vega-Lite: os `groups` já vêm agregados e têm chave por canal (`x`, `y`,
`color`, ...), não por coluna. Para usar o Vega-Lite, troque o `field` de cada
canal pelo nome do canal (`"field": "x"`), tire `aggregate` (os grupos já são
o resultado) e `timeUnit` (os buckets já começam na unidade), e passe
`data.values` = `groups` com ids trocados por rótulos.
