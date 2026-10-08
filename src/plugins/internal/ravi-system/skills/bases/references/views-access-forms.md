# Views, acesso e formulários

Uma view é a unidade de leitura, escrita e compartilhamento. Ela junta:

- `columns`: projeção. Respostas pela view só trazem essas colunas, mais
  `rowId` e `version`. `body` pode ser projetado como coluna.
- `query`: `{ filter, sort }`. O `filter` é política obrigatória de linhas e pode
  usar colunas não projetadas. Filtro enviado na consulta soma com AND e só estreita.
- `layout`: `table`, `board` (`groupBy`), `list`, `gallery`, `calendar`
  (`dateProp`), `form`, `chart` (`chartId`). Não muda o que cada pessoa lê.
- `access`: quem lê, quem escreve e o quê.

Regra 4. A view é o contrato: 'cada um vê o seu' = filtro `$viewer`; dono e
status inicial = `write.set` (só na criação; nunca `false` em checkbox);
formulário = `read: []` + `create`. No Pages ninguém é gerente. Motivo: o
Console aplica a view no servidor, e o HTML não esconde nada de quem abre o host.

Gerentes da base (papel efetivo `developer` ou `project_admin`) leem e escrevem
por qualquer view pelo CLI. Os demais nunca recebem `query.filter` nem `access`.

```bash
ravi bases views list tarefas --json
ravi bases views show tarefas <view-id> --json     # policy completa só para gerentes
ravi bases views create tarefas --spec @minhas-tarefas.json --json
```

`views update` usa `--expected-version`. Arquivar uma view quebra os gráficos e
as páginas que a usam.

## Princípios de acesso

| princípio | quem | onde admite |
|---|---|---|
| `{ "kind": "project_role", "minRole": "viewer" \| "developer" \| "project_admin" }` | papel efetivo no projeto (org `owner`/`admin` contam como `project_admin`) | CLI e API |
| `{ "kind": "user", "userId": "<uuid>" }` | um membro ativo da org | CLI e API |
| `{ "kind": "page_viewer", "siteId": "<uuid>" }` | quem abre aquele site por login | só Ravi Pages |

Numa página só `page_viewer` admite; fora do Pages, ele não admite ninguém. Uma
view usada por tela e por agentes lista os dois. `page_viewer` não distingue
pessoas: passa todo membro da org que lê o projeto e abre qualquer rota do host.
Restrição por pessoa é trabalho do filtro com `$viewer.*`.

