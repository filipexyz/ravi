# MIGRACAO-LEDGER — Contrato agent-first nos CLIs nativos

Registro por domínio da migração do contrato agent-first (Manual v2), portado do
piloto `crm` validado por benchmark de 270 execuções.

**Contrato aplicado por domínio migrado:**
1. Envelope de erro em `--json`: `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Taxonomia de exit codes: `0` ok · `1` erro de execução/not-found/provider · `2` usage error · `3` bloqueado por política (freio de escrita — não é erro).
3. Freio de escrita nas mutações de maior risco: dry-run por default + `--execute` (helpers em `src/cli/agent-contract.ts`). Ops com freio pré-existente (`--apply` default-dry-run, `--dry-run`, `--confirm`) são documentadas como equivalentes, não renomeadas.
4. `--fields a,b,c` nas listagens migradas.
5. Usage errors do parser commander → exit 2 + envelope, via `installUsageContract(program, "<dominio>")` (escopado ao subtree; domínios não migrados intactos).
6. SPEC normativa em `.ravi/specs/cli/<dominio>/` (SPEC + WHY + RUNBOOK + CHECKS) e SKILL atualizada no mesmo commit (análise bidirecional CLI↔SKILL).

**Régua de testes:** zero falhas novas vs baseline virgem (145 pass / 110 fail
de fábrica, todos Slack/channels, Windows 2026-08-06).

---

## Status por domínio

| # | Domínio | Arquivos CLI | Skill | Status | Spec |
|---|---------|--------------|-------|--------|------|
| 1 | crm | crm.ts | crm | **MIGRADO** | cli/crm |
| 2 | tasks | tasks.ts, tasks-deps.ts, tasks-profiles.ts, tasks-automations.ts | tasks (+tasks-manager alias) | **MIGRADO** | cli/tasks |
| 3 | sessions | sessions.ts, sessions-runtime.ts, session-followups.ts | sessions | **MIGRADO** | cli/sessions |
| 4 | contacts | contacts.ts | contacts | **MIGRADO** | cli/contacts |
| 5 | agents | agents.ts | agents | **MIGRADO** | cli/agents |
| 6 | instances+routes | instances.ts | instances, routes | **MIGRADO** | cli/instances |
| 7 | whatsapp | group.ts, whatsapp-dm.ts | whatsapp | pendente | — |
| 8 | mail | mail.ts, gmail.ts | (sem skill) | pendente | — |
| 9 | calendar | calendar.ts | (sem skill) | pendente | — |
| 10 | chats | chats.ts | (sem skill) | pendente | — |
| 11 | projects | projects.ts | projects | pendente | — |
| 12 | artifacts | artifacts.ts | artifacts | pendente | — |
| 13 | skills+skill-gates | skills.ts, skill-gates.ts | skills, skill-gates | pendente | — |
| 14 | cron | cron.ts | cron | pendente | — |
| 15 | triggers | triggers.ts | triggers | pendente | — |
| 16 | tags+tag-rules | tags.ts, tag-rules.ts | tag-rules | pendente | — |
| 17 | observers | observers.ts | observers | pendente | — |
| 18 | workflows | workflows.ts | (sem skill) | pendente | — |
| 19 | watch | watch.ts | (sem skill) | pendente | — |
| 20 | hooks | hooks.ts | (sem skill) | pendente | — |
| 21 | heartbeat | heartbeat.ts | heartbeat | pendente | — |
| 22 | threads | threads.ts | (sem skill) | pendente | — |
| 23 | inbox | inbox.ts | (sem skill) | pendente | — |
| 24 | work-objects | work-objects.ts | (sem skill) | pendente | — |
| 25 | commands | commands.ts | commands | pendente | — |
| 26 | settings | settings.ts | settings | pendente | — |
| 27 | self | self.ts | (sem skill) | pendente | — |
| 28 | feedback | feedback.ts | (sem skill) | pendente | — |
| 29 | rules | rules.ts | ravi-rules (dev) | pendente | — |
| 30 | specs | specs.ts | specs | pendente | — |
| 31 | stickers | stickers.ts | stickers | pendente | — |
| 32 | react | react.ts | stickers (compartilhada) | pendente | — |
| 33 | pages | pages.ts | (sem skill) | pendente | — |
| 34 | youtube | youtube.ts | (sem skill) | pendente | — |
| 35 | prox-calls | prox-calls.ts | prox-calls | pendente | — |
| 36 | meetings | meetings.ts | meetings | pendente | — |
| 37 | devin | devin.ts | (sem skill) | pendente | — |
| 38 | slack | slack.ts | slack | pendente | — |
| 39 | media/image/audio/video/transcribe | media.ts, image.ts, audio.ts, video.ts, transcribe.ts | audio, image, video | pendente | — |
| 40 | costs/metrics/insights | costs.ts, metrics.ts, insights.ts | (sem skill) | pendente | — |
| 41 | context+runtime | context.ts, runtime-credentials.ts, runtime-presets.ts | context-cli (dev) | pendente | — |
| 42 | credentials/connectors/bridges | credentials.ts, connectors.ts, bridges.ts | (sem skill) | pendente | — |
| 43 | cloud | cloud-projects.ts, cloud-scope.ts | (sem skill) | pendente | — |
| 44 | sync | sync.ts | (sem skill) | pendente | — |
| 45 | channels | channels.ts, channel-backend.ts | channels | pendente | — |

### Dispensados (sem superfície de agente)

| Domínio | Justificativa |
|---------|---------------|
| setup | Wizard interativo humano (prompts); sem `--json`; agente nunca invoca |
| update | Auto-update do binário + restart de processos; infra humana |
| daemon | Ciclo de vida de processo/serviço de SO; `run`/`dev` são foreground sem payload |
| service | Sobe processos/TUI em foreground; `--json` declara `supported:false` |
| doctor | Diagnóstico humano/CI com semântica própria de exit (pass/warn/fail) já estabelecida |
| cloud-auth (login/whoami/logout) | Fluxo OAuth interativo de browser + polling |
| sdk + sdk-returns | Dev tooling de build-time (codegen, ledger de schemas); não é runtime de agente |
| adapters | Snapshot de debug read-only para desenvolvimento |
| events | Stream ao vivo ilimitado; não é payload delimitado |
| tools | Introspecção do próprio registry (dev) |
| db | Infra de locks/WAL do SQLite local; `prune` já tem `--dry-run` |
| apps | Scaffolding/dev tooling; o help-por-op do router builtin foi entregue no commit do crm |
| eval | Harness de avaliação (dev) |

---

## Entradas detalhadas

### 1. crm — MIGRADO (commit deste ledger)

**Escopo:** porte do piloto `ravi-pr:feat/agent-first-contract` (base idêntica
`def9a763`, blobs verificados por hash). Helpers generalizados de
`crm-contract.ts` (piloto) para `src/cli/agent-contract.ts` neutro
(`contractFail`, `contractDryRun`, `installUsageContract(program, domain)`,
`suggestSimilar`, `pickFields`) — domínios seguintes reutilizam sem duplicação.
Freio em `pipeline create`, `opportunity create`, `opportunity move`; `--fields`
em `board`, `actions`, `contacts list`, `pipeline list`; sugestões em
`PIPELINE_NOT_FOUND`/`OPPORTUNITY_NOT_FOUND`; usage contract no subtree `crm`;
help-por-op no builtin `apps.help` do router de apps. SDK regenerado via
`bun run sdk:generate` (não copiado do piloto).

**Rotina X:** `bun run typecheck` limpo · `bun test src/cli/commands/crm.test.ts`
22/22 · `src/apps/router.test.ts` 3 testes novos do help-por-op passam; 13 falhas
restantes são ambientais Windows (EBUSY/ECONNREFUSED:4222/path) — nomes idênticos
ao estado virgem, verificado por diff · `src/channels/runtime-events.test.ts`
16 falhas com nomes idênticos à baseline (init do router não ficou eager) ·
`bun run sdk:generate` + `sdk:check` "artifacts are current" · `bun run build` ok.

**Rotina Y (CLI local, `RAVI_STATE_DIR` isolado):**
- `crm pipeline list --json` → paginação + items, exit 0.
- `crm pipeline show inexistente --json` → envelope `PIPELINE_NOT_FOUND` com 2 `suggestions` reais, exit 1.
- `crm pipeline create "Funil Teste" --json` → `WRITE_REQUIRES_EXECUTE`, `dryRun:true`, `plan`, exit 3; `pipeline list` confirmou **nada escrito**.
- `crm pipeline create "Funil Teste" --execute --json` → `status:"created"`, exit 0.
- `crm board --flag-inexistente --json` → `USAGE_ERROR` + `acceptedFlags`, exit 2.
- `crm opportunity show` (sem arg, modo texto) → ensina `usage:` + `accepted flags:`, exit 2.
- `crm opportunity create --help` → 20 linhas (enxuto).

**CLI↔SKILL:** skill reescrita (−60%, doutrina de domínio + `## Contrato Do CLI`
com envelope/taxonomia/freios explícitos COM e SEM freio/`--fields`/help-por-op).
Conferido: freios listados = freios implementados; exceção do `help <op>` em
grupos com posicional documentada.

