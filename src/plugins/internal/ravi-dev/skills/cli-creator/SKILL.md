---
name: cli-creator
description: >-
  Cria e refatora CLIs no ecossistema Ravi, aterrado na arquitetura REAL do runtime.
  Cobre as duas famílias (CLI nativo do Ravi = classe com decorators auto-descoberta;
  CLI standalone/domínio = binário próprio), o contrato de decorators
  (@Group/@Command/@Arg/@Option/@CommandAccess/@Returns/@Scope), output agent-first
  (mandato --json, envelopes canônicos, exit 0/1/2/3, ContractError, IDs semânticos),
  paginação real (páginas limitadas 50/500 + nextCommand), gate de --help padrão-ouro,
  e os meta-testes de CI que são a lei do repo. Use quando criar nova ferramenta CLI,
  refatorar CLI existente, padronizar comandos, ou integrar CLI ao runtime com
  RAVI_CONTEXT_KEY. Skill standalone — o essencial de --help e de skill→cli está inline;
  cli-help-engineering e dissolving-skills-into-cli-help são aprofundamento opcional.
  NÃO cobre: criar a skill que ensina o CLI (use skill-creator).
---

# CLI Creator — Ciclo Completo de CLIs no Ravi

**Função:** transformar um problema operacional num CLI correto, agent-first e descobrível — usando a arquitetura REAL do runtime do Ravi, não um modelo genérico. Todo padrão aqui foi spike-testado no código vivo (`ravi-src-dev`); nada é aspiracional.

**Esta skill é STANDALONE:** o essencial das 3 capacidades (criar CLI, `--help` padrão-ouro, skill→cli) está todo inline. As companion citadas (`cli-help-engineering`, `dissolving-skills-into-cli-help`) são **aprofundamento opcional, não dependência** — um agente que só tenha esta skill consegue os 3.

> ⚠️ Antes de tudo — a armadilha nº1: **NÃO existe** no CLI `ravi` um comando `cli-manifest` por-CLI nem um `tools cli-register`. Discovery é por **reflexão automática de decorators**. Se você escrever `program.command(...)` + `cli-manifest` + registro manual, está construindo a coisa errada.

---

## 1. DECIDIR primeiro: qual das 2 famílias

| Família | Quando | Como se constrói |
|---|---|---|
| **CLI nativo do Ravi** (`ravi <grupo>`) | O comando faz parte do runtime Ravi (agents, tasks, contexto, etc.) | Classe com decorators em `src/cli/commands/<grupo>.ts` → barrel auto-descobre. **Padrão default.** |
| **CLI standalone / de domínio** (ex: `sde`, `binance-cli`) | Ferramenta externa/de negócio com binário próprio, fora do processo `ravi` | Pacote próprio em `bun + commander` clássico, seu próprio `--help`/manifest |

O resto desta skill foca no **nativo do Ravi** (o caso comum). Para standalone, valem as mesmas regras de output/erro/help, mas SEM decorators/barrel.

---

## 2. Invariantes (não-negociáveis)

1. **Problema antes do parser** — modele os dados/decisão que o CLI destrava ANTES de desenhar comandos.
2. **Ferramenta antes do agente** — o CLI nasce antes da skill que o ensina.
3. **Contrato de decorators** (nativo Ravi) — um comando só é um "tool" de primeira classe com `@Command` + `@CommandAccess` + `@Returns`.
4. **Agent-first** — o consumidor é um agente autônomo com contexto escasso: alto sinal, IDs semânticos, `--json`, erros que se autocorrigem.
5. **RAVI_CONTEXT_KEY** — CLIs que rodam dentro do Ravi usam o contexto como credencial canônica.
6. **Contrato global** — `.ravi/specs/cli/SPEC.md` é normativo para envelopes, taxonomia,
   confirmação, transportes, autorização relacional (REBAC), auditoria e
   sanitização. A spec do domínio só
   classifica as operações e registra exceções/checks próprios.

---

## 3. Fluxo canônico (7 passos)

### 1. Brainstorm
Qual problema resolve? Qual decisão melhora? Quais entidades/artefatos/lineage? O que persistir e por quê?

