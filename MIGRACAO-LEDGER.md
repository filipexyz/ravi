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
| 7 | whatsapp | group.ts, whatsapp-dm.ts | whatsapp | **MIGRADO** | cli/whatsapp |
| 8 | mail | mail.ts, gmail.ts | (sem skill — lacuna registrada na spec) | **MIGRADO** | cli/mail |
| 9 | calendar | calendar.ts | (sem skill — lacuna registrada na spec) | **MIGRADO** | cli/calendar |
| 10 | chats | chats.ts | (sem skill — lacuna registrada na spec) | **MIGRADO** | cli/chats |
| 11 | projects | projects.ts | projects | **MIGRADO** | cli/projects |
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

### 8. mail — MIGRADO (subagente, verificado e integrado)

**Escopo:** freio (`--execute`) em `mail send`, `mail reply`,
`mail providers ravi-mail send` e `gmail send` (e-mail externo irreversível;
plan com from/to/subject/bodyPreview de 120 chars — corpo nunca completo; no
gmail o freio vem ANTES até do resolve do connector). Sem freio (declaradas):
accounts create/sync, mailboxes create/disable, messages import, outbox retry
(o freio mora no enqueue; retry re-enfileira payload já autorizado), domains e
providers config. Codes: ACCOUNT/MAILBOX_NOT_FOUND com suggestions (DB local);
MESSAGE/OUTBOX/THREAD_NOT_FOUND sem suggestions (ULIDs opacos) com
suggestedAction de listagem. Wrapper `readMailMessageForContract` (serviço
lança). **Rethrow crítico**: `runMailCommand`/`runGmailCommand` rethrowam
ContractError antes do funil legado CloudAuthError. `--fields` em 5 listagens.
Usage contract nos subtrees `mail` e `gmail`.

