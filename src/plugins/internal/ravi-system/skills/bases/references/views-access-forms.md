# Views, acesso e formulários

Uma view é a unidade de leitura, escrita e compartilhamento. Ela junta:

- `columns`: projeção (chaves). Respostas pela view só trazem essas colunas,
  mais `rowId` e `version`. `body` pode ser projetado como coluna.
- `query`: `{ filter, sort }`. O `filter` é política obrigatória de linhas e pode
  usar colunas não projetadas. Filtro enviado na consulta é somado com AND e só
  estreita.
- `layout`: `table`, `board` (`groupBy` em `select`/`status`), `list`, `gallery`,
  `calendar` (`dateProp`), `form`, `chart` (`chartId`). Layout não muda o que
  cada pessoa pode ler.
- `access`: quem lê, quem escreve e o quê.

Gerentes da base (`manage`) leem e escrevem por qualquer view. Os demais só
recebem a forma pública: nome, layout, colunas projetadas com tipo e opções, e
as próprias capabilities. Nunca recebem `query.filter` nem `access`.

```bash
ravi bases views list pipeline --json
ravi bases views show pipeline <view-id> --json     # capabilities; policy completa só para gerentes
ravi bases views create pipeline --spec @view.json --json
ravi bases views update pipeline <view-id> --spec '{"columns":["name","stage","amount"]}' --json
ravi bases views archive pipeline <view-id> --json --execute
```

`views update` usa `--expected-version` (sem a flag o CLI lê a versão atual).
Arquivar uma view quebra gráficos, formulários e Pages que a usam.

## Princípios de acesso

`access.read` (lista) e `access.write.principals` (lista):

| princípio | quem |
|---|---|
| `{ "kind": "project_role", "minRole": "viewer" \| "developer" \| "project_admin" }` | papel efetivo no projeto (org `owner`/`admin` contam como `project_admin`) |
| `{ "kind": "user", "userId": "<uuid>" }` | um membro ativo da org |
| `{ "kind": "page_viewer", "siteId": "<uuid>" }` | quem abre aquele site Ravi Pages (do mesmo projeto) |

Um princípio de leitura pode ter `"mode": "aggregate"`: só lê dados de gráficos
dessa view, sem linhas e sem filtros próprios; grupos com menos de 5 linhas são
suprimidos.

`access.write`:

| campo | efeito |
|---|---|
| `principals` | quem pode escrever (ler não implica escrever) |
| `columns` | chaves que essas pessoas podem mudar (subconjunto de `columns`) |
| `create` / `archive` | podem criar / arquivar linhas pela view |
| `set` | valores aplicados na criação: literais, `$viewer.raviUserId`, `$viewer.email`, `$now`, `$today`; quem escreve não pode enviar essas chaves |
| `allowEscape` | `false` (padrão): a linha escrita tem de continuar dentro do filtro da view (`write_escapes_view`) |

Ordem das checagens numa escrita pela view: admissão em `write.principals` →
colunas graváveis → a linha existe, não está arquivada e casa o filtro (senão
`not_found`, nunca `forbidden`) → `expectedVersion` → pós-imagem dentro do filtro.

## "Cada vendedor só vê os próprios deals"

```json
{
  "name": "Meus deals",
  "columns": ["name", "stage", "amount", "close_date", "owner"],
  "query": {
    "filter": { "prop": "owner", "op": "contains", "value": "$viewer.raviUserId" },
    "sort": [{ "prop": "amount", "dir": "desc" }]
  },
  "layout": { "type": "board", "groupBy": "stage" },
  "access": {
    "read": [{ "kind": "project_role", "minRole": "viewer" }],
    "write": {
      "principals": [{ "kind": "project_role", "minRole": "viewer" }],
      "columns": ["name", "stage", "amount", "close_date"],
      "create": true,
      "archive": false,
      "set": { "owner": "$viewer.raviUserId" },
      "allowEscape": false
    }
  }
}
```

Cada vendedor lê e cria só os seus; `owner` é preenchido pelo Console e não
pode ser trocado por quem escreve. Para a gestão ver tudo, crie outra view com
`read: [{ "kind": "project_role", "minRole": "project_admin" }]` e sem filtro.

Para um gráfico de pipeline que todo mundo vê sem ver linhas, crie uma view
com `"read": [{ "kind": "project_role", "minRole": "viewer", "mode": "aggregate" }]`
e o gráfico em cima dela.

## Formulários

Um formulário é uma view com `layout.type: "form"`, `access.read` vazio e
`access.write.create: true`. Quem envia não lê nada da base.

```json
{
  "name": "Pedido de conteúdo",
  "columns": ["title", "channel", "due", "requester_email"],
  "layout": { "type": "form", "title": "Peça um conteúdo", "submitLabel": "Enviar",
              "successMessage": "Recebido. A equipe responde em 2 dias úteis." },
  "access": {
    "read": [],
    "write": {
      "principals": [{ "kind": "project_role", "minRole": "viewer" }],
      "columns": ["title", "channel", "due"],
      "create": true,
      "archive": false,
      "set": { "requester_email": "$viewer.email", "status": "Novo" },
      "allowEscape": false
    }
  }
}
```

- Uma view com `create` tem de cobrir toda propriedade `required` por
  `write.columns` ou `write.set`, senão o Console recusa ao salvar.
- v1 não tem link público anônimo. Formulários são para membros logados
  (`project_role`/`user`) e para quem abre uma Ravi Page do projeto
  (`page_viewer` + connector `ravi.bases.views.rows.create`, ver `pages.md`).
- Vincular uma view a um site expõe as linhas dela, como o viewer, a todo
  artefato publicado naquele host.
