# Bases em Ravi Pages

Pages leem e escrevem bases pelo dialeto de connectors já existente do host
Pages. Não há bridge separado. A página chama `POST /_ravi/connectors/exec`
same-origin; o Console autentica a sessão de quem vê, confere o allowlist da
release e aplica as regras da view.

## Connectors

| id | classe | input | output |
|---|---|---|---|
| `ravi.bases.views.describe` | leitura | `{ viewId }` | forma pública da view (colunas, layout, capabilities) |
| `ravi.bases.views.query` | leitura | `{ viewId, filter?, sort?, limit?, cursor? }` | `{ columns, rows, nextCursor, users }` |
| `ravi.bases.views.rows.create` | escrita | `{ viewId, values, body?, idempotencyKey }` | `{ rowId, version }` |
| `ravi.bases.views.rows.update` | escrita | `{ viewId, rowId, values, body?, expectedVersion, idempotencyKey }` | a linha pela view |
| `ravi.bases.charts.data` | leitura | `{ chartId }` | dados agregados do gráfico |

Para uma chamada passar, tudo isto tem de valer:

1. A release declara o id em `uses` (estes ids não entram no allowlist implícito).
2. Quem vê tem sessão `human_viewer` (login por código). Sessões de captura,
   sem escopo ou por senha são recusadas.
3. A view é de uma base do mesmo projeto e organização do site.
4. A view concede `{ "kind": "page_viewer", "siteId": "<site>" }` em
   `access.read` (leitura) ou `access.write.principals` (escrita).
5. Escritas exigem `Origin` igual ao host da página.

`$viewer.*` na view resolve para o usuário da sessão e a organização do site.
Vincular uma view a um site expõe as linhas dela, como o viewer, a todo artefato
publicado naquele host.

## Passo a passo

1. Pegue o `siteId` (campo `id` do site) com `ravi pages list --project <p> --json`.
2. Crie (ou atualize) a view com o princípio `page_viewer` desse site:

```json
{ "name": "Pedidos (página)",
  "columns": ["title", "status", "due"],
  "query": { "filter": { "prop": "requester_email", "op": "eq", "value": "$viewer.email" },
             "sort": [{ "prop": "due", "dir": "asc" }] },
  "access": {
    "read": [{ "kind": "page_viewer", "siteId": "<site-id>" }],
    "write": { "principals": [{ "kind": "page_viewer", "siteId": "<site-id>" }],
               "columns": ["title", "due"], "create": true, "archive": false,
               "set": { "requester_email": "$viewer.email" }, "allowEscape": false } } }
```

3. Publique a página declarando só os connectors que ela usa:

```bash
ravi pages ship --project <p> --title "Pedidos" --route /pedidos --dir ./site \
  --uses ravi.bases.views.describe,ravi.bases.views.query,ravi.bases.views.rows.create --json
```

4. No JS da página:

```js
async function exec(id, input) {
  const res = await fetch("/_ravi/connectors/exec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, input }),
  });
  const body = await res.json();
  if (!body.ok) throw body; // connector_session_required => mandar para o login do Pages
  return body.output;
}

const VIEW = "<view-id>";
const view = await exec("ravi.bases.views.describe", { viewId: VIEW });
const page = await exec("ravi.bases.views.query", { viewId: VIEW, limit: 50 });
// page.rows[i].values[key]; selects vêm como id de opção: use view.columns[].config.options

await exec("ravi.bases.views.rows.create", {
  viewId: VIEW,
  values: { title: "Novo pedido", due: "2026-11-01" },
  idempotencyKey: crypto.randomUUID(),
});
```

- Gere um `idempotencyKey` por envio do formulário e reutilize-o em retries.
- Em `rows.update`, mande o `expectedVersion` da linha lida; em conflito, releia.
- Não chame `console.ravi.bot` do JS da página e não peça ao viewer para
  "conectar o Ravi". A identidade é a sessão do Pages.
- `output` já vem projetado; não espere campos do envelope do CLI.