**Também neste commit:** `src/test/ravi-state.ts` endurecido contra EBUSY do
Windows (Bun mantém handles mmap de WAL/SHM até GC — oven-sh/bun#25964):
`Bun.gc(true)` + retry no rm + try/catch no sweep de exit. Benefício para toda
a suíte win32 (menos falhas ambientais que a baseline — permitido; a régua é
zero falhas NOVAS). Companheiros WHY/RUNBOOK/CHECKS criados para o spec root
`mail` (dívida pré-existente que reprovava o gate ao tocar o SPEC.md
consumidor). Known Failure Mode registrado: funil legado CloudAuthError pode
sair exit 3 para PAYLOAD_INVALID (mapa de exits pré-existente do cloud-auth,
declarado como dívida).

**Rotina X:** typecheck limpo · `mail.test.ts` 18/18 (11 de contrato; 3 call
sites com execute) · spec gate PASSED (cli/mail + mail + mail/local-mailbox).
**Rotina Y (estado isolado):** accounts/mailboxes create → `send` sem
`--execute` → exit 3 + plan (bodyPreview) · `send --execute` → `queued:true` +
outbox com 1 entrada · MAILBOX_NOT_FOUND exit 1 · usage exit 2 · sintaxe errada
de accounts create → USAGE_ERROR exit 2 (o contrato ensinou a correção).

### 7. whatsapp — MIGRADO (subagente, verificado e integrado)

**Escopo (domínio de maior risco externo — pessoas/grupos REAIS):** freio
(`--execute`) em 13 ops: `group send/create/add/remove/promote/demote/
revoke-invite/rename` + 4 descobertas mal-declaradas como `kind:"read"` mas
mutantes na prática (`join/leave/description/settings` — freadas SEM flipar o
CommandAccess, que alimenta autorização de agentes existentes; pendência
registrada na spec) + `dm send`. Freio ANTES de qualquer chamada de
provider/NATS: em `group send` antes até da leitura de metadata; em
`group create` antes do `ensureGroupAgent` (dry-run com `--create-agent` não
cria agent nem diretório), com pré-validação de agent para o plan nunca
prometer rota a agent inexistente. Sem freio (declaradas): `group list/info/
invite` (leituras), `dm read/ack`. `GROUP_NOT_FOUND` (suggestions da própria
listagem já resolvida — zero chamadas extras) e `CONTACT_NOT_FOUND` (DB local).
`--fields` em `group list` e `dm read`. Usage contract no subtree `whatsapp`.

**Consumidores atualizados neste commit:** skill whatsapp (Contrato Do CLI),
skills agents/architect (hunks mistos com instances entram aqui),
prompt-builder (hints de group create/dm send), docs/guides/whatsapp-groups.mdx
(~25 exemplos), docs/cli/overview.mdx (hunks instances+whatsapp). NÃO editado
(path de coverage-gate): hint sentinel em `src/omni/consumer.ts:1551` ensina
`whatsapp dm send` sem `--execute` — registrado como pendência na spec.

**Testes criados do zero:** `group.test.ts` 22/22 (dry-run sem chamada ao spy
nas 13 ops; execute chamando; not-founds; --fields; ack sem freio; validações
pré-freio). Typecheck limpo. **Rotina Y (estado isolado):** `dm send` sem
`--execute` → exit 3 + plan com JID resolvido · `group send` → validação
pré-freio correta ("No WhatsApp account configured", exit 1 — sem conta no
estado isolado; freio provado nos testes) · usage → exit 2. Nota de
concorrência: o `git stash` que reverteu o tree na onda era deste fluxo
(verificação de baseline); tudo restaurado e revalidado.

### 9. calendar — MIGRADO (subagente, verificado e integrado)

**Escopo:** freio (`--execute`) em `calendars share` (expõe agenda a outro
subject), `calendars events cancel` (irreversível para participantes quando um
adapter entregar o outbox) e `calendars events respond` (endereçado ao
organizador). **Veredito create/update (inspecionado):** hoje só gravam SQLite
local + linha de outbox `acked` para provider local; NÃO existe adapter de
entrega nem consumidor do outbox — logo SEM freio, revisitar quando um adapter
de provider-sync for implementado (documentado na tabela de classificação).
Sem freio (declaradas): sources create/sync, calendars create/disable, outbox
retry. `CALENDAR_NOT_FOUND` (suggestions de `visibleCalendars()` — já filtrado
por permissão), `SOURCE_NOT_FOUND` (accounts locais); `EVENT/OUTBOX_NOT_FOUND`
sem suggestions (janela temporal/ids opacos). `runCalendarCommand` rethrowa
ContractError antes do wrapping legado CloudAuthError. `--fields` em 5
listagens. Usage contract no subtree `calendars`. Spec pré-existente
`cli/calendar` ATUALIZADA (sem duplicata; draft→active); consumidor
`.ravi/specs/calendar/SPEC.md` ensina `--execute` (root calendar tem os 4
companheiros — gate PASSED).

**Rotina X:** typecheck limpo · `calendar.test.ts` 11/11 (dry-run verificado
NO DB: sem member/outbox/status gravados; era 1 pass/5 fail em HEAD nesta
máquina por EBUSY — o hardening do ravi-state + complemento resolveu) ·
`src/calendar/{db,access}.test.ts` verdes · spec gate PASSED · SDK regenerado
(regen único fecha a onda instances/whatsapp/mail/calendar) · build ok.
**Rotina Y (estado isolado):** `share cal-fantasma` → CALENDAR_NOT_FOUND exit 1
· flags erradas → USAGE_ERROR exit 2 com acceptedFlags (o envelope ensinou a
sintaxe correta em 2 iterações — dogfooding real) · `list --fields` ok · freio
do share provado nos testes com verificação de DB.

### 10. chats — MIGRADO (subagente, verificado e integrado)

**Escopo:** freio (`--execute`) em `chats lists remove` (derruba chat de fila
de leitura viva; validação de list+chat ANTES do freio). Equivalentes
pré-existentes documentados, não renomeados: `backfill-provider-timestamps`
(`--apply` default-dry-run) e `lists recompute` (guardado por `lists preview` +
gate de selector inseguro). Sem freio (declaradas): ensure e messages create
(idempotentes por clientRequestId), lists create/add/mark-read, delta
--mark-read. Codes: `CHAT_NOT_FOUND` (suggestions da mesma superfície do list),
`READING_LIST_NOT_FOUND` (suggestions respeitando o filtro --owner),
`CONTACT_NOT_FOUND` SEM suggestions (chats não reproduz o contactScope barato —
aponta contacts list). Rethrow de ContractError no resolveReadingList.
`--fields` em 3 listagens. Usage contract no subtree (`chats` no index).
Failure mode documentado: `chats messages` delega para `read` e o envelope
reporta `op: "chats read"`.

**Rotina X:** `chats.test.ts` 24/24 (7 de contrato; usa runWithContext como o
resto do arquivo — sem mock de context) · regressão colateral verificada
(registry-snapshot 16 pass, canonical-chat 2 pass) · typecheck do domínio limpo
(erros transitórios em pages.ts eram WIP do agente paralelo) · spec gate PASSED
(cli/chats + channels/chats/reading-lists consumidor). **Rotina Y:** `read
chat-fantasma --json` → CHAT_NOT_FOUND exit 1 · subcomando inexistente → usage
exit 2 do subtree · `list --fields id,title` ok.

### 11. projects — MIGRADO (subagente, verificado e integrado)

**Escopo:** freio (`--execute`) em `projects tasks dispatch` (execução real de
agente — análogo de tasks dispatch; plan com defaults resolvidos),
`projects workflows start` (instancia run real), `projects fixtures seed`
(destrutivo — reset+resemeia) e `projects resources import` (ingestão em massa;
locators normalizados/deduplicados no plan). Sem freio (declaradas): init,
create, update, link, workflows attach, tasks create/attach, resources add.
Codes: `PROJECT_NOT_FOUND` (suggestions de listProjects — sem filtro de
visibilidade, mesma fonte do list; not-found VENCE o freio, testado),
`WORKFLOW_RUN/NODE_NOT_FOUND`, `TASK_NOT_FOUND` (via surface),
`RESOURCE_NOT_FOUND` (suggestions do próprio project). 16 catches legados
migrados com rethrow de ContractError. `--fields` em list/next/resources list.
Usage contract no subtree (`projects` no index).

**Nota:** 2 expectativas de teste legadas com path POSIX hardcoded
(`/workspace/ravi.bot` vs resolve win32) corrigidas para
`resolve("/workspace/ravi.bot")` — agnóstico de plataforma, mesmo valor no CI
Linux; falha era pré-existente determinística no Windows, fora da lista da
baseline (a cadeia aborta antes).

**Rotina X:** `projects.test.ts` 25/25 (+9 de contrato) · typecheck limpo ·
spec gate PASSED (cli/projects) · skill projects com `## Contrato Do CLI`.
**Rotina Y:** `show proj-fantasma` → exit 1 · usage → exit 2.