A view com `page_viewer` exige que o site já exista (senão: "Pages viewer
principals must name a Ravi Pages site"). A ordem:

1. ship de esqueleto: `ravi pages ship --project <p> --title "<título>" --route /<rota> --body "<p>Em construção</p>" --json` (num host que já tem página de dados, com `--uses` da união);
2. `ravi pages list --project <p> --json`: o `siteId` é o do site com `isDefault: true`;
3. `ravi bases views create ...` com esse `siteId`;
4. ship da página real com os ids da view.

`access.write`:

| campo | efeito |
|---|---|
| `principals` | quem pode escrever (ler não implica escrever) |
| `columns` | chaves que essas pessoas podem mudar |
| `create` / `archive` | podem criar / arquivar linhas pela view |
| `set` | valores aplicados na criação: literais, `$viewer.raviUserId`, `$viewer.email`, `$now`, `$today` |
| `allowEscape` | `false` (padrão): a linha escrita tem de continuar no filtro (`write_escapes_view`) |

Linha fora do filtro da view responde `not_found`, nunca `forbidden`.

## Cada um vê o seu

Tarefas de um escritório: cada pessoa vê, move e cria só as próprias.

```json
{ "name": "Minhas tarefas", "columns": ["titulo", "status", "prazo", "dono", "supervisao"],
  "query": { "filter": { "prop": "dono", "op": "contains", "value": "$viewer.raviUserId" },
             "sort": [{ "prop": "prazo", "dir": "asc" }] },
  "layout": { "type": "board", "groupBy": "status" },
  "access": { "read": [{ "kind": "page_viewer", "siteId": "<site-id>" }],
    "write": { "principals": [{ "kind": "page_viewer", "siteId": "<site-id>" }],
      "columns": ["titulo", "status", "prazo"], "create": true, "archive": false,
      "set": { "dono": "$viewer.raviUserId" }, "allowEscape": false } } }
```

Na página (board com `views.describe`, `views.query`, `views.rows.update` e
`views.rows.create`), cada um lê e cria só as suas; `dono` é preenchido no
servidor e ninguém consegue trocá-lo pela tela.

## Dono + supervisão

No Pages não dá para limitar por papel: uma view `page_viewer` sem filtro
mostra tudo a todos que abrem o host. Quem precisa ver as linhas dos outros
entra na linha, numa coluna `person` de supervisão, e o filtro vira `or`. A
mesma view serve a todos: a supervisora vê as dela e as que supervisiona.

```json
{ "or": [
  { "prop": "dono", "op": "contains", "value": "$viewer.raviUserId" },
  { "prop": "supervisao", "op": "contains", "value": "$viewer.raviUserId" } ] }
```

- Quem preenche `supervisao` é o agente, pelo CLI, com ids de membro (abaixo) e a regra de quem opera o Ravi ("a Rita supervisiona a área Fiscal"). Deixe `supervisao` fora de `write.columns`, senão qualquer um vira supervisor.
- Um projeto separado não isola nada de owner, admin ou developer da org: eles leem e escrevem qualquer base pelo CLI. Ele só separa quem abre cada host.
- A opção agregada continua: leitura `page_viewer` com `"mode": "aggregate"`, sem filtro, e um gráfico em cima (`ravi.bases.charts.data`). Só números, e grupo com menos de 5 linhas some: num time pequeno, mostre linhas pelo `or`.
- Visão completa só para agentes no CLI: view com `read: [{ "kind": "project_role", "minRole": "project_admin" }]`, sem filtro. Nunca uma view "da gestão" sem filtro no host, que todos leriam.

## Aprovador

Aprovação dada na tela por um membro: coluna `aprovador` (person), coluna de
decisão editável (`decisao`, select Aprovada/Devolvida) e uma view "Para eu
aprovar" (`table`, com `page_viewer` em `read` e em `write.principals`). O
trecho que muda:

```json
{ "query": { "filter": { "and": [
    { "prop": "aprovador", "op": "contains", "value": "$viewer.raviUserId" },
    { "prop": "status", "op": "eq", "value": "Entregue" },
    { "prop": "decisao", "op": "is_empty" } ] } },
  "access": { "write": { "columns": ["decisao"], "create": false, "archive": false, "allowEscape": true } } }
```

- `allowEscape: true` porque decidir tira a linha do filtro (sem ele, `write_escapes_view`). `decisao` fica fora de `write.columns` de toda outra view.
- Antes de agir, confira em `ravi bases rows history tarefas <row> --json` que a versão que gravou `decisao` tem `actorType: user`, `surface: page` e `actorId` igual ao `aprovador` da linha. Motivo: o trigger drena estado, e quem gravasse `decisao` por outro caminho injetaria uma aprovação.

## Ids de membro

Coluna `person` pede user ids da org, não nomes nem e-mails.

- `ravi bases show <base> --json` devolve `base.members[]` (`id`, `displayName`) dos membros ativos da org, para quem gerencia a base. É inferido do código e não traz e-mail: com nomes repetidos, confirme com a pessoa. O mapa `users` de `rows history` também dá nomes.
- Mais seguro: a pessoa se identifica num formulário de uma base `pessoas` com `write.set: { "pessoa": "$viewer.raviUserId", "email": "$viewer.email" }`, e o agente lê os ids dali.
- Guarde ids que dão poder (aprovador, supervisão) onde agente de frente não edita.

## Presets

- `write.set` vale só na criação: não dá para "assumir" uma linha existente com preset. Trocar o dono depois é `rows update` pelo CLI.
- Chave com preset sai das colunas graváveis: quem escreve não pode enviá-la.
- Nunca `false` em checkbox: vira vazio e o Console recusa a view inteira ("Presets cannot be empty."). O checkbox nasce desmarcado, e `{"prop":"processado","op":"eq","value":false}` casa com a linha nova.
- View com `create` cobre toda propriedade `required` por `write.columns` ou `write.set`, senão `validation_failed`.

## Formulários

Formulário é uma view com `layout.type: "form"`, `access.read` vazio e
`access.write.create: true`, mais uma página que monta os campos com
`ravi.bases.views.describe` e envia com `ravi.bases.views.rows.create`
(esqueleto: `ravi skills show pages --file references/esqueletos/formulario.html.txt`).
Quem envia não lê nada da base.

```json
{ "name": "Pedido de conteúdo", "columns": ["title", "channel", "due", "requester_email"],
  "layout": { "type": "form", "title": "Peça um conteúdo", "submitLabel": "Enviar",
              "successMessage": "Recebido. A equipe responde em 2 dias úteis." },
  "access": { "read": [],
    "write": { "principals": [{ "kind": "page_viewer", "siteId": "<site-id>" }],
      "columns": ["title", "channel", "due"], "create": true, "archive": false,
      "set": { "requester_email": "$viewer.email", "status": "Novo" }, "allowEscape": false } } }
```

- Ship com `--uses ravi.bases.views.describe,ravi.bases.views.rows.create`, somado aos ids das outras páginas de dados do host.
- Não há formulário público: quem envia é membro logado, em rota `private` ou `protected_link` (senha não serve). Gente de fora manda os dados pela conversa.
- Vincular uma view a um site a expõe a todo o host, sem aviso do Console. Diga à pessoa: "o host `<host>` (todas as rotas) passa a ler a view `<nome>` [e a escrever as colunas X]".
