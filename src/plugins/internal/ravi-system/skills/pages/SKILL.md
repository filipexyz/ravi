---
name: pages
description: |
  Gerencia Ravi Pages: hospeda HTML e devolve uma URL. Use quando precisar:
  - Criar, publicar ou hospedar uma page/página/site/landing/relatório
  - Subir HTML e obter um URL público ou privado
  - page, pages, HTML, site, URL, publish, hospedar, landing, relatório
  Não use para o ledger genérico de artifacts (isso é a skill artifacts).
---

# Ravi Pages

`ravi pages ship` é o one-shot. Um comando. Não orquestre `create` + `publish`.
Não use `artifacts publish` para hospedar HTML.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (`SITE_NOT_FOUND`, `ROUTE_NOT_FOUND`, auth/provider).
- `2` erro de uso (falta `--title`, `--body`/`--html`/`--dir` conflitantes, slug inválido).
- `3` freio de escrita — não é erro. Nada foi enviado/exposto; o envelope traz `dryRun:true` e `plan`. Revise e repita com `--execute`.

Exit 3 **não** se aplica a `pages ship`, `pages create` nem `pages publish`. Esses ops escrevem na hora. `--execute` nesses três é no-op (aceito por compatibilidade). O freio continua em `password set/remove`, `domains` e `visibility`/`update` para `public`.

`--json` de sucesso do ship:

```json
{ "url": "https://demo.ravi.page/", "site": {}, "slug": "demo", "route": "/", "visibility": "private", "artifactId": "art_xxx" }
```

Checklist:

- Usei só `ravi pages ship` para obter a URL, sem `create` + `publish`?
- Tratei exit 3 como freio só em password/domains/visibility→public, nunca em ship?

## One-shot

```bash
ravi pages ship --title "Relatório semanal" --body "<h1>OK</h1>" --json
ravi pages ship --title "Landing" --html ./landing.html --visibility public --json
ravi pages ship --title "Docs" --dir ./site --entrypoint index.html --json
```

Regras:

- `--title` é obrigatório. Sem `<slug>`, o slug sai do título.
- Conteúdo: exatamente um de `--body` (fragmento, wrap HTML5), `--html` (arquivo) ou `--dir` (diretório + entrypoint).
- Defaults: `--visibility private`, `--route /`, `--entrypoint index.html`.
- Slug existente: reusa o host. Não falha.
- `[project]` é opcional (scope do Console). `--project` também vale.
- `--visibility public` vale no mesmo comando. Não precisa de `--execute`.

## Listar

```bash
ravi pages list --json
ravi pages published --json
```

## Avançado / legado

Não é o happy path. `create` só cria o host. `publish` sobe bytes num host já existente, ou publica um `art_*` que **já** está no ledger local. Prefira `ship` salvo o HTML já ser um `art_*`.

```bash
ravi pages create <slug> --json
ravi pages publish <project-ref> <site-slug> <artifact-id> --route / --json
```

## Password / visibility / domain

```bash
ravi pages password set <slug> --route / --execute
ravi pages password status <slug> --route / --json
ravi pages password remove <slug> --route / --visibility private --execute
ravi pages visibility <slug> private
ravi pages visibility <slug> public --execute
ravi pages domains <slug> docs.example.com --execute
```

`password set` sem `--execute` nem pede a senha. Automação: `--stdin` com input redirecionado. Nunca coloque a senha em argumento, env, log ou JSON.
