# Página de dados: Ravi Pages sobre Bases

Bases não tem tela no Console. Toda UI sobre uma base (tabela, board,
formulário, dashboard, gráfico, portal) é uma Ravi Page que você gera e
publica. A página fala com a base só pelos connectors `ravi.bases.*`, sempre
através de uma view. A view é o contrato de acesso: projeção (colunas), filtro
obrigatório e princípios. O Console aplica a view em cada chamada; a página só
desenha o que volta.

Regras 1 a 3 da skill solucoes, detalhadas em "Ship" e "Quem passa":

1. Página de dados só para membro logado da org. Gente de fora entra por canal
   e recebe mensagem ou snapshot. Na dúvida, é de fora. (Sem sessão de membro,
   nada responde.)
2. `--uses` é do host inteiro e o último ship manda: todo ship nesse host leva
   a união dos ids de todas as páginas de dados. `pages publish` e
   `artifacts publish` apagam a lista. (O Console lê o `uses` da release ativa.)
3. Página de dados mora em rota `private` (padrão do ship) ou `protected_link`;
   nunca `public` nem `password`. (Só nelas o Pages pede login.)

## Fluxo

0. **Host.** A view com `page_viewer` exige um site que já existe: ship de
   esqueleto → `ravi pages list` (`siteId`) → view → ship da página real.
1. **View.** Desenhe a view da tela com o princípio `page_viewer` do site.
   Ao conceder `page_viewer`, diga à pessoa: "o host `<host>` (todas as rotas)
   passa a ler a view `<nome>` [e a escrever as colunas X], como quem abre o
   site".
2. **Gráficos.** Se a tela tem gráficos, crie-os sobre uma view (skill bases,
   `charts.md`).
3. **Página.** Parta de um esqueleto (`esqueletos/board.html.txt` ou
   `formulario.html.txt`, mais `_client.js.txt` como `client.js`). Ids de
   view e gráfico entram como constantes.
   Dados nunca entram no HTML: a página busca tudo na hora, como quem vê.
4. **Ship.** `ravi pages ship ... --uses <ids>` com os `ravi.bases.*` que a
   página chama, mais os das outras páginas de dados do mesmo host (o
   allowlist é do host; veja "Ship").
5. **Verifique** e mande a URL para a pessoa abrir, junto com o aviso do
   passo 1.

### Site e view

O `siteId` do princípio é o `id` do host default do projeto. Sem site, a
view é recusada ("Pages viewer principals must name a Ravi Pages site"):

```bash
ravi pages ship --project <p> --title "Pautas" --route /pautas --body "<p>Em construção</p>" --json   # só se não há host
ravi pages list --project <p> --json      # sites[]: o id do que tem isDefault: true
```

Num host que já tem páginas de dados, o ship do esqueleto também leva o
`--uses` com a união: sem ele, as outras páginas param (veja "Ship").

Uma view por tela (ou por conjunto de permissões):

| campo | decida |
|---|---|
| `columns` | O que a tela mostra ou edita. Tudo que está aqui é legível por qualquer pessoa que abra o site, mesmo que a página esconda. `body` só se a tela mostra o corpo. |
| `query.filter` | Quais linhas cada pessoa vê. `$viewer.raviUserId` e `$viewer.email` resolvem para quem está vendo a página. |
| `query.sort` | Ordem padrão. |
| `access.read` | `[{ "kind": "page_viewer", "siteId": "<site>" }]` para telas que listam; `[]` para formulário puro; `"mode": "aggregate"` para dashboard sem linhas. |
| `access.write` | `principals` com o mesmo `page_viewer`; `columns` que a tela edita; `create` / `archive`; `set` para dono, e-mail e status inicial. |
| `layout` | `table`, `board` (`groupBy`), `list`, `gallery` (`coverProp`), `calendar` (`dateProp`), `form`, `chart` (`chartId`). |

```bash
ravi bases views create <base> --spec @view.json --json    # guarde o id
```

