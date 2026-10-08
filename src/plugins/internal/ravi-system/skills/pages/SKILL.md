---
name: pages
description: |
  Publica uma página no host default do projeto (rota, não um host novo). Use quando precisar:
  - Criar, publicar ou hospedar uma página, landing ou relatório
  - Subir HTML e obter um URL no host do projeto
  - page, pages, HTML, rota, URL, publish, hospedar, landing, relatório
  Não use para o ledger genérico de artifacts (isso é a skill artifacts).
  Não crie um host *.ravi.page por página.
---

# Ravi Pages

Um projeto tem um host default (`<orgSlug>-<projectSlug>.ravi.page`). Páginas são rotas nesse host. A URL é `https://<host><rota>`. Domínio custom é um binding em cima desse host.

Não crie um site por página. Não crie um host por página. `--title` é o título da página. Ele não vira slug de host.

`ravi pages ship` publica uma rota no host default. Um comando. Não orquestre `create` + `publish`. Não use `artifacts publish` para hospedar HTML.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (`SITE_NOT_FOUND`, `ROUTE_NOT_FOUND`, auth/provider).
- `2` erro de uso (falta `--title`, `--body`/`--html`/`--dir` conflitantes, slug reservado).
- `3` freio de escrita — não é erro. Nada foi enviado/exposto; o envelope traz `dryRun:true` e `plan`. Revise e repita com `--execute`.

Exit 3 **não** se aplica a `pages ship`. O ship escreve na hora, e `--execute` nele é no-op (aceito por compatibilidade). O freio continua em `pages create`, `pages publish`, `password set/remove`, `domains`, `assertion audiences set/remove`, `apps targets set/remove` e `visibility`/`update` para `public`.

`--json` de sucesso do ship. `slug` é o host do projeto. `route` é a página. O campo `site` é o registro desse host:

```json
{ "url": "https://acme-proj.ravi.page/relatorio", "site": {}, "slug": "acme-proj", "route": "/relatorio", "visibility": "private", "artifactId": "art_xxx" }
```

Checklist:

- Publiquei no host default do projeto, sem criar um `*.ravi.page` a partir do título?
- Listei as rotas antes de escolher `--route`?
- Usei só `ravi pages ship` para obter a URL, sem `create` + `publish`?
- Tratei exit 3 como freio só em password/domains/assertion audiences set|remove/apps targets set|remove/visibility→public, nunca em ship?
- Se a rota `/` ficou private explícita, usei `pages visibility <host> public --route / --execute` em vez de re-ship?

## Happy path: projeto → host → rota