**Spec:** `.ravi/specs/cli/crm/` (4 arquivos) — `bun src/ci/run-quality-gate.ts`
com CHANGED_FILES: **Spec gate PASSED** (221 specs indexadas). Correções vs
piloto: `applies_to` aponta `src/cli/agent-contract.ts` (piloto apontava path
inexistente) e `owners: ravi-dev` (piloto vazio).

### 2. tasks — MIGRADO

**Escopo:** primeira migração from-scratch usando `src/cli/agent-contract.ts`.
Freio (`--execute`) em `tasks dispatch` (high — dispara execução real de agente),
`tasks deps rm` e `tasks automations rm` (destrutivos); demais escritas
declaradas sem freio na spec e na skill. `TASK_NOT_FOUND` com sugestões em
`show`/`dispatch` via `getTaskDetailsForContract` (o `getTaskDetails` real LANÇA
em id desconhecido — checar `details.task === null` era código morto).
`--fields` em `tasks list`. Usage contract instalado no subtree `tasks`
(`AGENT_CONTRACT_DOMAINS` em `src/cli/index.ts`). Flags novas sempre como ÚLTIMO
parâmetro (`@Option`) para não deslocar posicionais nos testes existentes.

**Correção estrutural (beneficia todos os domínios):** o catch do dispatcher em
`src/cli/registry.ts` achatava `ContractError` lançado em contexto de agente
(envs `RAVI_*` presentes → `hasContext()` true → throw) para `Error: ...` +
exit 1 — o freio ficava invisível exatamente para chamadas de agente. O catch
agora preserva `ContractError.exitCode` (1/2/3) sem reimprimir o envelope.
Gap presente no piloto; descoberto na Rotina Y deste domínio.