| tela | layout | `--uses` (sem o prefixo `ravi.bases.`) |
|---|---|---|
| tabela ou lista só leitura | `table` / `list` | `views.describe`, `views.query` |
| tabela editável | `table` | `views.describe`, `views.query`, `views.rows.update` (+ `views.rows.get`, `views.rows.archive`) |
| kanban | `board` | `views.describe`, `views.query`, `views.rows.update` |
| galeria | `gallery` | `views.describe`, `views.query` (+ `views.rows.get`) |
| calendário | `calendar` | `views.describe`, `views.query` (+ `views.rows.update` para arrastar) |
| formulário | `form` | `views.describe`, `views.rows.create` |
| portal da equipe ("minhas solicitações" + nova) | `table` / `list` | `views.describe`, `views.query`, `views.rows.create`, `views.rows.get` |
| dashboard | `chart` ou qualquer | `charts.data` (+ `views.describe` se ler `layout.chartId`) |

No `--uses`, sempre o id completo: `ravi.bases.views.describe`, não
`views.describe`. Um índice de rotas usa `ravi.pages.published.list`, que
também entra na união.

### Ship

```bash
ravi pages ship --project <p> --title "Pautas" --route /pautas --dir ./pautas \
  --uses ravi.bases.views.describe,ravi.bases.views.query,ravi.bases.views.rows.update --json
```

- Deixe a rota `private` (padrão do ship) ou `--visibility protected_link`.
  Nas duas o Pages pede login antes de servir o HTML, e é essa sessão que os
  connectors aceitam. Em rota `public`, só passa o membro que já entrou no
  Console, por um login silencioso sem garantia; o resto recebe
  `connector_session_required`. Rota com senha não serve: a sessão de senha
  não é sessão do Pages, e "Entrar de novo" só mostra a senha de novo.
  Por isso o ship recusa, sem publicar, `ravi.bases.*` no `--uses` em rota
  `public`. `--members-best-effort` passa por cima de propósito, só quando
  todo leitor é membro já logado. Página pública estática vai noutro projeto
  (`ravi pages ship --project <outro>`), nunca no host das páginas de dados.
- `ravi.bases.*` nunca entra no allowlist implícito. Id fora do `--uses` dá
  `connector_not_allowlisted`. A página passou a chamar outra action? Ship de
  novo com o id.
- Hoje o allowlist é do host, não da rota: o Console lê o `uses` da release
  ativa do host, que é a do último ship em qualquer rota. Num host com várias
  páginas de dados, declare em todo ship nesse host a união dos ids que essas
  páginas chamam, e não faça ship sem `--uses` ali. Isso não amplia acesso: a
  view já concede ao site inteiro.
- Sem `uses` declarado, o host libera só as leituras `ravi.projects.list`,
  `ravi.pages.sites.list` e `ravi.pages.published.list`. Declarar `--uses`
  tira as três: ponha na união as que alguma página chama. Ship sem `--uses`
  num host de dados volta a esse conjunto e derruba as páginas de dados.
- `pages publish` e `artifacts publish` não mandam `--uses` e apagam a lista:
  num host de dados, só `pages ship`.
- `CONFLICT` (409, "Read unread Ravi Pages comments before publishing."): há
  comentário não lido de outra pessoa nessa rota, e o CLI ainda não lê comentários. Peça à pessoa logada neste Ravi
  (o CLI publica em nome dela) que leia na barra do operador da página, ou
  publique numa rota nova. Mudar a visibilidade não passa por esse freio.
- Na sessão, o ship tem 30 s de timeout no cliente e o upload pode terminar
  depois: confira `ravi pages published` antes de repetir.

### Verificação

```bash
grep -o 'ravi\.bases\.[a-z.]*' ./pautas/index.html | sort -u  # cliente inline: tem de bater com o --uses
ravi pages published --project <p> --json                    # rota, visibilidade e URL
ravi bases views show <base> <view-id> --json                # valid: true; page_viewer com o site certo
ravi bases views query <base> <view-id> --limit 5 --json     # só as suas linhas, se houver $viewer
```

- Com os esqueletos, os ids moram em `client.js`: confira quais helpers a
  página chama (`update` = `rows.update`, `create` = `rows.create`).
- `views query` numa view com `$viewer` mostra só as linhas de quem roda o
  comando. Não confere o que outra pessoa vê.