### 2. Mapa de implementação (GATE — apresentar à aprovação humana, HITL)
- [ ] Verifiquei se já existe (`ravi tools search "<intenção>"`, `sde --help`, `ravi skills list`)
- [ ] Li a doc da interface de programação (API) do começo ao fim (se integra API externa)
- [ ] Defini domínio de negócio (financeiro, frete, estoque…)
- [ ] Escolhi storage: SQLite por domínio se há lineage/cache/auditoria; senão stateless

Apresentar o mapa ao **aprovador humano (HITL)**. NUNCA implementar sem aprovação. *(O HITL é quem o runtime/route define como owner — pode ser o RM, o dono do agente, ou o revisor. A skill é genérica: fala HITL, nunca uma pessoa específica.)*

### 3. Escrever o comando (contrato real de decorators)
Nativo Ravi = classe `@Group` com métodos `@Command` em `src/cli/commands/<grupo>.ts`. Template REAL (de `tasks.ts`):

```typescript
import "reflect-metadata";   // OBRIGATÓRIO: 1ª linha do arquivo. Sem ele os decorators viram no-op silencioso — compila mas o comando NÃO registra (mesmo modo de falha da arquitetura fictícia antiga).

@Group({ name: "tasks", description: "Task runtime for dispatching work to Ravi agents", scope: "open" })
export class TaskCommands {
  @Command({ name: "create", description: "Create a tracked task; ..." })
  @CommandAccess({ kind: "mutate", resource: "tasks", action: "create", risk: "medium" })
  @Returns(taskCreateReturnSchema)
  async create(
    @Arg("title", { description: "Short task title" }) title: string,
    @Option({ flags: "--priority <level>", description: "low|normal|high|urgent", defaultValue: "normal" }) priority?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    // ... lógica ...
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else console.log(/* view humana */);
    return payload;            // <- o return é o que o kit de desenvolvimento (SDK)/gateway serializa
  }
}
```

Os 8 decorators reais (`src/cli/decorators.ts`): `@Group` `@Command` `@Arg` `@Option` `@CommandAccess` `@Returns` `@Scope` `@CliOnly`.
- **`@CommandAccess({ kind, resource, action, risk })`** — obrigatório em quase todo comando; alimenta o permission-provider. `kind`: `read`|`mutate`. `risk`: `low`|`medium`|`high`|`destructive`.
- **`@Scope` / `scope` no `@Group`** — gate grosso de exposição; default é
  `admin`. Enum real (`decorators.ts`): `superadmin`|`admin`|`writeContacts`|`resource`|`open`.
  `open` não significa read-only e nunca substitui o `@CommandAccess` por operação.
- **`@Returns(zodSchema)`** — SEM isso o comando não vira tool tipado do SDK. Schema inline (como acima) ou em massa via `declareCommandReturns(Classe, { metodo: schema })`. Primitivos reutilizáveis em `src/cli/return-schemas.ts`: `cliOffsetPaginationSchema`, `cliCursorPageSchema`, `mutationAckSchema`, `jsonValueSchema`.
- **`@Returns.binary()`** — para resposta binária (blob) no lugar do schema Zod.
- **`@CliOnly()`** — exclui o comando da superfície SDK (comando só-humano).

### 4. Descoberta = automática (NÃO manual)
1. Criar `src/cli/commands/<grupo>.ts` com a classe `@Group`.
2. Rodar `bun run gen:commands` → regenera o barrel `src/cli/commands/index.ts` (auto-gerado, **NÃO editar à mão**).
3. Pronto. `registerCommands` lê os decorators e monta tudo (inclusive enforcement de scope/access). Colisão de `(grupo, comando)` **estoura no boot** — bug pego cedo.

Sem passo de "registrar manifest". A reflexão faz. Verifica com: `ravi tools show <grupo>_<comando>` e `ravi tools manifest`.

### 5. Integração runtime (RAVI_CONTEXT_KEY) — se aplicável
- Pai emite `ravi context issue <cli> --allow <cap> --ttl <dur>` → filho recebe `RAVI_CONTEXT_KEY` (única credencial, formato `rctx_*`).
- CLI valida com `ravi context whoami` / `check <perm> <objType> <objId>`.
- Capability mínima, tempo de vida (TTL) curto, audit completo. (Esta parte a skill antiga já acertava.)