**Rotina X:** typecheck limpo · `tasks.test.ts` 47/47 (43 existentes + 4 de
contrato: TASK_NOT_FOUND+suggestions, dispatch dry-run sem despachar, deps rm
dry-run sem remover, `--fields` no list) · `registry.test.ts` + `crm.test.ts` +
`tasks.test.ts` = 78/78 · `json-coverage`/`pagination-coverage` passam ·
`tasks-profiles.test.ts` 3 falhas EBUSY de cleanup Windows — pré-existentes,
verificadas idênticas no estado virgem via stash (não estão na lista da
baseline porque a cadeia do `bun run test` aborta em `src/channels/` antes de
chegar aos cli-commands) · `sdk:generate` + `sdk:check` current.

**Rotina Y (CLI local, `RAVI_STATE_DIR` isolado):**
- `tasks list --json --fields id,title` → paginação, exit 0.
- `tasks show tsk-nope --json` → envelope `TASK_NOT_FOUND`, exit 1.
- `tasks list --flag-inexistente --json` → `USAGE_ERROR` + acceptedFlags, exit 2.
- `tasks automations add` → `rm` sem `--execute` → exit 3 + plan, automação AINDA listada → `rm --execute` → `status:"deleted"`, lista vazia.
- Prova de contexto de agente: `RAVI_AGENT_ID=prova crm pipeline create --json` → envelope + **exit 3** (antes da correção do registry: exit 1).
- `tasks dispatch --help` → 25 linhas (enxuto). Freio do dispatch coberto por teste unitário (criar task real fora de sessão exige `--report-to` com sessão existente; sem daemon não há sessões).

**CLI↔SKILL:** skill `tasks` ganhou `## Contrato Do CLI` (5 blocos, freios COM e
SEM listados) + exemplo do dispatch com `--execute` + checklist; `tasks-manager`
(deprecada) não ensina sintaxe — sem mudança.

