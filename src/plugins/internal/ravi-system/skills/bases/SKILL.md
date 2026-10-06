---
name: bases
description: |
  Bases: bancos de dados tipados do projeto no Ravi Console (tipo Notion), via `ravi bases`. Use quando precisar:
  - Criar uma base a partir de um pedido em linguagem natural (CRM, calendário, OKRs, bugs, vagas)
  - Adicionar, renomear, mudar tipo ou remover propriedades (colunas)
  - Consultar, criar, atualizar, arquivar ou apagar linhas; ver histórico de uma linha
  - Escrever filtros com o Query AST, ordenar, paginar e agregar
  - Criar views como contratos de acesso ("cada vendedor só vê os próprios deals") e formulários
  - Criar gráficos (subset de Vega-Lite) e ler os dados agregados
  - Ligar uma base a uma Ravi Page (connectors ravi.bases.*)
  - Reagir a mudanças de linha com triggers (inbox bridge, categoria "bases")
  - Importar CSV ou exportar CSV/JSON
  base, bases, database, tabela, planilha, CRM, pipeline, kanban, formulário, view, gráfico, linhas
  Não use para o CRM local do Ravi (`ravi crm`) nem para hospedar HTML sem dados (skill pages).
---

# Ravi Bases

Uma base é uma tabela tipada que pertence a um projeto do Console. Tem
propriedades (colunas com tipo), linhas (valores + corpo markdown), views
(consulta + projeção + regras de acesso) e gráficos (encoding sobre uma view).
O Console é dono de autorização, políticas de view, compilação de filtros e
validação. O CLI só transporta: ele nunca avalia filtro ou acesso. Se o Console
recusa, a resposta do Console vale.

Sempre rode com `--json` quando for decidir programaticamente, e passe
`--project <ref>` quando houver mais de um projeto (`ravi cloud scope show`
mostra o escopo salvo).

## Contrato Do CLI

