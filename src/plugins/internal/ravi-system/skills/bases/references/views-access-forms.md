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

Gerentes da base (`manage`: papel efetivo `developer` ou `project_admin`) leem
e escrevem por qualquer view pelo CLI e pela API. Numa Ravi Page ninguém é
gerente. Os demais só recebem a forma pública: nome, layout, colunas projetadas
com tipo e opções, e as próprias capabilities. Nunca recebem `query.filter` nem
`access`.

Não existe tela de Bases no Console. A view é o contrato que uma Ravi Page
gerada usa para ler e escrever (`pages.md`).

```bash
ravi bases views list pipeline --json
ravi bases views show pipeline <view-id> --json     # capabilities; policy completa só para gerentes
ravi bases views create pipeline --spec @view.json --json
ravi bases views update pipeline <view-id> --spec '{"columns":["name","stage","amount"]}' --json
ravi bases views archive pipeline <view-id> --json --execute
```

`views update` usa `--expected-version` (sem a flag o CLI lê a versão atual).
Arquivar uma view quebra os gráficos e as Pages que a usam.

## Princípios de acesso

`access.read` (lista) e `access.write.principals` (lista):

| princípio | quem | onde admite |
|---|---|---|
| `{ "kind": "project_role", "minRole": "viewer" \| "developer" \| "project_admin" }` | papel efetivo no projeto (org `owner`/`admin` contam como `project_admin`) | CLI e API |
| `{ "kind": "user", "userId": "<uuid>" }` | um membro ativo da org | CLI e API |
| `{ "kind": "page_viewer", "siteId": "<uuid>" }` | quem abre aquele site Ravi Pages por login (site do mesmo projeto) | só Ravi Pages |

Numa Ravi Page só `page_viewer` admite: papel no projeto e `user` não contam
lá. Fora do Pages, `page_viewer` não admite ninguém. Uma view usada por uma
tela e por agents no CLI lista os dois princípios. `page_viewer` não distingue
pessoas: passa todo membro da org que lê o projeto e abre qualquer rota do
host. Restrição por pessoa numa tela é trabalho do filtro com `$viewer.*`.
O `siteId` sai de `ravi pages list --project <p> --json` (o site com
`isDefault: true`).

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
    "read": [{ "kind": "page_viewer", "siteId": "<site-id>" }],
    "write": {
      "principals": [{ "kind": "page_viewer", "siteId": "<site-id>" }],
      "columns": ["name", "stage", "amount", "close_date"],
      "create": true,
      "archive": false,
      "set": { "owner": "$viewer.raviUserId" },
      "allowEscape": false
    }
  }
}
```

Na página (um board com `views.describe`, `views.query`, `views.rows.update`
e `views.rows.create`), cada vendedor lê e cria só os seus; `owner` é
preenchido no servidor e não pode ser trocado por quem escreve.

Para a gestão ver tudo: no Pages não dá para limitar por papel, então uma view
`page_viewer` sem filtro mostraria tudo a todos que abrem o site. A visão
completa fica com agents no CLI (outra view com
`read: [{ "kind": "project_role", "minRole": "project_admin" }]` e sem filtro)
ou vira número agregado na tela.

Para um gráfico de pipeline que todo mundo no site vê sem ver linhas, crie uma
view com `"read": [{ "kind": "page_viewer", "siteId": "<site-id>", "mode": "aggregate" }]`
e o gráfico em cima dela; a página chama `ravi.bases.charts.data`.

## Formulários

Um formulário é uma view com `layout.type: "form"`, `access.read` vazio e
`access.write.create: true`, mais uma Ravi Page gerada que monta os campos com
`ravi.bases.views.describe` e envia com `ravi.bases.views.rows.create`
(`pages.md`, seção Formulário). Quem envia não lê nada da base.

```json
{
  "name": "Pedido de conteúdo",
  "columns": ["title", "channel", "due", "requester_email"],
  "layout": { "type": "form", "title": "Peça um conteúdo", "submitLabel": "Enviar",
              "successMessage": "Recebido. A equipe responde em 2 dias úteis." },
  "access": {
    "read": [],
    "write": {
      "principals": [{ "kind": "page_viewer", "siteId": "<site-id>" }],
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
  `write.columns` ou `write.set`, senão `views create`/`views update` dá
  `validation_failed` em `access.write.create`.
- A página lê `layout.title`, `description`, `submitLabel` e `successMessage`
  do `views.describe` e mostra só `capabilities.writeColumns`; chaves de
  `write.set` não aparecem e não podem ser enviadas.
- Ship com `--uses ravi.bases.views.describe,ravi.bases.views.rows.create`.
- v1 não tem link público anônimo. Quem envia entra no Pages por login e é
  membro da org com leitura do projeto. Rota com senha não serve.
- Vincular uma view a um site expõe as linhas dela, como o viewer, a todo
  artefato publicado naquele host. O Console não avisa ninguém: ao conceder
  `page_viewer`, diga à pessoa "o host `<host>` (todas as rotas) passa a ler
  a view `<nome>` [e a escrever as colunas X], como quem abre o site".