**Testes de parser por domínio:** cobertos genericamente em `crm.test.ts`
(árvore commander real); `tasks.test.ts` mocka decorators, então testa o
contrato no corpo do comando. Decisão registrada.

### 3. sessions — MIGRADO

**Escopo:** freio (`--execute`) só nos ops irrecuperáveis — `reset` (contexto),
`delete` (permanente), `delete-message`/`edit-message` (mutação irreversível no
canal). Loop de mensagens (`send/ask/answer/inform/execute`) deliberadamente SEM
freio (fricção em cada coordenação); `prune` mantém o dry-run nativo rico
(candidatos, exit 0) como exceção declarada — é a origem do padrão `--execute`.
`SESSION_NOT_FOUND` **sem suggestions por segurança**: o isolamento de escopo
mascara sessão não-autorizada como not-found; sugerir nomes reais permitiria
enumeração entre escopos. `MESSAGE_NOT_FOUND` em delete/edit-message.
`--fields` em `sessions list`. Usage contract no subtree.

**Consumidores atualizados no mesmo commit** (ensinavam comando freado sem
`--execute`): hint builders de session actions em `sessions.ts`
(`build*DeleteMessageCommand`/`build*EditMessageCommand` — consumidos por
agentes vivos), aviso de TTL efêmero em `src/ephemeral/runner.ts`, e orientação
do `src/prompt-builder.ts`. Nenhum desses paths dispara o coverage gate.

**Rotina X:** typecheck limpo · `sessions.test.ts` 49/49 (5 testes de contrato
novos + 1 call site existente de edit/delete-message atualizado + asserts dos
hint builders) · `sessions-runtime.test.ts` 4/4 · `prompt-builder.test.ts` 19/19 ·
`sessions-trace.test.ts` (5) e `session-followups.test.ts` (5) falham EBUSY
Windows — pré-existentes, verificados idênticos no virgem via stash ·
arquivos de teste do CLI rodam um-a-um (mock.module vaza entre arquivos no
mesmo processo bun; é por isso que `test:cli-commands` usa loop) ·
`sdk:generate`/`sdk:check` current.

**Rotina Y (`RAVI_STATE_DIR` isolado):** `info ghost --json` → SESSION_NOT_FOUND
sem suggestions, exit 1 · sessão criada via `send -a main` (send falha sem
daemon, criação persiste) · `reset` sem `--execute` → exit 3 + plan · `delete`
sem `--execute` → exit 3 (sessão ainda resolvia) · `delete --execute` →
`changed:true`, lista vazia depois · `list --flag-inexistente --json` →
USAGE_ERROR exit 2 · `delete --help` → 12 linhas · `list --fields name,agentId`.

**CLI↔SKILL:** skill `sessions` ganhou `## Contrato Do CLI` (com a explicação do
not-found sem suggestions), exemplos de reset/delete com `--execute` e nota de
dry-run; anti-pattern do delete atualizado.

### 5. agents — MIGRADO (migração executada por subagente, verificada e integrada)

**Escopo:** freio (`--execute`) em `agents delete` (destrutivo), `agents reset`
(contexto de sessões irrecuperável; cobre `reset <id>`, `<sessionKey>` e `all`)
e `agents permissions` quando MUDA perfil (autoridade de runtime; a forma
read-only continua exit 0 sem freio; validação de perfil inválido PRECEDE o
freio). Sem freio (declaradas): create, set, sync-instructions, debounce,
spec-mode. `AGENT_NOT_FOUND` (exit 1) com suggestions filtradas por
`filterVisibleAgents` (mesmo cloak do list) em 10 ops. `--fields` no list.
Usage contract no subtree (`agents` adicionado a AGENT_CONTRACT_DOMAINS).
Decisão estrutural: o try/catch legado do delete achataria ContractError —
resolve/freio movidos para fora do try (registrado no spec).

**Consumidores atualizados:** hints internos de permissions em agents.ts,
`docs/cli/overview.mdx`, skill `architect` (receita inversa), e **AGENTS.md**
(10 linhas ensinando reset/permissions agora com `--execute` — feito pelo
integrador, fora do escopo do subagente).

