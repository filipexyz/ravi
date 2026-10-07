# Telas sobre Bases: Ravi Pages gerados

Bases não tem tela no Console. Toda UI sobre uma base (tabela, board,
formulário, dashboard, gráfico, portal) é uma Ravi Page que você gera e
publica. A página fala com a base só pelos connectors `ravi.bases.*`, sempre
através de uma view. A view é o contrato de acesso: projeção (colunas), filtro
obrigatório e princípios. O Console aplica a view em cada chamada; a página só
desenha o que volta.

## Fluxo

1. **View.** Desenhe a view da tela com o princípio `page_viewer` do site.
   Ao conceder `page_viewer`, diga à pessoa: "o host `<host>` (todas as rotas)
   passa a ler a view `<nome>` [e a escrever as colunas X], como quem abre o
   site".
2. **Gráficos.** Se a tela tem gráficos, crie-os sobre uma view (`charts.md`).
3. **Página.** Um arquivo HTML. Ids de view e gráfico entram como constantes.
   Dados nunca entram no HTML: a página busca tudo na hora, como quem vê.
4. **Ship.** `ravi pages ship ... --uses <ids>` com os `ravi.bases.*` que a
   página chama, mais os das outras páginas de dados do mesmo host (o
   allowlist é do host; veja "Ship").
5. **Verifique** e mande a URL para a pessoa abrir, junto com o aviso do
   passo 1.

### Site e view

O `siteId` do princípio é o `id` do host default do projeto:

```bash
ravi pages list --project <p> --json      # sites[]: o que tem isDefault: true
```

Projeto sem host ainda: o primeiro `ravi pages ship` cria. Publique um
esqueleto (`--body "<p>Em construção</p>"`) na rota final e use o `site.id`
do JSON.

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
| portal ("meus pedidos" + novo pedido) | `table` / `list` | `views.describe`, `views.query`, `views.rows.create`, `views.rows.get` |
| dashboard | `chart` ou qualquer | `charts.data` (+ `views.describe` se ler `layout.chartId`) |

No `--uses`, sempre o id completo: `ravi.bases.views.describe`, não
`views.describe`.

### Ship

```bash
ravi pages ship --project <p> --title "Pedidos" --route /pedidos --html ./pedidos.html \
  --uses ravi.bases.views.describe,ravi.bases.views.query,ravi.bases.views.rows.create --json
```

- Deixe a rota `private` (padrão do ship). Em rota private o Pages pede login
  antes de servir o HTML, e é essa sessão de login que os connectors aceitam.
  Em rota `public`, quem não entrou recebe `connector_session_required` e a
  página não consegue forçar o login. Rota com senha não serve: a sessão de
  senha não é sessão do Pages, então toda chamada dá
  `connector_session_required`, e "Entrar de novo" só mostra a senha de novo.
- `ravi.bases.*` nunca entra no allowlist implícito. Id fora do `--uses` dá
  `connector_not_allowlisted`. A página passou a chamar outra action? Ship de
  novo com o id.
- Hoje o allowlist é do host, não da rota: o Console lê o `uses` da release
  ativa do host, que é a do último ship em qualquer rota. Num host com várias
  páginas de dados, declare em todo ship nesse host a união dos ids que essas
  páginas chamam, e não faça ship sem `--uses` ali. Isso não amplia acesso: a
  view já concede ao site inteiro.

### Verificação

```bash
grep -o 'ravi\.bases\.[a-z.]*' pedidos.html | sort -u        # tem de bater com o --uses
ravi pages published --project <p> --json                    # rota e URL
ravi bases views show <base> <view-id> --json                # valid: true; page_viewer com o site certo
ravi bases views query <base> <view-id> --limit 5 --json     # dados pelo filtro da view, com $viewer = você
```

O CLI não reproduz a sessão de quem vê (no Pages ninguém é gerente). Mande a
URL para a pessoa abrir e confirme com ela. Se a página mostrar um erro, a
tabela de erros abaixo diz o que corrigir.

## Quem passa

Uma chamada só roda quando tudo isto vale:

1. O id está no `uses` da release.
2. Quem vê entrou no Pages por login (sessão `human_viewer`). Sessões de
   captura ou sem escopo recebem `connector_permission_required`. Quem só tem
   sessão de senha (ou nenhuma, em rota `public`) recebe
   `401 connector_session_required`, e entrar de novo não resolve: use rota
   `private` sem senha.
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
  o sort da view nessa consulta. `filter` é o Query AST (`query-ast.md`),
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