```bash
ravi pages published --project <projeto> --json
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
- Depois de um ship com sucesso, o Ravi cria ou reusa um trigger `page-comment:<site id>` no tópico `ravi.watch.console.page.comment.created`, filtrado a essa page e ligado ao agent que fez o ship. Um segundo ship não troca o agent. Comentário do próprio creator ainda acorda o agent. Sem agent no contexto, o ship segue e `commentFollow.skipped` fica `missing_creator`.
- `--visibility public` vale no mesmo comando. Não precisa de `--execute`.

Prefixos reservados de host: `ravi` e `ravi-*`. O CLI não cria esses slugs. Não tente usá-los como host novo.

## Listar

```bash
ravi pages list --project <projeto> --json
ravi pages published --project <projeto> --json
```

`pages list` lista hosts do projeto. O host default tem `isDefault: true`. `pages published` lista rotas e URLs. Leia isso antes de escolher `--route`.

## Host legado

Não é o happy path. Um argumento posicional de slug cria ou reusa um host `*.ravi.page` extra e emite aviso. Não use isso para uma página nova.

```bash
ravi pages ship <slug-legado> --title "Página antiga" --route / --body "<h1>OK</h1>" --json
```

`create` só cria o registro do host. `publish` sobe bytes num host já existente, ou publica um `art_*` que **já** está no ledger local. Prefira `ship` salvo o HTML já ser um `art_*`.

```bash
ravi pages create <slug> --json
ravi pages publish <project-ref> <host> <artifact-id> --route / --json
```

## Password / visibility / domain

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

`pages visibility` sem `--route` muda só o `defaultVisibility` do host. Rotas publicadas com visibility explícita (ex.: `/` private) continuam private. Use `--route /` (ou `/foo`) para mudar a política daquela rota sem reenviar arquivos. Sem `--execute`, o plano mostra host vs rota e current vs target (exit 3 para `public`). Com `--execute`, o JSON/humano reporta a visibility efetiva da rota alvo.

`password set` sem `--execute` nem pede a senha. Automação: `--stdin` com input redirecionado. Nunca coloque a senha em argumento, env, log ou JSON.

## Backend auth / assertion audiences

A page que chama uma API sua não usa o JWT do `ravi login`. Esse token fica no CLI. Quem abre a page, depois que o Console já deixou ver a rota, pode receber uma asserção de curta duração. Essa asserção é cunhada para o viewer num host Pages específico. A page lê o bootstrap same-origin na hora. O HTML publicado não leva segredo.

`--aud` é para quem a asserção serve: o identificador da API. `--origin` é quais origens desse host Pages podem recebê-la — o host default (`https://<host>.ravi.page`) ou um hostname custom ativo no mesmo site. A URL da API não é `--origin`; o registro liga `(site, aud)` a esses hostnames. Colocar a URL da API em `--origin` falha na validação do Console com HTTP 400 `PAYLOAD_INVALID` (o hostname tem de ser o default deste site ou um hostname custom ativo).

Registre a audiência no host. `set` e `remove` sem `--execute` saem 3 com o plano. Nada é enviado. `list` só lê.

```bash
ravi pages assertion audiences list --site <host> --json
ravi pages assertion audiences set --site demo --aud https://api.exemplo --origin https://demo.ravi.page --execute
ravi pages assertion audiences set --site demo --aud https://api.exemplo --origin https://demo.ravi.page --origin https://docs.exemplo --execute
ravi pages assertion audiences remove --site <host> --aud <aud> --execute
```

`--site` é o `siteRef` do Console: slug do host, id do site, ou hostname (`acme-proj.ravi.page`). `--project` e `--console` seguem o grupo. `--origin` é `https` (esquema, host, porta opcional) e tem de ser uma origem deste site Pages, no mesmo host que `--site`. Pode repetir, inclusive um hostname custom já ativo nesse site (`https://docs.exemplo` no exemplo). `set` substitui a lista de origins daquele `aud`.

Para a page usar a asserção, o ship leva `uses` com `ravi.identity.assertion`:

```bash
ravi pages ship --project <projeto> --title "App" --route /app --dir ./site --uses ravi.identity.assertion --json
```

`--uses` não grava token no artefacto. Sem esse id, o publish não declara a capability.

A API verifica a assinatura no JWKS do Console que respondeu. O JSON de `list`/`set`/`remove` traz `jwksUrl`. No Console padrão é `https://console.ravi.bot/api/public/pages/viewer-assertions/jwks`. Em outro Console, o mesmo path sai da base configurada.

Nunca grave o JWT da asserção, o access token ou o refresh token em log, argumento, env, HTML ou JSON de saída. O CLI descarta esses campos se o Console os devolver.

## App gateway (`/_ravi/apps`)

Uma page pode chamar uma operação read-only de um Ravi app que roda nesta instalação: `POST /_ravi/apps/<appId>/<operationId>` com `Authorization: Bearer <asserção>` e corpo `{ "args": [...] }`. A asserção é a mesma `ravi.identity.assertion`, cunhada para um `aud` reservado ao gateway. A resposta é `{ ok, appId, operation, output }` ou `{ error }`.

Registre o target no host. `set` e `remove` sem `--execute` saem 3 com o plano. `list` só lê e mostra targets ativos e revogados, sem grant nem token.