### 6. Spike + testes (GATE — antes de entregar)
Rodar CADA comando com input válido / inválido / faltando. Todos os checks abaixo têm que PASSAR (senão corrigir + re-testar; NUNCA entregar com bug):
- [ ] Output correto com input válido
- [ ] Erro acionável com input inválido (com o próximo comando sugerido)
- [ ] Mensagem de uso com input faltando
- [ ] `--json` retorna JSON válido
- [ ] Exit code correto (`0` sucesso, `1` falha, `2` uso, `3` bloqueio por política)
- [ ] `--help` passa no **gate padrão-ouro** (§5 abaixo)

**A lei do repo = meta-testes de CI** (não o spike manual). O repo tem `json-coverage.test.ts` (todo comando finito DEVE expor `--json`) e `pagination-coverage.test.ts` (todo `list`/`ls` DEVE ser paginado). Teste co-locado em `src/cli/commands/<grupo>.test.ts`, roda em `bun:test` com `mock` + `await import(...)`. Se seu CLI não conformar, **a CI fica vermelha.**

### 7. Entrega (HITL + doc por domínio)
1. Perguntar ao **HITL**: "CLI implementado, testado e descoberto. Disponibilizo pra qual agente?"
2. Documentar o CLI na skill do **DOMÍNIO DE NEGÓCIO**, NUNCA por ferramenta/API. Extrato bancário → skill financeira, nunca "banco-inter".

---

## 4. Output agent-first (regras duras)

- **`stdout` = dado/envelope em JSON. `stderr` = log/progresso e erro textual.** Em
  `--json`, uma falha imprime exatamente um envelope canônico no stdout e nada
  acrescenta `Error:`, stack ou uma segunda renderização.
- **Mandato `--json`** — todo comando finito expõe `--json`, imprime `JSON.stringify(payload, null, 2)` E `return`a o payload. É CI-enforced.
- **Taxonomia = `0/1/2/3`.** `0` sucesso; `1` execução/provider/not-found;
  `2` uso inválido; `3` bloqueio seguro pela política de confirmação. Exit 3 é
  `blocked`, não uma execução `failed`.
- **Falha contratual = `contractFail(...)`.** Passe `op`, código semântico,
  `asJson`, `exitCode` e detalhes acionáveis. Ele lança `ContractError`; CLI, tool e
  gateway/SDK preservam o mesmo envelope e taxonomia. `fail()` é legado e não
  deve nascer em um CLI novo ou em um caminho declarado migrado.
- **Confirmação baseada em risco.** `contractDryRun(...)` + `--execute` só para
  publicação/envio externo, mutação relevante em provider, destruição difícil
  de recuperar, execução disparada ou custo acima de limite conhecido. Escrita
  local/reversível e custo trivial sem estimativa rodam direto.
- **Autorização ≠ confirmação.** Toda operação com efeito usa
  `@CommandAccess({ kind: "mutate" })`, mesmo sem `--execute`; leitura pura usa
  `read`. O dry-run ocorre depois da autorização/validação e antes de qualquer
  DB write, provider, recurso, evento, fila ou worker.
- **Alto sinal** — retorne os campos que informam a próxima ação (`name`, `status`, `url`); corte ruído (`uuid` cru, `mime_type`, `256px_url`) salvo se pedido.
- **IDs semânticos** — resolva UUID pra nome legível no output; melhora a precisão do agente.
- **Erros acionáveis** — RUIM: `Error: EACCES`. BOM: `Invalid priority: X. Use low|normal|high|urgent` — sempre com o COMO corrigir / o próximo comando. Retorne o contexto que o agente gastaria uma chamada pra buscar.

---

## 5. `--help` padrão-ouro (GATE — o contrato completo)

`--help` NÃO é lista de flags — é o **contrato comportamental completo** da CLI,
a fonte única de verdade (SSoT). Um agente sem contexto tem que dirigir a CLI
só lendo o help ("teste do agente cego"). **Bloqueia entrega se falhar.** **O
essencial pra escrever um `--help` padrão-ouro está inline abaixo — esta skill
é standalone.** Aprofundamento opcional (building blocks, tipologias):
`cli-help-engineering`, se disponível.

**Padrão-ouro de referência:** use o excerto autocontido abaixo. Se `sde` estiver
disponível no ambiente, rode `sde tiny pedido-montar-json --help` para comparar
a estrutura completa; a ausência desse CLI externo não bloqueia o uso desta skill.

