---
name: pages
description: |
  Publica páginas como rotas no host default do projeto com `ravi pages ship`, estáticas ou de dados. É o verbo MOSTRAR das soluções. Use quando precisar:
  - publicar uma página, landing, relatório ou snapshot e obter a URL
  - publicar uma página de dados sobre uma view de Bases (`--uses ravi.bases.*`, lista que vale para o host inteiro)
  - mudar visibilidade, senha ou domínio de uma rota sem reenviar arquivos
  - dar à página a asserção do viewer para chamar a sua própria API
  page, pages, HTML, rota, URL, publicar, hospedar, landing, snapshot, site
  Página de dados só funciona para membros logados da org, em rota private ou protected_link; gente de fora recebe snapshot ou mensagem (skill solucoes).
  Não use para o ledger de artifacts (skill artifacts). Não crie um host *.ravi.page por página.
---

# Ravi Pages

> Verbos: MOSTRAR. Compõe com: bases, cron (snapshot).
> Solução com mais de uma peça? `ravi skills show solucoes` primeiro.

Um projeto tem um host default (`<orgSlug>-<projectSlug>.ravi.page`). Páginas são rotas nesse host. A URL é `https://<host><rota>`. Domínio custom é um binding em cima desse host.

Não crie um site por página. Não crie um host por página. `--title` é o título da página. Ele não vira slug de host.

`ravi pages ship` publica uma rota no host default. Um comando. Não orquestre `create` + `publish`. Não use `artifacts publish` para hospedar HTML.