- O CLI não reproduz a sessão de quem vê (no Pages ninguém é gerente). Mande a
  URL para a pessoa abrir e confirme com ela. Se a página mostrar um erro, a
  tabela de erros abaixo diz o que corrigir.

## Quem passa

Uma chamada só roda quando tudo isto vale:

1. O id está no `uses` da release.
2. Quem vê entrou no Pages por login (sessão `human_viewer`). Sessões de
   captura ou sem escopo recebem `connector_permission_required`. Quem só tem
   sessão de senha (ou nenhuma, em rota `public`) recebe
   `401 connector_session_required`, e entrar de novo não resolve: use rota
   `private` ou `protected_link`, sem senha.
3. Quem vê é membro ativo da organização e lê o projeto do site (senão
   `connector_unauthorized`), e a org tem Bases liberado para o papel dele
   (senão `connector_permission_required`).
4. A view (ou a view do gráfico) é de uma base do projeto do site e concede
   `page_viewer` deste site: `access.read` para ler; `access.write.principals`
   para escrever, mais `create` ou `archive` para criar ou arquivar.
5. Escritas (`rows.create`, `rows.update`, `rows.archive`) chegam com `Origin`
   igual ao host. O `fetch` same-origin do navegador já manda.

No Pages ninguém é gerente: mesmo o admin do projeto só tem o que o
`page_viewer` concede. E `page_viewer` não distingue pessoas nem papéis: passa
todo mundo que consegue abrir o site, em qualquer rota do host. "Cada um vê o
seu" é trabalho do filtro com `$viewer.*`. Gente de fora da organização não
tem caminho em v1.

## Connectors

Todos revision 1, input estrito (chave desconhecida dá `payload_invalid`),
`viewId`, `rowId` e `chartId` em UUID.

| id | classe | input | output |
|---|---|---|---|
| `ravi.bases.views.describe` | leitura | `{ viewId }` | `{ id, baseId, name, description, layout, version, columns, capabilities, valid }` |
| `ravi.bases.views.query` | leitura | `{ viewId, filter?, sort?, limit?, cursor? }` | `{ columns, rows: Row[], nextCursor, users }` |
| `ravi.bases.views.rows.get` | leitura | `{ viewId, rowId }` | `{ rowId, version, values, body?, users }` |
| `ravi.bases.views.rows.create` | escrita | `{ viewId, values, body?, idempotencyKey }` | `{ rowId, version }` |
| `ravi.bases.views.rows.update` | escrita | `{ viewId, rowId, values, body?, expectedVersion, idempotencyKey }` | `Row` |
| `ravi.bases.views.rows.archive` | escrita | `{ viewId, rowId, expectedVersion }` | `{ rowId, version }` |
| `ravi.bases.charts.data` | leitura | `{ chartId }` | `{ chart, groups, fields, suppressedGroups, users }` |

- `Row` = `{ rowId, version, values, body? }`. `values` traz só as colunas
  projetadas, por chave. Célula vazia não vem, exceto `checkbox` (sempre
  `true`/`false`). `body` só vem em `rows.get` e `rows.update`, e só quando a
  view projeta `body`; `query` nunca traz o corpo.
- `users` = `{ [userId]: { id, displayName, avatarUrl } }` dos ids em
  `person`, `created_by` e `updated_by` das linhas devolvidas (`displayName`
  e `avatarUrl` podem ser `null`). `rows.update` e o `current` de conflito não
  trazem `users`: mantenha um mapa acumulado.
- Quem a view só deixa escrever (sem `capabilities.read`, ex.: formulário)
  recebe de `rows.update` e no `current` só `{ rowId, version, values: {} }`.
- `describe`:
  - `columns[]` = `{ key, name, type, config, required }` na ordem da view.
    `type` é um tipo de propriedade, uma coluna de sistema (`created_time`,
    `created_by`, `updated_time`, `updated_by`) ou `body`. `config` traz
    `options` (`{ id, name, color, group?, archived? }`), `format`, `currency`,
    `precision` e `includeTime`.
  - `capabilities` = `{ read, aggregateOnly, writeColumns, create, archive }`
    de quem está vendo. `writeColumns` nunca tem colunas de sistema nem chaves
    de `write.set`.
  - `layout` = `{ type, ... }` com colunas por chave (`groupBy`, `dateProp`,
    `coverProp`), `chartId`, ou os textos do formulário.
  - `valid: false`: a view quebrou (propriedade apagada); leituras e escritas
    dão `view_invalid`.
  - Responde para quem a view admite de qualquer jeito (linhas, agregado ou
    escrita), então formulários e dashboards também chamam.