```bash
ravi pages apps targets list --site <host> --json
ravi pages apps targets set --site demo --aud https://apps.exemplo/slides --app slides --op slides.list --origin https://demo.ravi.page --execute
ravi pages apps targets remove --site demo --aud https://apps.exemplo/slides --execute
```

- `--op` é o id exato da operação no manifest (repita, 1 a 16). `--origin` segue a regra das assertion audiences (1 a 8).
- `--installation` é o id Console da instalação que serve o target. Sem ele, vale esta instalação (`GET /api/cli/me`). O plano do dry-run mostra o id.
- Um `aud` é do gateway ou das assertion audiences, nunca dos dois: conflito sai `APP_GATEWAY_AUDIENCE_CONFLICT`, tanto em `pages apps targets set` quanto em `pages assertion audiences set`. Um `aud` que já teve target continua reservado ao gateway mesmo depois de `remove`: para assertion audiences, use outro `--aud`. Instalação de outra org ou sem permissão sai `INSTALLATION_ORG_MISMATCH`. `remove` de um `aud` sem target sai `TARGET_NOT_FOUND`.

Do lado desta instalação nada roda sem opt-in local:

- Daemon com `RAVI_APP_GATEWAY_ENABLED=1` e sessão do `ravi login` com o escopo `console.apps.relay` (sessões antigas precisam de `ravi login` de novo). O runner abre um WSS de saída para o relay; não abre porta.
- `ravi settings set apps.gateway.allowed_operations slides:slides.list,slides:slides.get` lista pares exatos `<appId>:<operationId>` (sem `*`). Vazio = nada exposto.
- `ravi settings set apps.gateway.require_link true` exige um contato Ravi Link do viewer no cache local.
- Só operadores locais ou superadmin mudam `apps.gateway.*`.
- A operação no `ravi.app.json` precisa de `"mutating": false` explícito e de uma declaração `gateway`, que diz quais args o viewer pode passar:

```json
"slides.list": {
  "interface": "cli",
  "command": "slides list {args} --json",
  "mutating": false,
  "gateway": { "args": { "options": ["--limit", "--cursor"], "flags": ["--archived"], "positional": 0 } }
}
```

O comando precisa escolher o que roda antes dos args do viewer, porque um posicional é texto livre. `ravi apps check` recusa, e o executor não roda, uma operação com args que tenha:

- `ravi` sem um comando completo do registry do CLI antes de `{args}` (`ravi {args}`, `ravi contacts {args}`; `ravi doctor` e `ravi whoami` não estão no registry), um comando que despacha (`ravi apps run`, `ravi jobs run`, `ravi commands run`, `ravi tools invoke`), um comando que o registry marca `mutate` (`ravi tasks create`), ou um comando que também tem subcomandos sem uma palavra fixa depois (`ravi crm account {args}`: use `ravi crm account show {args}`);
- um executor de programas como executável (`env`, `xargs`, `sudo`, `timeout`, `npx`, `bunx`, `ssh`, `open`...);
- nenhuma palavra fixa antes de `{args}` (`git {args}`, `bash -c {args}`, `node -e {args}`), ou `run`, `exec`, `x`, `dlx` ou `eval` logo antes (`npm run {args}`);
- uma palavra fixa depois de `{args}` (`tool cli.js {args} list`): depois de `{args}` só opções fixas, como `--json`;
- com `positional` acima de 0, uma opção logo antes dos args (`tool list --format {args}`).

Para programas que não são o `ravi`, a instalação não conhece a gramática: aponte o comando para o subcomando final. `"gateway": { "args": "none" }` aceita só args vazio. `--execute` e `--` nunca podem ser declarados. Qualquer outro arg começando com `-` é recusado. Sem Permission Provider no app, todo viewer que pode cunhar a asserção daquele `aud` vê a saída: exponha só o que todos eles podem ver, ou use `require_link` / Permission Provider.