**Rotina X:** typecheck limpo · `agents.test.ts` 39/39 (8 testes de contrato) ·
spec gate PASSED (cli/agents). **Rotina Y (estado isolado):** show fantasma →
AGENT_NOT_FOUND + suggestions reais, exit 1 · create + delete sem `--execute` →
exit 3 + plan · delete `--execute` → `changed:true` · usage → exit 2 · list
`--fields id`. SDK: regenerado no commit seguinte da onda (contacts) — regen
único cobre as flags das duas migrações paralelas.

### 4. contacts — MIGRADO (migração executada por subagente, verificada e integrada)

**Escopo:** freio (`--execute`) em `contacts remove` (destrutivo), `contacts
block` (silencia peer vivo) e `contacts merge` (irreversível — move identidades
e apaga o source; plan traz source/target/identitiesToMove). `backfill` mantém
o freio pré-existente `--apply` (documentado como equivalente, não renomeado).
Sem freio (declaradas): add, allow, approve, set, tag/untag, link/unlink, note,
metadata set/remove. `CONTACT_NOT_FOUND` (exit 1) em mutações e leituras, com
**suggestions vindas exclusivamente de `filterVisibleContacts`** (mesmo filtro
do contactScope own/tagged/all — cloak anti-enumeração preservado). Wrapper
`rethrowContactCommandError` para as rotas em que o SERVIÇO lança
`Contact not found` dentro de try/catch legado (note/metadata/link). Not-founds
"macios" (`get` found:false exit 0; `remove` not_found exit 0) convertidos para
envelope exit 1 — mudança de comportamento declarada no WHY. `--fields` em
`list` (items+contacts) e `find`. Usage contract no subtree.

**Consumidores atualizados:** docs/cli/overview.mdx, docs/guides/contacts.mdx
(5 blocos), hint do `contacts pending`, hint na skill agents.

**Rotina X:** typecheck limpo · `contacts.test.ts` 18/18 (9 de contrato; spies
deleteContact/blockContact; call site do merge com execute) · spec gate PASSED
(cli/contacts) · `sdk:generate`+`sdk:check` current (regen único da onda
agents+contacts). **Rotina Y (estado isolado):** add → `get` de número
inexistente → CONTACT_NOT_FOUND + suggestions visíveis, exit 1 · `remove` sem
`--execute` → exit 3 + plan com o contato resolvido · `remove --execute` →
`status:"removed"`, list vazio depois · usage → exit 2 · `list --fields`.

### 6. instances+routes — MIGRADO (subagente, verificado e integrado)

**Escopo:** freio (`--execute`) em `instances delete` (destructive; plan inclui
`restoreCommand`), `instances routes remove` (re-roteia tráfego vivo; freio
DEPOIS de `assertInstanceMutationRuntime` — frear antes esconderia split de
runtime atrás do exit 3) e `instances pending reject` (sem caminho de restore).
Sem freio (declaradas): create, set, enable, disable, restore, disconnect,
connect (QR interativo), routes add/set/restore, pending approve.
`INSTANCE_NOT_FOUND` (suggestions de nomes+omni ids — instâncias não têm cloak
por agente, só filtro por tag) e `ROUTE_NOT_FOUND` (suggestions de patterns da
instância). Decisão preservada: `instances disable` de alvo desconhecido é o
fluxo de ignore de omni id, NÃO not-found. `--fields` nos dois lists. Usage
contract nos subtrees `instances` e `routes`.

**Consumidores:** docs/guides/instances.mdx, docs/plan-instances.md,
docs/start/configuration.mdx (este commit); docs/cli/overview.mdx e skill
architect têm hunks mistos com o domínio whatsapp e entram no commit do
whatsapp. AGENTS.md: zero ocorrências dos freados.

**Rotina X:** typecheck limpo · `routes.test.ts` 20/20 (10 de contrato) · spec
gate PASSED (cli/instances). **Rotina Y (estado isolado):** show fantasma →
INSTANCE_NOT_FOUND exit 1 · create + delete sem `--execute` → exit 3 + plan com
restoreCommand · delete `--execute` → `status:"deleted"` · usage exit 2 ·
`list --fields name`. Incidente de concorrência registrado: um stash de agente
paralelo reverteu temporariamente o working tree; trabalho recuperado de
stash@{0} e revalidado (stash mantido até o fim da onda como segurança).