- `query`: `limit` 1-500 (padrão 100). `sort` até 3 `{ prop, dir? }`; substitui
  o sort da view nessa consulta. `filter` é o Query AST (bases, `query-ast.md`),
  somado com AND ao filtro da view, só com colunas projetadas (não `body`).
  Devolva `nextCursor` como `cursor` sem mudar `filter` nem `sort`; o cursor
  vale 15 minutos.
- `rows.get`: exige leitura de linhas. Linha fora do filtro, arquivada ou
  inexistente dão o mesmo `404 not_found`.
- `rows.create` e `rows.update`: só `writeColumns` (e `body` se `"body"`
  estiver nelas). `update` muda só as chaves enviadas e exige o `version`
  lido; se nada mudou, volta a mesma versão. `idempotencyKey`: 8-128
  caracteres de letras, dígitos, `.`, `_`, `:` e `-` (`crypto.randomUUID()`
  serve).
- `rows.archive`: exige `capabilities.archive`. Não tem chave de
  idempotência: repetir depois de um arquivamento que deu certo dá
  `404 not_found`; trate como feito. Restaurar não é action do Pages
  (`ravi bases rows restore`).
- Nenhuma escrita aceita `lastWriteWins`.

Os outros quatro dos 11 ids: `ravi.projects.list` (`{ limit? }`),
`ravi.pages.sites.list` e `ravi.pages.published.list`
(`{ limit?, projectRef? }`) e `ravi.identity.assertion` (`{ aud }` →
`{ token }`; skill pages). Não há action para listar views, ler histórico,
chamar agente, mandar mensagem nem subir arquivo.

## Cliente

A página só chama `POST /_ravi/connectors/exec` (caminho absoluto, no próprio
host) com `{ id, input }`. Sucesso: HTTP 200 com
`{ ok: true, id, revision, output }`. Erro: status HTTP com `{ error }`; só
nas `ravi.bases.*`, `validation_failed` traz `fieldErrors` e
`version_conflict` traz `current` (a linha atual pela view, sem `users`).
Nenhum outro campo vem no erro. O header `x-request-id` identifica a chamada
para suporte.

O código mora numa cópia só, `esqueletos/_client.js.txt` (`exec`,
`describe`, `query`, `update`, `create`, `poll`, `showError`, `el`).
Publique como `client.js` ao lado do `index.html` (`ship --dir`) e carregue
com `<script src="client.js"></script>`, relativo, antes do script da página
(a rota vira `/<rota>/`; inferido do Worker). Com `--html`, cole o conteúdo
num `<script>`. As mensagens saem num `<p id="banner" hidden></p>`.

Não há push: releia a view com `poll(fn, ms)`, piso de 30 s. O Console aceita
120 chamadas por minuto por viewer por site; acima disso,
`connector_rate_limited`, e o cliente espera e repete.

### Erros

