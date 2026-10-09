# Query AST

O mesmo AST serve para `rows query --filter`, `views query --filter`,
`aggregate --filter`, `query.filter` de uma view e o input `filter` do connector
`ravi.bases.views.query`. O Console compila e valida. Operador desconhecido,
propriedade desconhecida ou valor do tipo errado falham (`invalid_filter`,
`unknown_property`); nenhuma folha é ignorada.

## Forma

```json
{ "prop": "<chave>", "op": "<operador>", "value": <valor> }
{ "and": [ <nó>, ... ] }
{ "or":  [ <nó>, ... ] }
{ "not": <nó> }
```

- `prop`: chave da propriedade, id da propriedade, ou coluna de sistema
  (`created_time`, `created_by`, `updated_time`, `updated_by`). `body` não é
  filtrável nem ordenável.
- `and`/`or`: 1 a 32 filhos. Profundidade máxima 8. Máximo 64 folhas.
- Valor vazio nunca casa uma comparação; `not` é complemento exato. Teste vazio
  só com `is_empty` / `is_not_empty` (sem `value`).
- `--filter` aceita o nó direto ou `{ "filter": <nó> }`, inline ou `@arquivo.json`.

## Operadores por tipo

| tipo | operadores | valor |
|---|---|---|
| `text`, `url`, `phone` | `eq`, `neq` (exato); `contains`, `not_contains`, `starts_with` (sem diferenciar maiúsculas); `is_empty`, `is_not_empty` | string |
| `email` | os de texto; `eq`/`neq` sem diferenciar maiúsculas | string |
| `number` | `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `between`, `is_empty`, `is_not_empty` | número; `between`: `[a, b]` inclusivo |
| `checkbox` | `eq` | `true`/`false` |
| `date` | `eq`, `before`, `after`, `on_or_before`, `on_or_after`, `between`, `within`, `is_empty`, `is_not_empty` | `"YYYY-MM-DD"` ou instante ISO; `between`: `[a, b]`; `within`: ver abaixo |
| `created_time`, `updated_time` | os de `date` menos `is_empty`/`is_not_empty` | idem |
| `select`, `status` | `eq`, `neq`, `in`, `nin`, `is_empty`, `is_not_empty` | nome ou id da opção; `in`/`nin`: array; `status` aceita `{ "group": "done" }` em `eq`/`neq` |
| `multi_select`, `person` | `contains`, `not_contains`, `contains_any`, `contains_all`, `is_empty`, `is_not_empty` | um elemento; `contains_any`/`contains_all`: array |
| `ref` | `contains`, `is_empty`, `is_not_empty` | `{ "type": "...", "id": "..." }` |
| `created_by`, `updated_by` | `eq`, `neq`, `in` | user id (ou array em `in`) |

Datas: `eq` compara o mesmo dia no fuso da base (ou o mesmo instante);
`before`/`after`/`on_or_*` comparam o `start`; `between` testa sobreposição.

`within`: `"today"`, `"this_week"` (semana começa na segunda), `"this_month"`,
`"this_year"`, `{ "past": "7d" }` ou `{ "next": "2w" }`. Durações: `Nd`, `Nw`,
`Nmo`, `Ny` com 1 ≤ N ≤ 1000. Tudo no fuso da base (`--timezone` no create).

Nomes de opção são resolvidos para ids ao salvar/compilar. Nome inexistente é
`invalid_filter`.

## Variáveis

O Console resolve a partir de quem chama, nunca do corpo do request:

| variável | valor |
|---|---|
| `$viewer.raviUserId` | user id Ravi de quem chama |
| `$viewer.raviOrgId` | id da organização da base |
| `$viewer.email` | e-mail principal de quem chama, minúsculo |
| `$now` | agora |
| `$today` | hoje no fuso da base |

- `$viewer.*` só em: `person` com `contains`/`not_contains`; `email` com
  `eq`/`neq`; `created_by`/`updated_by` com `eq`/`neq`/`in`. Nunca em operadores
  de substring.
- `$now` e `$today` valem onde cabe um valor de data.
- Sem viewer resolvível (job de sistema), filtro com `$viewer.*` falha fechado.

## Ordenação, paginação, agregação

- `--sort prazo,horas:desc`: até 3 chaves num valor só, separadas por vírgula,
  em colunas ordenáveis (`text`, `url`, `email`, `phone`, `number`, `checkbox`,
  `date`, `select`, `status`, `created_time`, `updated_time`). Vazios vão por
  último. Padrão: `created_time` asc. Uma view com `query.sort` salvo já ordena
  no `views query`.
- `--limit` 1-500 (padrão 100). Cursor opaco, 15 minutos, preso à mesma
  consulta, view, schema e a quem chama (`cursor_invalid` se mudar).
- `aggregate`: até 2 dimensões num valor só, separadas por vírgula
  (`--group-by status,prazo:month`). Dimensões: `select`, `status`,
  `multi_select`, `checkbox`, `person`, `created_by`, `updated_by`, `number`, e
  datas com unidade `day|week|month|quarter|year`. Medidas `count`, `count_values`, `sum`, `avg`,
  `min`, `max` (`sum`/`avg` em `number`; `min`/`max` em `number` e datas), no
  máximo 8 medidas e 5.000 grupos (`aggregate_too_large`).

## Exemplos

Minhas tarefas abertas com 4 horas ou mais:

```json
{ "and": [
  { "prop": "dono", "op": "contains", "value": "$viewer.raviUserId" },
  { "not": { "prop": "status", "op": "eq", "value": { "group": "done" } } },
  { "prop": "horas", "op": "gte", "value": 4 }
] }
```

Vence nos próximos 7 dias ou já venceu e não está pronto:

```json
{ "and": [
  { "prop": "status", "op": "neq", "value": { "group": "done" } },
  { "or": [
    { "prop": "due", "op": "within", "value": { "next": "7d" } },
    { "prop": "due", "op": "before", "value": "$today" }
  ] }
] }
```

Bugs críticos sem responsável criados este mês:

```json
{ "and": [
  { "prop": "severity", "op": "in", "value": ["S1", "S2"] },
  { "prop": "assignee", "op": "is_empty" },
  { "prop": "created_time", "op": "within", "value": "this_month" }
] }
```

Linhas que eu criei:

```json
{ "prop": "created_by", "op": "eq", "value": "$viewer.raviUserId" }
```

## Limites v1

| item | limite |
|---|---|
| linhas por base | 100.000 |
| propriedades por base | 100 |
| views / gráficos por base | 50 / 50 |
| opções por propriedade | 200 |
| `multi_select` / `person` / `ref` por célula | 100 / 50 / 50 |
| texto por célula / corpo da linha | 16 KiB / 256 KiB |
| linhas por request de criação em lote | 500 |
| request body | 1 MiB |
| filtro | profundidade 8, 64 folhas, 32 filhos por nó |
| sort / group-by | 3 chaves / 2 dimensões |