**Mínimo por comando (todo CLI):**
- [ ] Descrição de 1 linha + Usage com `<obrigatório>`/`[opcional]`
- [ ] Cada flag: curta+longa, `<tipo>`, descrição, **default**, **choices** quando restrito
- [ ] **EXEMPLOS reais copiáveis** (2+) — o sinal mais forte pro agente
- [ ] Nota de output (`--json` + shape) + exit codes

**As 14 seções canônicas** (no `addHelpText('after', ...)` do orquestrador; leitura-pura pode omitir 5-9):
`3. USE` (quando é a escolha certa) · `4. NÃO USE` (+ pointer alternativo) · `5. REGRAS HARD` (constraints que a CLI bloqueia) · `6. HITL OBRIGATÓRIO` · `7. VALIDAÇÕES AUTOMÁTICAS` (ref arquivo:linha) · `8. LIFECYCLE` (estados+transições) · `9. HITL TEMPLATE` (mensagem literal pro humano) · `10. EXAMPLES` · `11. ON ERROR` (código→causa→fix) · `12. PIPELINE` (upstream→esta→downstream) · `13. SEE ALSO` · `14. FORMATO` (datas/IDs/valores) · `15. DEBUG` · `16. FONTES` (datas + path do source).

**Exemplo real de `--help` anotado** (excerto do padrão-ouro `sde tiny pedido-montar-json`). Repara: cada flag carrega `tipo | significado | origem | constraint | default`, e o rodapé traz as seções — não é "lista de flags", é o contrato inteiro:
```
--lista-preco <id>   enum | 629174891="SITE (+39%)" | 601762293="Oficial (+32.25%)" (default: 629174891)
--parcelas <dias>    string | intervalo em DIAS. LIMITE: <R$1k=max 2x, R$1k-3k=3x, >R$3k=4x (default: 4)

CUSTO / SEGURANÇA
  • READ-ONLY: monta o JSON, NÃO submete à API. Idempotente, seguro p/ retry.
  • Destrutivo? NÃO — o passo destrutivo do pipeline é `pedido-incluir`.
USE          ✓ Cliente existe + SKU cadastrado + balcão padrão
NÃO USE      ✗ Item sem cadastro → `pedido-incluir` direto   ✗ Marketplace → CLI dedicada
REGRAS HARD  • Atacado requer subtotal > R$2.000   • Frete=0 + subtotal<R$500 → alerta
```
Seções obrigatórias sempre: `USE`, `NÃO USE`, `EXAMPLES`, `ON ERROR`, `FONTES`.
As de risco (`REGRAS HARD`, `HITL`, `LIFECYCLE`) entram quando o efeito real exige
restrição, confirmação ou explicação de transição — não pela mera existência de escrita.

**Cristalizar a precedência NO --help** (senão agentes divergem em conflito):
```
REGRAS HARD > INPUT HUMANO > CONVENÇÕES > REGRAS AGENTS.MD
```

**Validação empírica (obrigatória):** antes de escrever o --help, rodar `--help` de TODAS as CLIs adjacentes citadas + 1 chamada real à API. Sem isso = nomes inventados + doc-IA-genérica.

---

## 6. Paginação real (contrato do repo)

NÃO é "busca todas as páginas". É paginação **limitada** com próximo passo explícito. Helpers em `src/cli/pagination.ts`:
- `parseCliListLimit` (default **50**, máx **500**), `parseCliListOffset` (default 0)
- `paginateCliItems(items, {limit, offset})` → `{ items, total, limit, offset }`
- `buildCliOffsetPagination({ baseCommand, limit, offset, returned, total })` → monta o `nextCommand`

Shape de retorno real (spike verificado — `ravi agents list --json --limit 2`):
```json
{ "total": 81,
  "pagination": { "limit": 2, "offset": 0, "returned": 2, "total": 81,
                  "hasMore": true, "nextOffset": 2,
                  "nextCommand": "ravi agents list --json --limit 2 --offset 2" },
  "items": [ ... ] }
```
Para sets grandes/temporais use cursor (`src/cli/listing.ts` + `cliCursorPageSchema`). Todo `list`/`ls` precisa de `--limit`+`--offset` OU `--cursor` (CI-enforced).

---

## 7. Anti-patterns (parar e corrigir)