| `error` | status | quando | a página |
|---|---|---|---|
| `connector_session_required` | 401 | sem sessão do Pages: sessão vencida, rota `public` sem login, ou rota com senha (sessão de senha não conta) | link "Entrar de novo" (recarrega): em rota `private` ou `protected_link`, o Pages leva ao login e volta. Em rota com senha ou `public` isso não resolve: publique em rota `private` sem senha |
| `connector_unauthorized` | 401 | sessão inválida ou expirada, ou `Origin` diferente do host | o mesmo |
| `connector_permission_required` | 403 | sessão do Pages que não é de login (captura, sem escopo), ou Bases não liberado para a org ou o papel | "sem permissão"; não repita |
| `connector_not_allowlisted` | 403 | id fora do `uses` da release | erro de publish: ship de novo com o id na união do host |
| `connector_capability_unsupported` | 400 | id desconhecido ou revision diferente da publicada | erro de publish: ship de novo |
| `payload_invalid` | 400 | input fora do schema: chave a mais, UUID inválido, `limit` fora de 1-500, chave de idempotência inválida | bug da página; mensagem genérica |
| `validation_failed` | 400 | valor inválido; `fieldErrors` por chave | cada mensagem sob o campo da chave; chaves sem campo (`values`, `body`, `expectedVersion`, `idempotencyKey`) no topo do formulário |
| `unknown_property`, `invalid_filter` | 400 | filtro ou sort com coluna fora da view, operador ou valor errado | bug da página; volte ao filtro e sort padrão |
| `cursor_invalid` | 400 | cursor vencido (15 min) ou consulta mudou | recomece sem `cursor` |
| `not_found` | 404 | a view não admite este site, ou a view/gráfico não existe ou foi arquivado; linha fora do filtro, arquivada ou inexistente | no describe: "indisponível"; numa linha: tire da tela e recarregue a lista |
| `base_forbidden` | 403 | admitido sem a permissão: `query` numa view sem leitura, create sem `create`, archive sem `archive` | consulte `capabilities` antes e esconda a ação |
| `version_conflict` | 409 | `expectedVersion` velho; `current` traz a linha atual (só `rowId` e `version` para quem não lê linhas) | mostre `current` e ofereça "reaplicar minha mudança" (mesmos `values`, `expectedVersion: current.version`, chave nova) ou "ficar com a atual" |
| `write_escapes_view` | 409 | a mudança tiraria a linha da view | desfaça na tela e explique |
| `view_invalid` | 409 | view ou gráfico quebrado (propriedade apagada, preset com pessoa que saiu da org) | "em manutenção"; um gerente corrige pelo CLI |
| `idempotency_conflict` | 409 | mesma chave com input diferente | bug: chave nova para cada input novo |
| `base_archived` | 409 | base só leitura | desligue as escritas |
| `limit_exceeded` | 409 | limite da base (ex.: 100.000 linhas) | mensagem |
| `query_timeout` | 503 | consulta lenta | "tente de novo"; filtre mais |
| `connector_rate_limited` | 429 | mais de 120 chamadas por minuto deste viewer neste site | espere e tente de novo (o cliente faz); polling só com piso de 30 s |
| `connector_unavailable` | 503 (404 se o site não está ativo) | Console fora ou resposta inválida | mensagem genérica com o `x-request-id` |

`network_error` não vem do servidor: é o nome que o cliente (`_client.js.txt`)
dá quando o `fetch` falha. Corpo que não é JSON vira `connector_unavailable`.
As mensagens de `fieldErrors` vêm do Console, em inglês.

Idempotência: uma chave por escrita lógica. Repita a mesma chave só para
reenviar exatamente o mesmo input (timeout, rede). Input mudou (inclusive o
`expectedVersion` depois de um conflito): chave nova. O replay de um
`rows.update` cuja linha saiu da view volta com `values: {}`; releia.

## Valores

| tipo | em `values` | mostrar |
|---|---|---|
| `text` | string | texto; `white-space: pre-wrap` se for longo |
| `number` | number | `Intl.NumberFormat` por `config.format`: `plain`, `percent` (0.25 = 25%), `currency` com `config.currency`; `config.precision` = casas |
| `checkbox` | `true`/`false`, sempre presente | ✓ ou vazio |
| `date` | `{ start, end }`, `end` pode ser `null` | sem `config.includeTime`: `YYYY-MM-DD`, dia de calendário; não use `new Date("YYYY-MM-DD")` (vira meia-noite UTC e pode mostrar o dia anterior). Com `includeTime`: instante ISO UTC (`…Z`), mostre no fuso de quem vê |
| `select`, `status` | id da opção | `name` e `color` em `config.options`; `status` tem `group` (`todo`, `in_progress`, `done`). Opção `archived` ainda aparece em valores antigos |
| `multi_select` | ids | um chip por id |
| `person` | user ids | `users[id].displayName`, `avatarUrl` |
| `url` | string `http(s)` | link, depois de conferir o protocolo |
| `email` | string minúscula | `mailto:` |
| `phone` | string | `tel:` |
| `ref` | `[{ type, id }]` | texto `type:id`; o Console não resolve refs |
| `created_time`, `updated_time` | instante ISO | data e hora locais |
| `created_by`, `updated_by` | user id, ou `null` em escrita de sistema | `users` |
| `body` | markdown ou `null` | texto com `white-space: pre-wrap`, nunca como HTML |