Página estática (landing, relatório, snapshot) leva os números no HTML e serve a qualquer público. Página de dados lê uma view de Bases na hora e é só para membro logado ("Página de dados").

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction}}`.

Exit: `0` sucesso · `1` erro de execução (`SITE_NOT_FOUND`, `ROUTE_NOT_FOUND`, `CONFLICT` de comentário não lido, auth/provider) · `2` uso (falta `--title`, `--body`/`--html`/`--dir` conflitantes, slug reservado) · `3` freio de escrita, não erro: nada foi enviado; o envelope traz `dryRun:true` e `plan`. Revise e repita com `--execute`.

Exit 3 não se aplica a `pages ship`. O ship escreve na hora, e `--execute` nele é no-op (aceito por compatibilidade). O freio continua em `pages create`, `pages publish`, `password set/remove`, `domains`, `assertion audiences set/remove` e `visibility`/`update` para `public`.

`--json` de sucesso do ship. `slug` é o host do projeto. `route` é a página. O campo `site` é o registro desse host:

```json
{ "url": "https://acme-proj.ravi.page/relatorio", "site": {}, "slug": "acme-proj", "route": "/relatorio", "visibility": "private", "artifactId": "art_xxx" }
```

Checklist:

- Publiquei no host default do projeto, sem criar um `*.ravi.page` a partir do título?
- Listei as rotas antes de escolher `--route`?
- Usei só `ravi pages ship` para obter a URL, sem `create` + `publish`?
- Se a rota `/` ficou private explícita, usei `pages visibility <host> public --route / --execute` em vez de re-ship?
- Página de dados: rota private ou protected_link, e `--uses` com a união do host?

## Caminho padrão: projeto → host → rota

```bash
ravi pages list --project <projeto> --json        # hosts do projeto; o default tem isDefault: true
ravi pages published --project <projeto> --json   # rotas e URLs: leia antes de escolher --route
ravi pages ship --project <projeto> --title "Relatório semanal" --route /relatorio --body "<h1>OK</h1>" --json
ravi pages ship --title "Relatório semanal" --body "<h1>OK</h1>" --json
ravi pages ship --project <projeto> --title "Landing" --route / --html ./landing.html --visibility public --json
ravi pages ship --project <projeto> --title "Docs" --route /docs --dir ./site --entrypoint index.html --json
```

Regras:

- Sem slug posicional, o ship usa o host default do projeto: o site com `isDefault`, ou o slug `<orgSlug>-<projectSlug>`. Se esse host ainda não existe, o CLI cria só esse, com `isDefault`. Não cria outro.
- `--title` é obrigatório e não gera host. Conteúdo: exatamente um de `--body` (fragmento, wrap HTML5), `--html` (arquivo) ou `--dir` (diretório + entrypoint).
- Defaults: `--visibility private`, `--route /` (home do projeto), `--entrypoint index.html`.
- Liste rotas com `ravi pages published` antes de publicar. `--route /` substitui a home. Outra página precisa de outra rota (`/relatorio`, `/docs`).
- `[project]` posicional junto com um segundo argumento é host legado. O projeto entra por `--project` ou pelo scope do Console.
- `--visibility public` vale no mesmo comando, sem `--execute`. Só para página estática.
- O ship arma um trigger `page-comment:<site id>` (`ravi.watch.console.page.comment.created`) para o agent do ship, mas hoje o Console não emite esse evento: comentário de página não acorda ninguém. Feedback que precisa acordar vai numa base `feedback` com formulário e trigger.

Prefixos reservados de host: `ravi` e `ravi-*`. O CLI não cria esses slugs.

## Página de dados

Lê e grava uma base pelos connectors `ravi.bases.*`, sempre através de uma view, que é o contrato de acesso (skill bases). Três regras:

1. Página de dados só para membro logado da org. Gente de fora entra por canal e recebe mensagem ou snapshot. Na dúvida, é de fora. (Sem sessão de membro, nada responde.)
2. `--uses` é do host inteiro e o último ship manda: todo ship nesse host leva a união dos ids de todas as páginas de dados. `pages publish` e `artifacts publish` apagam a lista. (O Console lê o `uses` da release ativa.)
3. Página de dados mora em rota `private` (padrão do ship) ou `protected_link`; nunca `public` nem `password`. (Só nelas o Pages pede login.)

O ship cobra as regras 1 e 3: com `ravi.bases.*` no `--uses` e a rota `public`, ele recusa e não publica nada. Membros: tire o `--visibility` (private é o padrão). Gente de fora: snapshot, com os números no HTML e sem `ravi.bases.*` no `--uses`. `--members-best-effort` passa por cima de propósito, só quando todo leitor é membro da org já logado. Página pública estática não vai num host com página de dados: o `--uses` desse host leva `ravi.bases.*` (o ship recusa) e, sem `--uses`, o allowlist do host some. Publique noutro projeto, com `ravi pages ship --project <outro> ...`.

| ids (11, sempre completos no `--uses`) | |
|---|---|
| Bases | `ravi.bases.views.describe`, `ravi.bases.views.query`, `ravi.bases.views.rows.get`, `ravi.bases.views.rows.create`, `ravi.bases.views.rows.update`, `ravi.bases.views.rows.archive`, `ravi.bases.charts.data` |
| projeto | `ravi.projects.list`, `ravi.pages.sites.list`, `ravi.pages.published.list` |
| identidade | `ravi.identity.assertion` |

Sem `--uses`, o host libera só as três de projeto. Declarar `--uses` tira as três: ponha na união as que alguma página chama. Por isso até o ship de esqueleto, num host de dados, leva a união.

Ordem num projeto novo (a view com `page_viewer` exige um site que já existe):

```bash
ravi pages ship --project <p> --title "Pautas" --route /pautas --body "<p>Em construção</p>" --json
ravi pages list --project <p> --json                     # siteId: id do site com isDefault: true
ravi bases views create <base> --spec @view.json --json  # page_viewer com esse siteId
ravi pages ship --project <p> --title "Pautas" --route /pautas --dir ./pautas \
  --uses ravi.bases.views.describe,ravi.bases.views.query,ravi.bases.views.rows.update --json