1. **Arquitetura errada** — `program.command()` + `cli-manifest` + `tools cli-register` para um CLI nativo. Não existe. Use decorators + barrel.
2. **Comando sem `@Returns`** — não vira tool tipado do SDK.
3. **Comando finito sem `--json`** ou `list` sem paginação — CI vermelha.
4. **Wrap 1:1 de endpoint de API** como comando — baixo sinal, queima contexto. Consolide fluxos.
5. **Dump de dataset inteiro** — pagine/filtre; não force o agente a ler tudo token-a-token.
6. **ID críptico como output primário** (UUID cru) — degrada retrieval do agente.
7. **Output instável entre versões** (renomear campo JSON, reordenar coluna) — quebra todo consumidor.
8. **`--help` fino/sem exemplo** — falha o teste do agente cego.
9. **Segredo em flag ou env var** — vaza em `ps`/histórico/processos-filho. Use arquivo de credencial / stdin.
10. **`process.exit` cru ou `fail()` legado** num handler novo — quebra a
    paridade entre processo/tool/gateway. Use `contractFail()`/`contractDryRun()`.
11. **Editar o barrel `commands/index.ts` à mão** — é auto-gerado. Rode `gen:commands`.

---

## 8. Skill → CLI: injetar conhecimento no `--help` (ferramenta de anotação)

Quando o CLI existe e tem regra de negócio no source que o `--help` não mostra, migra-se o conhecimento tribal da skill PRA o `--help` — o CLI vira a SSoT e a skill vira **STUB** (triggers + pointer, nunca deletar). Os passos essenciais estão inline abaixo (standalone); aprofundamento opcional: `dissolving-skills-into-cli-help` (validado em 4 skills do jarvis).

**Mecanismo real (anotar o CLI), POR FAMÍLIA:** CLI **nativo Ravi** → setar a string `helpAfter` no `@Command` (o `registry.ts` chama `addHelpText('after', helpAfter)` por baixo). CLI **standalone/commander** → encadear `.addHelpText('after', ...)` direto. Nos dois, escrever as 14 seções canônicas (§5) ali — o `--help` passa a carregar REGRAS HARD, HITL template literal, lifecycle e error mapping, não só flags.

**Classificar cada pedaço da skill em 5 buckets:** **A** → AGENTS.md (roteamento/triggers) · **B** → `--help` do orquestrador (regras hard, HITL, lifecycle) · **C** → `--help` dos subcomandos (regras locais, formato) · **D** → profile de task (dispatch denso) · **E** → vault (knowledge denso, multi-fase).

**Sequência operacional (o processo completo, condensado):**
1. **ANTES:** rodar o `--help` atual (baseline) + rodar o CLI com args reais (ver o JSON de output) + ler a skill inteira + classificar cada item nos 5 buckets + rodar `--help` de TODAS as CLIs que vai citar (cross-CLI empírica — **zero invenção de nome**).
2. **APPLY:** backup do source (nativo: `git stash`/branch; standalone: `cp index.ts index.ts.bak-<ts>`) → localizar o comando (nativo: método `@Command`; standalone: `program.command('<nome>')`) → migrar buckets **B+C** pro help (nativo: string `helpAfter`; standalone: `addHelpText('after', ...)`) escrevendo as 14 seções → validar que `--help` renderiza **E** o CLI ainda executa.
3. **PÓS:** skill vira **STUB** (mantém triggers + pointer, nunca deletar) → AGENTS.md aponta `→ TODAS regras em <cli> --help` → **simulação real**: operador monta 1 output completo só com o `--help`, sem a skill → archive a skill (só após simulação verde) → delete definitivo **SÓ com "sim" explícito do HITL** (ação destrutiva).

**Fecha o triângulo:** `cli-creator` (constrói) → `cli-help-engineering` (método do `--help`) → `dissolving-skills-into-cli-help` (injeta o conhecimento como anotação). AGENTS.md do operador aponta: `→ TODAS regras em <cli> --help`.

---

## LEMBRETE FINAL
1. **Mapa antes de código, apresentado ao HITL** — genérico, nunca uma pessoa fixa. NUNCA implementar sem aprovação.
2. **Contrato real = decorators + `@Returns` + `@CommandAccess` + `bun run gen:commands`.** Esqueça manifest/register manual — é ficção pro CLI nativo.
3. **`--json` + paginação + `--help` padrão-ouro são gates de CI/entrega**, não opcionais. Cada um foi spike-testado no código vivo.
4. **Taxonomia, confirmação e transportes vêm de `.ravi/specs/cli/`.** Não
   redefina o contrato por domínio nem aplique `--execute` por verbo.