Cores de opção (`gray`, `brown`, `orange`, `yellow`, `green`, `blue`,
`purple`, `pink`, `red`): mapeie por um dicionário fixo de cores CSS.

Para escrever:

| tipo | envie em `values` (`null` limpa qualquer tipo; `""` limpa todos menos `ref`) |
|---|---|
| `text`, `url`, `email`, `phone` | string |
| `number` | number |
| `checkbox` | `true`/`false` |
| `date` | `"YYYY-MM-DD"`; com `includeTime`, instante ISO com offset (`new Date(valorDoInput).toISOString()`); intervalo `{ start, end }`. Uma data só grava `end: null`: para mudar o início de um intervalo, envie `{ start, end }` com o `end` atual |
| `select`, `status` | id da opção (o nome também é aceito); opção arquivada é recusada, exceto reenviar a que a linha já tem |
| `multi_select` | array de ids, sempre o array inteiro (o que não vier sai). Opção arquivada que a linha já tem continua aceita; acrescentar uma arquivada é recusado |
| `person` | array de user ids de membros ativos |
| `ref` | array de `{ type, id }`; limpe com `null` ou `[]` (`""` dá `validation_failed`) |
| corpo | campo `body` fora de `values`, só com `"body"` em `writeColumns` |

- Pessoa: o Pages não recebe a lista de membros da org. Para "dono = quem
  criou", use `write.set` com `$viewer.raviUserId`. Para atribuir, ofereça só
  quem já aparece em `users`. O agente acha ids de membro em
  `ravi bases show <base> --json` (`members[]`, inferido do código).
- `required` vale na criação (toda propriedade obrigatória termina com valor,
  por campo ou por `write.set`) e ao limpar o campo num update.

## Segurança

- Valores de linha são escritos por quem vê: renderize com `textContent`,
  `createTextNode` ou `append(string)`. Nunca `innerHTML`, `outerHTML`,
  `insertAdjacentHTML` ou `document.write` com valores. `body` é markdown cru:
  mostre como texto.
- Links e imagens só depois de conferir o protocolo (`http:`, `https:`,
  `mailto:`, `tel:`); links com `rel="noopener noreferrer"`.
- Nenhum token no HTML ou no JS. A sessão é um cookie `HttpOnly` que a página
  não lê. Não chame `console.ravi.bot`, `/api/...` nem `link.ravi.so` da
  página, e não peça para "conectar o Ravi".
- Não embuta dados no HTML na hora do ship: o HTML é o mesmo para todos e
  ignora o filtro com `$viewer`. Busque na hora, como quem vê.
- A view é a barreira. Quem abre o site pode chamar pelo devtools qualquer
  action do `uses` em qualquer view que conceda o site. Projete só o que todos
  ali podem ver e ponha em `write.columns` só o que todos ali podem mudar.
- Não registre valores no `console.log` nem em query string.

## Checklist

- A view concede `page_viewer` deste site e projeta só o que todos que abrem
  o site podem ver?
- O filtro da view, e não a página, separa o que é de cada pessoa?
- Fiz o ship de esqueleto e peguei o `siteId` em `pages list` antes de criar a
  view?
- `--uses` lista os ids que o HTML chama, mais os das outras páginas de dados
  do mesmo host (e as leituras `ravi.pages.*` que alguma página use)?
- Nenhum `pages publish` ou `artifacts publish` nesse host?
- Você disse à pessoa qual host (todas as rotas) passou a ler, e a escrever
  quais colunas, em qual view?
- A rota é `private` ou `protected_link`, e quem abre é membro logado?
- Todo valor chega ao DOM por `textContent`?
- Escritas mandam o `version` lido e uma chave de idempotência por input?
- Erros tratados: login, `fieldErrors`, conflito com `current`, `not_found` e
  mensagem genérica com o `x-request-id`?