- Envelope de falha com `--json`: `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
- Exit: `0` ok · `1` erro (`NOT_FOUND`, `CONFLICT`, `VERSION_CONFLICT`, auth) ·
  `2` uso (`PAYLOAD_INVALID`) · `3` freio de escrita (`WRITE_REQUIRES_EXECUTE`, nada foi escrito).
- `error.consoleError` traz o código fino do Console (`version_conflict`,
  `unknown_property`, `invalid_filter`, `write_escapes_view`, `cursor_invalid`,
  `idempotency_conflict`, `slug_taken`, `key_taken`, `view_invalid`, ...).
- `VERSION_CONFLICT` traz `error.current` (a linha atual, projetada como a sua
  leitura). Faça merge e repita com `--expected-version <current.version>`.
- Erros de valor voltam em `error.issues` com path `["values", "<key>"]`.
- `PROJECT_ACCESS_DENIED` com `missingScopes`: o login é anterior às Bases.
  Rode `ravi login` de novo para ganhar `console.bases.read` e `console.bases.write`.

Freios (`--execute` é sempre a última flag):

| comando | sem `--execute` |
|---|---|
| `bases archive`, `bases restore` | exit 3 com o plano, nada chamado |
| `bases rows purge` (apaga linha e histórico, irreversível) | exit 3 com o plano |
| `bases views archive`, `bases charts archive` | exit 3 com o plano |
| `bases props update --type ...`, `bases props delete` | o Console devolve o relatório (linhas convertidas/limpas, views e gráficos dependentes); exit 3 |
| `bases rows import` | lê o schema, valida o CSV inteiro, mostra mapeamento e lotes; exit 3 |

## Fluxo: do pedido ao schema

1. Extraia entidades e campos do pedido. Uma base por entidade ("deals",
   "contatos" viram duas bases ligadas por `ref` ou por `person`).
2. Escolha o tipo mais estrito que serve:
   - estágio/etapa com fluxo → `status` (opções com grupo `todo|in_progress|done`);
   - categoria fechada → `select`; várias tags → `multi_select`;
   - responsável/dono → `person` (ids de usuários Ravi da org); quem criou → use a coluna de sistema `created_by`;
   - valor → `number` (`config.format`: `plain|percent|currency` + `currency`);
   - prazo → `date` (`config.includeTime: true` só se a hora importa);
   - link externo → `url`; e-mail → `email`; telefone → `phone`;
   - referência a algo fora da base (artifact, work object, outra base) → `ref` (`{type, id}`);
   - texto longo → corpo da linha (`--body`), não uma propriedade `text`.
3. Chaves: `^[a-z][a-z0-9_]{0,62}$`, em inglês ou português sem acento, estáveis
   (filtros, views, Pages e automações usam a chave). Não use chaves reservadas:
   `row_id`, `version`, `created_time`, `created_by`, `updated_time`, `updated_by`, `archived_at`, `body`, `id`.
4. Crie com o schema inicial de uma vez, depois as views:

```bash
ravi bases create "Pipeline" --slug pipeline --timezone America/Sao_Paulo --schema @schema.json --project acme --json
ravi bases show pipeline --json
```

`schema.json` é um array de propriedades (ou `{ "properties": [...] }`):

```json
[
  { "key": "name", "name": "Deal", "type": "text", "required": true },
  { "key": "stage", "name": "Estágio", "type": "status",
    "config": { "options": [
      { "name": "Lead", "group": "todo" }, { "name": "Proposta", "group": "in_progress" },
      { "name": "Ganho", "group": "done", "color": "green" }, { "name": "Perdido", "group": "done", "color": "red" } ] } },
  { "key": "owner", "name": "Vendedor", "type": "person" },
  { "key": "amount", "name": "Valor", "type": "number", "config": { "format": "currency", "currency": "BRL" } },
  { "key": "close_date", "name": "Fechamento", "type": "date" }
]
```

Depois, ajustes pontuais:

```bash
ravi bases props add pipeline "Origem" --type select --options "Inbound,Outbound,Indicação" --json
ravi bases props update pipeline amount --name "Valor (R$)" --json
ravi bases props update pipeline close_date --type text --json          # migração: exit 3 com relatório
ravi bases props update pipeline close_date --type text --json --execute
ravi bases props delete pipeline origem --json                           # relatório de dependentes, exit 3
```

Toda mutação de propriedade usa `--expected-schema-version`. Sem a flag o CLI
lê a versão atual antes. Mudança de tipo acima de 10.000 linhas ativas é
recusada (`migration_too_large`): crie uma propriedade nova e copie em lotes.

## Linhas

```bash
ravi bases rows add pipeline --set name="Acme" --set stage=Lead --set amount:=12000 --json
ravi bases rows add pipeline --values @deal.json --body-file notes.md --json
ravi bases rows get pipeline <row-id> --json
ravi bases rows update pipeline <row-id> --set stage=Proposta --expected-version 3 --json
ravi bases rows update pipeline <row-id> --set stage=Ganho --last-write-wins --json
ravi bases rows archive pipeline <row-id> --expected-version 4 --json
ravi bases rows history pipeline <row-id> --json
ravi bases rows purge pipeline <row-id> --json --execute
```

- `--set key=texto` grava string; `--set key:=<json>` grava JSON (número,
  booleano, array, objeto). `--set` sobrescreve chaves de `--values`.
- Valores de entrada: `select`/`status`/`multi_select` aceitam nome ou id da
  opção (saída é sempre o id); `date` aceita `"2026-10-31"` ou `{start, end}`;
  `person` é array de user ids; `ref` é array de `{type, id}`.
- `update`, `archive` e `restore` exigem `--expected-version <n>` (a versão que
  você leu) ou `--last-write-wins` explícito.
- Toda escrita de linha leva uma chave de idempotência gerada por chamada
  (`idempotencyKey` no JSON de saída). Para repetir com segurança depois de um
  timeout, repita com `--idempotency-key <a mesma chave>`. Via `--view`, se a
  linha saiu da view ou foi arquivada, o replay traz só `rowId` e `version`.
- Dentro de uma sessão de agent, o CLI anexa `clientHint {agentId, sessionKey, sdk}`
  ao ledger. É metadado, não autorização.
- `--view <id>` escreve através da view: só as colunas graváveis dela, e a linha
  tem de continuar dentro do filtro da view (senão `write_escapes_view`).

## Consultas

```bash
ravi bases rows query pipeline --filter '{"prop":"stage","op":"in","value":["Lead","Proposta"]}' --sort amount:desc --json
ravi bases rows query pipeline --filter @filtro.json --all --max-rows 5000 --format csv
ravi bases views query pipeline <view-id> --limit 50 --json
ravi bases aggregate pipeline --group-by stage --group-by close_date:month --agg count --agg sum:amount:total --json
```

- Paginação por cursor: `--limit` 1-500 (padrão 100), `--cursor` da página
  anterior. O cursor vale 15 minutos e só continua a mesma consulta. `--all`
  segue os cursores até `--max-rows` (padrão 10.000) e marca `truncated`.
- Operadores por tipo, variáveis (`$viewer.raviUserId`, `$today`, ...) e limites:
  `references/query-ast.md`.

## Mapa das referências

- `references/query-ast.md` — Query AST: nós, operadores por tipo, variáveis, limites, exemplos.
- `references/views-access-forms.md` — views como contrato de acesso, princípios, escrita via view, formulários.
- `references/charts.md` — subset de Vega-Lite, marks, canais, dados agregados.
- `references/pages.md` — Ravi Pages lendo e escrevendo bases (`uses`, exec same-origin, `human_viewer`).
- `references/events-triggers.md` — eventos de linha no inbox bridge e triggers.
- `references/import-export.md` — importar CSV em lotes idempotentes, exportar CSV/JSON.
- `references/recipes.md` — CRM, calendário de conteúdo, OKRs, triagem de bugs, contratação.

## Regras

- Não invente ids de opção, usuário, view ou gráfico: leia com `bases show`,
  `props list`, `views list` ou `charts list`.
- Não tente reproduzir no cliente o filtro de uma view para "conferir" acesso.
  Pergunte ao Console (`views show` mostra suas capabilities).
- Não coloque valores de linha em logs, nomes de trigger ou mensagens de commit.
- Não use `--last-write-wins` por padrão: só quando o pedido for sobrescrever.