## Cliente

A página só chama `POST /_ravi/connectors/exec` (caminho absoluto, no próprio
host). Sucesso: HTTP 200 com `{ ok: true, id, revision, output }`. Erro:
status HTTP com `{ error }`; só nas `ravi.bases.*`, `validation_failed` traz
`fieldErrors` e `version_conflict` traz `current` (a linha atual pela view,
sem `users`). Nenhum outro campo vem no erro. O header `x-request-id`
identifica a chamada para suporte. O cliente abaixo mostra mensagens num
`<p id="banner" hidden></p>`.

```js
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((kid) => kid !== null && kid !== undefined && kid !== ""));
  return node;
}

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
```

### Erros

| `error` | status | quando | a página |
|---|---|---|---|
| `connector_session_required` | 401 | sem sessão do Pages: sessão vencida, rota `public` sem login, ou rota com senha (sessão de senha não conta) | botão "Entrar de novo" com `location.reload()`: em rota private, o Pages leva ao login e volta. Em rota com senha ou `public` isso não resolve: publique em rota `private` sem senha |
| `connector_unauthorized` | 401 | sessão inválida ou expirada, ou `Origin` diferente do host | o mesmo |
| `connector_permission_required` | 403 | sessão do Pages que não é de login (captura, sem escopo), ou Bases não liberado para a org ou o papel | "sem permissão"; não repita |
| `connector_not_allowlisted` | 403 | id fora do `uses` da release | erro de publish: ship de novo com o id |
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
| `connector_rate_limited` | 429 | muitas chamadas | espere e tente de novo; não faça polling |
| `connector_unavailable` | 503 (404 se o site não está ativo) | Console fora ou resposta inválida | mensagem genérica com o `x-request-id` |

`network_error` não vem do servidor: é o nome que o cliente acima dá quando o
`fetch` falha. Corpo que não é JSON vira `connector_unavailable`. As mensagens
de `fieldErrors` vêm do Console, em inglês.

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
  quem já aparece em `users`.
- `required` vale na criação (toda propriedade obrigatória termina com valor,
  por campo ou por `write.set`) e ao limpar o campo num update.

## Padrões por layout

Comece sempre por `describe` e use `capabilities` para decidir o que desenhar:
sem `read`, não chame `query`; coluna fora de `writeColumns`, sem editor; sem
`create` ou `archive`, sem o botão. Esconder é só conforto: quem barra é a
view.

### Tabela

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
  "abertos" e coluna "Ganho"); `validation_failed` → coluna obrigatória ou
  opção arquivada.

### Lista e galeria

- Lista: um item por linha; título = primeira coluna `text`; o resto como
  chips; clique abre o detalhe.
- Galeria: um cartão por linha, tamanho por `layout.cardSize` (`small`,
  `medium`, `large`). `layout.coverProp` é `url` (imagem: só `http(s)`,
  `loading="lazy"`, `referrerpolicy="no-referrer"`) ou `text`.

### Calendário

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

- Detalhe: `rows.get { viewId, rowId }` traz a linha com `body` (se
  projetado) e `users`. `rowId` na URL (`#row=<id>`) é seguro; valores não.
- `not_found` no detalhe: a linha saiu da view, foi arquivada ou não existe.
  Tire da lista.
- Arquivar: só com `capabilities.archive`. Confirme com a pessoa, chame
  `rows.archive { viewId, rowId, expectedVersion }` e tire a linha da tela.
  `not_found` = já foi; `version_conflict` = mostre `current` e pergunte de
  novo.

### Gráficos e dashboards

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
Os outros marks viram tabela. Usa `exec`, `el` e `showError` do cliente acima.

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

## Checklist

- A view concede `page_viewer` deste site e projeta só o que todos que abrem
  o site podem ver?
- O filtro da view, e não a página, separa o que é de cada pessoa?
- `--uses` lista os ids que o HTML chama, mais os das outras páginas de dados
  do mesmo host?
- Você disse à pessoa qual host (todas as rotas) passou a ler, e a escrever
  quais colunas, em qual view?
- A rota é `private`?
- Todo valor chega ao DOM por `textContent`?
- Escritas mandam o `version` lido e uma chave de idempotência por input?
- Erros tratados: login, `fieldErrors`, conflito com `current`, `not_found` e
  mensagem genérica com o `x-request-id`?