```

`CONFLICT` (409, "Read unread Ravi Pages comments before publishing."): comentário não lido de outra pessoa trava o ship da rota, e o CLI ainda não lê comentários. Peça à pessoa logada neste Ravi (o CLI publica em nome dela) que leia na barra do operador da página, ou publique noutra rota.

Comece por `references/esqueletos/` (board ou formulário, mais `_client.js.txt` como `client.js`). Fluxo, erros e checklist: `references/data-pages.md`.

## Senha, visibilidade e domínio

O argumento ainda é o slug do host. A página é a rota.

```bash
ravi pages password set <host> --route /relatorio --execute
ravi pages password status <host> --route /relatorio --json
ravi pages password remove <host> --route /relatorio --visibility private --execute
ravi pages visibility <host> private
ravi pages visibility <host> public --execute
ravi pages visibility <host> public --route /relatorio --execute
ravi pages domains <host> docs.example.com --execute
```

`pages visibility` sem `--route` muda só o `defaultVisibility` do host; rotas com visibility explícita (ex.: `/` private) não mudam. Com `--route /` (ou `/foo`), muda a política daquela rota sem reenviar arquivos. Para `public`, sem `--execute` sai o plano (host vs rota, atual vs alvo; exit 3); com `--execute`, a saída traz a visibility efetiva. Em rota de dados, nada de `public` nem senha (regra 3).

`password set` sem `--execute` nem pede a senha. Automação: `--stdin` com input redirecionado. Nunca coloque a senha em argumento, env, log ou JSON.

## Backend auth / assertion audiences

A page que chama uma API sua não usa o JWT do login do CLI, que nunca sai dali. Quem abre a page, depois que o Console deixou ver a rota, recebe uma asserção curta, cunhada para o viewer naquele host. A page lê o bootstrap same-origin na hora; o HTML não leva segredo.

`--aud` identifica a API. `--origin` diz quais origens do host Pages recebem a asserção: o host default (`https://<host>.ravi.page`) ou um hostname custom ativo no mesmo site. A URL da API não é `--origin` (dá 400 `PAYLOAD_INVALID`). `set` e `remove` sem `--execute` saem 3 com o plano; `list` só lê.

```bash
ravi pages assertion audiences list --site <host> --json
ravi pages assertion audiences set --site demo --aud https://api.exemplo --origin https://demo.ravi.page --execute
ravi pages assertion audiences remove --site <host> --aud <aud> --execute
```

`--site` é o slug do host, o id do site ou o hostname. `--origin` pode repetir; `set` substitui a lista daquele `aud`.

O ship da page leva `ravi.identity.assertion` no `--uses` (mais a união, se o host tiver páginas de dados):

```bash
ravi pages ship --project <projeto> --title "App" --route /app --dir ./site --uses ravi.identity.assertion --json
```

`--uses` não grava token. A API verifica a assinatura no `jwksUrl` que `list`/`set`/`remove` devolvem (no Console padrão, `https://console.ravi.bot/api/public/pages/viewer-assertions/jwks`). Nunca grave a asserção, o access token ou o refresh token em log, argumento, env, HTML ou JSON.

## Referências

Abra só o que precisar com `ravi skills show pages --file references/<arquivo>`.

- `data-pages.md`: site → view → ship, `--uses`, quem passa, connectors, erros, valores, segurança.
- `layouts.md`: tabela, board, lista, calendário, formulário, gráficos e dashboards.
- `exemplo-board.md`: página completa (tabela com formulário), cliente inline.
- `esqueletos/_client.js.txt`: a única cópia do cliente (`exec`, `describe`, `query`, `update`, `create`, `poll`).
- `esqueletos/board.html.txt`, `esqueletos/formulario.html.txt`: zonas CONFIG, FIXO e LIVRE.

## Host legado

Não é o caminho padrão. Um argumento posicional de slug cria ou reusa um host `*.ravi.page` extra e emite aviso. Não use isso para uma página nova.

```bash
ravi pages ship <slug-legado> --title "Página antiga" --route / --body "<h1>OK</h1>" --json
```

`create` só cria o registro do host. `publish` sobe bytes num host já existente, ou publica um `art_*` que já está no ledger local. Prefira `ship` salvo o HTML já ser um `art_*`. Num host com páginas de dados, `publish` apaga o `--uses` (regra 2): use `ship`.

```bash
ravi pages create <slug> --json
ravi pages publish <project-ref> <host> <artifact-id> --route / --json
```
