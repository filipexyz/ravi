# Gráficos

Um gráfico é uma view mais um encoding. O spec é um subconjunto de Vega-Lite.
A agregação roda no Console pelo Query AST; o cliente só recebe grupos
agregados. O gráfico herda o acesso de leitura da view, inclusive princípios
em modo `aggregate`.

```bash
ravi bases charts list pipeline --json
ravi bases charts create pipeline --view <view-id> --name "Pipeline por mês" --spec @chart.json --json
ravi bases charts show pipeline <chart-id> --json
ravi bases charts update pipeline <chart-id> --spec '{"spec":{"mark":"line","encoding":{...}}}' --json
ravi bases charts data pipeline <chart-id> --json
ravi bases charts archive pipeline <chart-id> --json --execute
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

Os canais sem `aggregate` viram dimensões (máximo 2, como no `--group-by`); os
com `aggregate` viram medidas.

## Exemplos

Pipeline por mês, empilhado por estágio:

```json
{ "mark": "bar",
  "encoding": {
    "x": { "field": "close_date", "timeUnit": "month", "type": "temporal", "title": "Mês" },
    "y": { "field": "amount", "aggregate": "sum", "type": "quantitative", "title": "Valor" },
    "color": { "field": "stage", "type": "nominal" } } }
```

Distribuição por estágio (donut):

```json
{ "mark": { "type": "arc", "innerRadius": 60 },
  "encoding": {
    "theta": { "aggregate": "count", "type": "quantitative" },
    "color": { "field": "stage", "type": "nominal" } } }
```

Número único (total ganho):

```json
{ "mark": "text", "encoding": { "text": { "field": "amount", "aggregate": "sum", "type": "quantitative" } } }
```

Para um total "só dos ganhos", o filtro vai na view do gráfico, não no spec.

## Dados

`charts data` devolve `{ chart, fields, data, suppressedGroups, users }`:

- `data`: uma entrada por grupo, com chaves de canal (`x`, `y`, `color`, `theta`,
  `text`). Dimensões trazem id de opção, user id, número, booleano, início do
  bucket (`YYYY-MM-DD`) ou `null`; medidas trazem número (ou ISO em min/max de data).
- `fields`: descritores das colunas usadas (nome, tipo, opções) para traduzir ids
  em rótulos. `users` traduz user ids.
- `suppressedGroups`: grupos com menos de 5 linhas escondidos para quem lê em
  modo `aggregate`.

Numa Ravi Page, use o connector `ravi.bases.charts.data` e desenhe com a
biblioteca que quiser (Vega-Lite via CDN aceita o mesmo spec com `data.values`).
