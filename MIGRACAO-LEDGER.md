# MIGRACAO-LEDGER — Contrato agent-first nos CLIs nativos

Registro por domínio da migração do contrato agent-first (Manual v2), portado do
piloto `crm` validado por benchmark de 270 execuções.

> **Leitura atual:** as entradas detalhadas e a FASE 2 abaixo são snapshots
> históricos da execução. Afirmações posteriormente invalidadas não são a
> verdade vigente. A fonte normativa é `.ravi/specs/cli/SPEC.md`; o estado
> atual, as regressões reconhecidas e a nota de compatibilidade estão na
> **FASE 4** ao final deste arquivo.

**Contrato aplicado por domínio migrado:**
1. Envelope de erro em `--json`: `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Taxonomia de exit codes: `0` ok · `1` erro de execução/not-found/provider · `2` usage error · `3` bloqueado por política (freio de escrita — não é erro).
3. Freio de escrita nas mutações de maior risco: dry-run por default + `--execute` (helpers em `src/cli/agent-contract.ts`). Ops com freio pré-existente (`--apply` default-dry-run, `--dry-run`, `--confirm`) são documentadas como equivalentes, não renomeadas.
4. `--fields a,b,c` nas listagens migradas.
5. Usage errors do parser commander → exit 2 + envelope, via `installUsageContract(program, "<dominio>")` (escopado ao subtree; domínios não migrados intactos).
6. SPEC global normativa em `.ravi/specs/cli/SPEC.md`; specs por domínio em `.ravi/specs/cli/<dominio>/` classificam operações, exceções e checks próprios sem redefinir o contrato global.

**Régua histórica:** comparação por identidade com a baseline virgem (145 pass
/ 110 fail de fábrica, todos Slack/channels, Windows 2026-08-06). A conclusão
provisória de "zero falhas novas" da FASE 2 foi invalidada pela CI e pela
revisão de processo; a FASE 3 registra as regressões e os gates atuais.

---

## Status por domínio

Nesta tabela, **MIGRADO** significa que o escopo descrito na entrada da entrega
foi migrado; não significa que todo handler legado do domínio já satisfaz o
contrato. Limitações explícitas na spec do domínio continuam válidas até seus
checks passarem.

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
| 12 | artifacts+pages | artifacts.ts, pages.ts | artifacts (pages sem skill — lacuna registrada) | **MIGRADO** | cli/artifacts, cli/pages |
| 13 | skills+skill-gates | skills.ts, skill-gates.ts | skills, skill-gates | **MIGRADO** | cli/skills, cli/skill-gates |
| 14 | cron | cron.ts | cron | **MIGRADO** | cli/cron |
| 15 | triggers | triggers.ts | triggers | **MIGRADO** | cli/triggers |
| 16 | tags+tag-rules | tags.ts, tag-rules.ts | tag-rules (tags sem skill — lacuna registrada) | **MIGRADO** | cli/tags, cli/tag-rules |
| 17 | observers | observers.ts | observers | **MIGRADO** | cli/observers |
| 18 | workflows | workflows.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/workflows |
| 19 | watch | watch.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/watch (atualizada) |
| 20 | hooks | hooks.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/hooks |
| 21 | heartbeat | heartbeat.ts | heartbeat | **MIGRADO** | cli/heartbeat |
| 22 | threads | threads.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/threads |
| 23 | inbox | inbox.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/inbox (atualizada) |
| 24 | work-objects | work-objects.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/work-objects |
| 25 | commands | commands.ts | commands | **MIGRADO** | cli/commands |
| 26 | settings | settings.ts | settings | **MIGRADO** | cli/settings |
| 27 | self | self.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/self |
| 28 | feedback | feedback.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/feedback |
| 29 | rules | rules.ts | ravi-rules (dev) | **MIGRADO** | cli/rules |
| 30 | specs | specs.ts | specs | **MIGRADO** | cli/specs |
| 31 | stickers | stickers.ts | stickers | **MIGRADO** | cli/stickers |
| 32 | react | react.ts | stickers (compartilhada) | **MIGRADO** (sem freio — veredito) | cli/react |
| 33 | pages | pages.ts | — | **MIGRADO** (junto com artifacts, entrada 12) | cli/pages |
| 34 | youtube | youtube.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/youtube |
| 35 | prox-calls | prox-calls.ts | prox-calls | **MIGRADO** | cli/prox-calls |
| 36 | meetings | meetings.ts | meetings | **MIGRADO** | cli/meetings |
| 37 | devin | devin.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/devin |
| 38 | slack | slack.ts | slack | **MIGRADO** | cli/slack (atualizada) |
| 39 | media/image/audio/video/transcribe | media.ts, image.ts, audio.ts, video.ts, transcribe.ts | audio, image, video (media/transcribe sem skill) | **MIGRADO** | cli/media, cli/image, cli/audio, cli/video, cli/transcribe |
| 40 | costs/metrics/insights | costs.ts, metrics.ts, insights.ts | (sem skill — lacunas registradas) | **MIGRADO** | cli/costs, cli/metrics, cli/insights |
| 41 | context+runtime | context.ts, runtime-credentials.ts, runtime-presets.ts | context-cli (dev) | **MIGRADO** | cli/context, cli/runtime-credentials, cli/runtime-presets |
| 42 | credentials/connectors/bridges | credentials.ts, connectors.ts, bridges.ts | (sem skill — lacunas registradas) | **MIGRADO** | cli/credentials, cli/connectors, cli/bridges |
| 43 | cloud | cloud-projects.ts, cloud-scope.ts | (sem skill — lacunas registradas) | **MIGRADO** | cli/cloud-projects, cli/console-scope (atualizada) |
| 44 | sync | sync.ts | (sem skill — lacuna registrada) | **MIGRADO** | cli/sync |
| 45 | channels | channels.ts (create/set/list/show; channel-backend.ts e infra de processo dispensados) | channels | **MIGRADO** | cli/channels |

### Dispensados (sem superfície de agente)

| Domínio | Justificativa |
|---------|---------------|
| setup | Wizard interativo humano (prompts); sem `--json`; agente nunca invoca |
| update | Auto-update do binário + restart de processos; infra humana |
| daemon (parcial) | Ciclo de vida de processo/serviço continua operator-facing; `logs --clear` é uma exceção agent-first e exige confirmação destrutiva |
| service | Sobe processos/TUI em foreground; `--json` declara `supported:false` |
| doctor | Diagnóstico humano/CI com semântica própria de exit (pass/warn/fail) já estabelecida |
| cloud-auth (login/whoami/logout) | Fluxo OAuth interativo de browser + polling |
| comandos `ravi sdk` + `sdk-returns` | Dev tooling de build-time; o transporte gateway/SDK continua vinculado ao contrato global |
| adapters | Snapshot de debug read-only para desenvolvimento |
| events | Stream ao vivo ilimitado; não é payload delimitado |
| comando `ravi tools` | Introspecção do registry; as tools exportadas para agentes continuam vinculadas ao contrato global |
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
(`--execute`) nas mutações externas de grupo (`send/create/add/remove/promote/
demote/revoke-invite/rename/join/leave/description/settings`) e em `dm send`.
Todas essas operações são autorizadas como `mutate`; os grants exatos legados
foram preservados pela migração de compatibilidade. O freio acontece ANTES de
qualquer chamada de provider/NATS: em `group send` antes até da leitura de
metadata; em `group create` antes do `ensureGroupAgent` (dry-run com
`--create-agent` não cria agent nem diretório), com pré-validação de agent para
o plan nunca prometer rota a agent inexistente. `dm read` é sempre uma leitura
local sem receipt; `dm ack` é a única operação de receipt e exige confirmação.
`group list/info/invite` são leituras.
`GROUP_NOT_FOUND` (suggestions da própria listagem já resolvida — zero chamadas
extras) e `CONTACT_NOT_FOUND` (DB local). `--fields` em `group list` e
`dm read`. Usage contract no subtree `whatsapp`.

**Consumidores atualizados neste commit:** skill whatsapp (Contrato Do CLI),
skills agents/architect (hunks mistos com instances entram aqui),
prompt-builder (hints de group create/dm send), docs/guides/whatsapp-groups.mdx
(~25 exemplos), docs/cli/overview.mdx (hunks instances+whatsapp). NÃO editado
(path de coverage-gate): hint sentinel em `src/omni/consumer.ts:1551` ensina
`whatsapp dm send` sem `--execute` — registrado como pendência na spec.

**Testes criados do zero:** `group.test.ts` (dry-run sem chamada ao spy nas
operações freadas; execute chamando; not-founds; --fields; recibo condicional;
validações pré-freio). Typecheck limpo. **Rotina Y (estado isolado):** `dm send` sem
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

### 13. skills+skill-gates — MIGRADO (subagente, verificado e integrado)

**Escopo:** freio (`--execute`) em `skills install` (instala código de
terceiro; plan fonte→destino por skill; freio FORA de
`withResolvedSkillSource` para limpar clones git temporários antes do exit;
`SKILL_NOT_FOUND` valida antes — nunca exit 3 para skill inexistente),
`skill-gates rm` (plan disable-default vs delete-custom) e `skill-gates reset`
**só quando há override configurado** (sem override mantém o no-op legado
exit 0 — freio incondicional colocaria exit 3 no caso "já está no default";
documentado no WHY). Sem freio (declaradas): sync (idempotente), grant/revoke
(reversíveis), gates set/enable/disable; **grant-batch/revoke-batch mantêm o
`--dry-run` pré-existente como equivalente do freio (invariante: não renomear)**.
Codes: SKILL/AGENT/GATE_NOT_FOUND com suggestions das fontes reais. `--fields`
em skills list/who e skill-gates list. Usage contract nos subtrees.

**Achados:** `selectSkills` LANÇA em not-found (mesmo padrão do getTaskDetails);
teste de escrita real do install redireciona HOME/USERPROFILE para temp com
guarda fail-fast (`installSkills` escreve em homedir() sem override).
Comportamento melhorado: `skills show --source <src> <ruim>` deixou de vazar
erro cru e emite envelope com suggestions da fonte.

**Rotina X:** `skills.test.ts` 27/27 (19 pré-existentes intactos — coverage-gate
de src/router preservado — +8 de contrato) · `skill-gates.test.ts` 14/14 (+9) ·
`registry-snapshot.test.ts` 16 pass sem drift · typecheck limpo · spec gate
PASSED (cli/skills + cli/skill-gates). **Rotina Y:** show/rm de fantasma →
exit 1 · usage → exit 2 · docs/reference/skills.mdx e helpAfter ensinam o freio.

### 12. artifacts + pages — MIGRADO (subagente, verificado e integrado)

**Escopo:** freio (`--execute`) em `artifacts publish` e `artifacts release
activate` (exposição externa; rethrow de ContractError antes do funil
CloudAuthError — que tem taxonomia própria conflitante), `pages publish`
(freio ANTES da resolução de scope — dry-run funciona offline), `pages
password set` (freio ANTES do prompt — dry-run nunca lê o segredo; plan sem
senha) e `pages password remove`. **Freio DIRECIONAL** em `pages
update`/`visibility`: alvo `public` → exit 3; reduzir exposição
(`private`/`protected_link`) grava na hora — lockdown nunca é freado (decisão
de segurança documentada). Sem freio (declaradas): artifacts
create/update/attach/event/snapshot e o par archive/restore (soft-delete
consultável); pages create (exposição real é gateada pelo publish) e domains.
Codes: `ARTIFACT_NOT_FOUND` (store LANÇA; suggestions do SQLite local),
`ARTIFACT_VERSION_NOT_FOUND` (sem suggestions — números densos),
`SITE/ROUTE_NOT_FOUND` (Console-only, sem fonte local — suggestedAction de
listagem). `--fields` em artifacts list e pages list/published. Usage contract
nos subtrees. `pages update` e `pages visibility` são autorizadas como
`mutate`; os grants exatos legados foram preservados pela migração de
compatibilidade. Não existe op de remoção de rota hoje; spec registra que, se
criada, nasce freada.

**Consumidores:** skill artifacts, README.md, `src/pages/client.ts`
(contentPublishCommand retornado pelo `pages create` agora ensina --execute),
help texts; AGENTS.md (6 linhas de pages) atualizado pelo integrador.

**Rotina X:** `artifacts.test.ts` criado 14/14 · `pages.test.ts` 21/21 (freios,
freio direcional, senha nunca lida em dry-run) · integração
artifacts-show 6/6 · typecheck limpo · spec gate PASSED (cli/artifacts +
cli/pages). **Rotina Y:** show art-fantasma → exit 1 · usage → exit 2.

### 14+15. cron + triggers — MIGRADOS (subagente, verificado e integrado)

**Escopo:** freio (`--execute`) em `cron rm`, `cron run` (dispara o job REAL
fora do agendamento; plan mostra a mensagem/shellCommand que seria enviado;
freio ANTES do log legado "Triggering job" para o dry-run em texto não mentir)
e `triggers rm`. Sem freio (declaradas com racional): add/set/enable/disable
dos dois e `triggers test` (dispara com dados FAKE `_test:true`, changedCount 0
— é o ensaio seguro por design; freá-lo removeria o dry-run que já existe).
Envelope not-found estendido a TODAS as ops que resolvem por id (hashes curtos
fáceis de errar; custo zero): `CRON_JOB_NOT_FOUND`/`TRIGGER_NOT_FOUND` com
suggestions filtradas pelo MESMO filtro REBAC do list (access-denied continua
dobrado em not-found — cloak legado preservado). `--fields` nos dois lists.
Usage contract nos subtrees. Consumidores: 4 docs + hints de usage internos +
skills cron/triggers; AGENTS.md (6 linhas) atualizado pelo integrador.

**Rotina X:** `cron-commands.test.ts` 26/26 · `triggers.test.ts` 24/24 ·
spec gate PASSED (cli/cron + cli/triggers) · typecheck dos arquivos limpo
(1 erro transitório em hooks.test.ts era WIP de agente paralelo).

### 17+18. observers + workflows — MIGRADOS (subagente, verificado e integrado)

**Escopo:** freio (`--execute`) em `observers rules rm` (único reverso é
recriar na mão), `workflows runs start` (arma gates de trabalho coordenado) e
`workflows runs archive-node` — **veredito por inspeção do service: DESTRUTIVO**
(não existe unarchive; nó arquivado sai do agregado e `assertNodeRunMutable`
rejeita permanentemente release/skip/cancel/attach). `cancel` deliberadamente
SEM freio (racional anti-safety documentado em código+spec+WHY: é a parada de
emergência de nó vivo; exit 3 na frente da parada atrasaria exatamente a
operação que limita dano). Sem freio (declaradas): refresh, rules set,
enable/disable, profiles init, specs create, task-attach/create, release/skip.
Codes: OBSERVER_NOT_FOUND (1 code, mensagem nomeia o recurso; pre-check onde a
DB lança), SESSION_NOT_FOUND sem suggestions (racional cli/sessions),
WORKFLOW_SPEC/RUN/NODE_NOT_FOUND (+TASK) com pré-resolução do run para
desambiguar o throw do service. `--fields` em 5 listagens (aliases legados
projetados juntos). `archive-node` é autorizado como `mutate`; risco,
autorização e confirmação são dimensões distintas do contrato.

**Rotina X:** `observers.test.ts` 12/12 · `workflows.test.ts` 13/13 · spec gate
PASSED (cli/observers + cli/workflows) · consumidor docs/workflow-substrate-v0
ensina o freio · skill observers com Contrato Do CLI.

### 16. tags + tag-rules — MIGRADOS (subagente, verificado e integrado)

**Escopo:** **veredito: NENHUM freio novo** nos dois domínios, declarado nas
specs. tags: escrita 100% reversível/unitária (create aditivo, set re-setável,
attach/detach espelhos); não existe `tags rm` — a spec fixa a regra prospectiva
de que op destrutiva futura nasce freada. tag-rules: `tick`/`evaluate` já
nasceram dry-run-by-default com `--apply` (equivalente documentado, não
renomeado). Codes: `TAG_NOT_FOUND` (suggestions de slugs/labels; throws da DB
mapeados; detach desambigua tag×binding), `TAG_RULE_NOT_FOUND`,
`CONTACT_NOT_FOUND` sem suggestions (precedente chats). Prova de equivalência
do freio nos testes: `evaluate` SEM `--apply` não escreve (leitura do DB real
após execução) e COM `--apply` escreve. `--fields` em tags list/search e
tag-rules list. Usage contract nos subtrees. `tick` e `evaluate` são
autorizados como `mutate`, com grants exatos legados preservados pela migração
de compatibilidade. Permanece registrado apenas o bug pré-existente na skill
contacts que ensina `ravi tags define` (comando
inexistente; real é `tags create`) — registrado na spec cli/tags.

**Rotina X:** `tags.test.ts` 7/7 · `tag-rules.test.ts` (novo, estado real
isolado) 6/6 · spec gate PASSED (cli/tags + cli/tag-rules) · skill tag-rules
com Contrato Do CLI.

### 19+20+21. watch + hooks + heartbeat — MIGRADOS (subagente, verificado e integrado)

**Escopo:** freio (`--execute`) em `watch rm` (apaga local e remoto console),
`watch trigger` (arma automação real; plan mostra o registro exato do trigger)
e `watch run` (ciclo real de poll que pode disparar triggers); `hooks rm`
(aliases delete/remove herdam pelo corpo único). **heartbeat: nenhum freio
novo** com racional declarado (trigger dispara o heartbeat do próprio agente —
benigno, HEARTBEAT_OK suprime; frear taxaria a rotina sem proteger nada).
Sem freio (declaradas): watch create/enable/disable, hooks
create/enable/disable/test, heartbeat enable/disable/set. Codes:
WATCH/HOOK/AGENT_NOT_FOUND com suggestions locais; `hooks test` pré-resolve
(runHookById lançava cru). **`runWatchCommand` re-lança ContractError** (senão
o wrapper legado WATCH_COMMAND_FAILED engoliria freio/not-found — mesma classe
do bug do dispatcher). `--fields` em watch list, hooks list, heartbeat status.
Usage contract nos 3 subtrees. Spec `cli/watch` ATUALIZADA (draft→active,
conteúdo original preservado); `cli/hooks` e `cli/heartbeat` criadas.
Consumidores: hints internos + RUNBOOKs de `.ravi/specs/watch/*` ensinam
`--execute`; CHECKS.md do root `watch` (dívida pré-existente que reprovava o
regex de verificabilidade do gate) reformulado com MUST fiel ao original.
Known Failure Modes registrados: `watch trigger --json` legado com erro de
provider sai 0 (pré-existente); heartbeat trigger com HEARTBEAT.md vazio é
sucesso `skipped` por design.

**Rotina X:** `watch.test.ts` (novo) 14/14 · `hooks.test.ts` 9/9 ·
`heartbeat.test.ts` 8/8 (prova de trigger disparando SEM --execute) · typecheck
limpo · spec gate PASSED (cli/watch + cli/hooks + cli/heartbeat + consumidores
watch e watch/connectors/github).

### 22–25. threads + inbox + work-objects + commands — MIGRADOS (lote; subagente, verificado e integrado)

**threads:** SEM freios (escritas append/status-flip locais reversíveis —
racional na spec). `THREAD_NOT_FOUND` com suggestions; slug ambíguo entre
scopes mantém fail() legado de propósito. `--fields` no list. `threads link`
deixou de vazar stack trace de pointer cru (consistência).
**inbox:** freio em `replay` (republica evento no NATS → re-dispara triggers;
plan com ref/sequence/subject; resolução+ambiguidade ANTES do freio). Sem
freio: done/archive/snooze, enable/disable, poll (mesmo tick do daemon; frear
quebraria o debug do RUNBOOK). `INBOX_ITEM_NOT_FOUND` com suggestions;
ambiguidade cross-org mantém fail-closed. `--fields` em list/items. Spec
cli/inbox ATUALIZADA (status: active) + consumidores SPEC/RUNBOOK ensinam
--execute.
**work-objects:** freio em `action` (actionId opaco via adapter pode
concluir/arquivar trabalho externo); `update` declarado SEM freio (form-submit
validado campo-a-campo com guard otimista --revision — gate duplo). Nota
registrada: via adapter tasks o action fica mais estrito que `tasks done` —
deliberado (action não nomeia sua semântica). `WORK_OBJECT_NOT_FOUND` sem
suggestions (sem enumeração cross-adapter barata). Transporte NATS do daemon
não freado (integração programática — documentado). Sem listagem → sem
--fields (declarado).
**commands:** SEM freios (domínio read-only; `run` só renderiza o prompt).
`COMMAND_NOT_FOUND` (registry do próprio lookup) e `AGENT_NOT_FOUND`
(resolvido antes do discovery). `--fields` no list. Skill commands com
Contrato Do CLI. `validate` mantém exit 1 pré-existente como veredito.

**Rotina X:** threads 8/8 (novo) · inbox 11/11 · work-objects 9/9 (novo) ·
commands 5/5 (novo) · typecheck limpo · spec gate PASSED (cli/threads +
cli/inbox + cli/work-objects + cli/commands + consumidores work-objects).
Usage contract nos 4 subtrees.

### 26–30. settings + self + feedback + rules + specs — MIGRADOS (lote; subagente terminado pelo limite de sessão na etapa final; integração completada pelo coordenador)

**Escopo:** freio (`--execute`) em `settings delete` (apaga config global sem
undo; not-found dispara ANTES do freio — deletar key não setada é exit 1, nunca
3). Demais domínios pelo veredito do agente (confirmado nos testes/specs):
self (leitura pura), specs (sync idempotente, new cria arquivos locais),
feedback e rules conforme classificação nas specs respectivas. Envelopes
not-found com suggestions locais; `--fields` nas listagens. Skills settings/
specs/ravi-rules com `## Contrato Do CLI`; docs overview/configuration ensinam
o dry-run do settings delete. Usage contract nos 5 subtrees.

**Rotina X (verificada pelo coordenador após o término do agente):**
settings 10/10 · self 7/7 · feedback 4/4 · rules 7/7 · specs 8/8 · typecheck
limpo · spec gate PASSED (5 specs cli/*). **Rotina Y:** settings set →
delete sem `--execute` → envelope exit 3 · delete de key nunca setada →
exit 1 (not-found vence o freio, ao vivo).

### 38. slack — MIGRADO (estado original, superado pela FASE 7)

**Escopo historico deste head (36 comandos classificados um a um):** **24 ops freadas** — todas as
mutações externas visíveis a humanos (messages-send, blocks-send/update/
showcase, interactions-respond, modals open/update/push, work-objects
send/unfurl/present-details, canvas create/edit/delete/access-set/
showcase/artifact-publish, channels create/rename/invite, messages-replay —
este com o freio movido para ANTES do fetch de conversations.history, que
antes rodava no dry-run). 12 sem freio (leituras/locais, declaradas). Codes:
WRITE_REQUIRES_EXECUTE com plan mostrando o método Slack e o request exato;
CHANNEL_NOT_FOUND (suggestions do config local), CREDENTIALS_NOT_CONFIGURED,
MESSAGE_NOT_FOUND (sem suggestions — id Slack sem fonte local),
CANVAS/ARTIFACT_NOT_FOUND (artifacts do SQLite local). `--fields` em 4
listagens. Usage contract no subtree. **Mudança declarada:** dry-runs
pré-existentes de slack saíam exit 0 com payload dryRun — agora exit 3 com
envelope (documentado em spec/skill/runbook). Spec cli/slack era ASPIRACIONAL
(ensinava --dry-run/--apply e subcomandos inexistentes) — atualizada para o
CLI real com superseding registrado no WHY.

**Rotina X:** baseline do arquivo ANOTADA antes (9 pass/0 fail) → depois 28/28
(9 preservados + 19 de contrato; replay dry-run prova ZERO chamadas de
history) · spec gate PASSED · skill slack (que já ensinava --execute) ganhou
Contrato Do CLI.

### 40. costs + metrics + insights — MIGRADOS (lote de leitura; subagente, verificado e integrado)

**Escopo:** NENHUM freio novo, confirmado por inspeção: `costs pricing
--recompute` mantém `--dry-run` equivalente; `metrics rollup` grava só
derivados idempotentes (o daemon chama a service layer direto — freio no CLI
não bloquearia nada). Ambos são autorizados como `mutate`, com grants exatos
legados preservados pela migração de compatibilidade;
`insights create` grava linhas locais reversíveis (teste prova escrita
imediata). Codes com semântica cuidadosa: `AGENT_NOT_FOUND` em `costs agent`
só quando sem config E sem histórico all-time (agente deletado com histórico
continua auditável — decisão documentada); `SESSION_NOT_FOUND` preservando
fallback de chave crua para sessões podadas; `INSIGHT_NOT_FOUND` com
suggestions; `USAGE_ERROR` exit 2 com `acceptedValues` em `--by`/`--kind`/
`--confidence`/`--importance`/`--limit` (antes coagiam silenciosamente ou
colapsavam em fail() exit 1). `--fields` em todas as listagens de array
(agents, top-sessions, pricing rows, metrics show, insights list/search;
payloads-objeto e `--rich` declarados N/A). Usage contract nos 3 subtrees.

**Rotina X:** costs 12/12 · metrics 7/7 (novo) · insights 10/10 · typecheck
repo limpo · spec gate PASSED (3 specs).

### 31+32+39. mídia (media/image/audio/video/transcribe) + stickers + react — MIGRADOS (lote; subagente, verificado e integrado)

**Freados:** `media send` e `stickers send` (canal vivo), `stickers remove`
(destrutivo), a entrega externa de `audio generate --send` e `image generate
--send`, e `audio tts` (geração e envio disparados). Geração de áudio/imagem sem
envio, vídeo e transcrição executam diretamente: não há estimativa confiável
nem limite configurado que justifique um freio só por custo. **react: SEM freio
por veredito** — reação é trivialmente reversível (WhatsApp substitui/remove;
Slack tem remove explícito) e é a superfície de ack mais barata; freio
contradiria os próprios hints de sessão. Ordem validação→freio garante que
exit 3 só aparece para envios que funcionariam.
Codes: FILE/STICKER/STICKER_MEDIA/MESSAGE_NOT_FOUND (react com not-found
best-effort FAIL-OPEN: só rejeita quando o chat existe no ledger local — gap
de ledger nunca vira falso not-found), MEDIA_SEND/TRANSCRIBE_FAILED retryable.
`--fields` em stickers list, audio voices/pending. `audio blob` intocado
(allowlist binária). Usage contract nos 7 subtrees.

**Consumidores críticos atualizados:** builders de sessions
(sticker/media send com `--execute`; reaction inalterado) + asserts literais;
`src/stickers/prompt.ts` (prompt injetado em agentes vivos) ensina
`stickers send --execute`. AGENTS.md ensina react send — nada a mudar (react
sem freio). Skills audio/image/video/stickers com Contrato Do CLI (video
ensina o caminho grátis primeiro).

**Rotina X:** media-json 20/20 · stickers 9/9 · image 2/2 + image-contract
4/4 (novo) · video 5/5 (novo) · transcribe 4/4 (novo) · sessions 49/49
(asserts de builders) · gates json/pagination-coverage intactos · spec gate
PASSED (7 specs). Falhas ambientais pré-existentes observadas e não
relacionadas: runtime-system-prompt (separador `\`) e specs/service.test
(split de path) — Windows.

### 34–37. youtube + prox-calls + meetings + devin — MIGRADOS (lote; subagente, verificado e integrado)

**youtube (`yt`):** 7 freadas — reply, video-update, video-delete e
playlist-delete (plan com `irreversible:true`), playlist-remove, e **por
veredito de princípio** playlist-create e playlist-add (escrita externa
NÃO-idempotente: retry cego duplica; externalidade+não-idempotência vencem a
reversibilidade — racional do mail send). 21 leituras sem freio.
`VIDEO_NOT_FOUND` sem suggestions (sem fonte local). Funil `execute()` com
rethrow de ContractError. `mutationHelp` reescrito ("No dry-run is available"
→ ensina o freio). `--fields` em 7 listagens.
**prox-calls (`prox`):** `request` freada (LIGAÇÃO real; validação de profile
ANTES do freio; plan minimizado sem telefone, motivo ou valores dinâmicos).
`profiles configure` só bloqueia quando haverá sincronização real com
ElevenLabs; update local e `--skip-provider-sync` são diretos. `cancel` sem
freio (parada de dano). Equivalentes documentados: voice-agents sync (dry-run
default) e tools run --dry-run (live hard-block). 6 codes not-found; freio
verificado contra o sqlite real (0 linhas sem --execute). `--fields` em 3
listagens. Operações com efeito são autorizadas como `mutate`, com grants
exatos legados preservados pela migração de compatibilidade.
**meetings:** NENHUM freio novo — `join --dry-run` pré-existente documentado
como equivalente; login (interativo humano), finalize e profiles init
declaradas. `MEETING_PROFILE_NOT_FOUND` com guarda para não mascarar erro de
config como not-found. Correção cross-platform da suíte que já MORRIA no
Windows (stub bash + PATH `:`): env do recorder no beforeEach + skipIf(win32)
só no teste de spawn; CI POSIX roda tudo.
**devin:** create e send freadas (serviço externo; freio ANTES do client e plan
sem segredos). `sessions archive` e `sessions insights --generate` também
confirmam alteração externa. `terminate` permanece direto por ser parada de
dano/custo; `sync` e leitura simples de insights também são diretos.
`DEVIN_SESSION_NOT_FOUND` em 8 ops com suggestions do cache local. Todas as
operações com efeito são autorizadas como `mutate`, com grants exatos legados
preservados pela migração de compatibilidade. Mock de artifacts/store com
spread do real (vazamento entre arquivos corrigido).

**Consumidores:** skills prox-calls/meetings com Contrato Do CLI; skill tasks
e docs/task-profiles-catalog ensinam devin create/send com --execute.
Reportado sem editar: templates do app youtube (`ravi.app.json`) propagam o
freio até o chamador passar --execute em {args} — hard-codar anularia o freio
(deliberado); specs antigas de devin/prox/console-scope ensinam sintaxe
pré-freio — dívida de reconciliação registrada (tocar nelas exigiria authoring
de companheiros ausentes).

**Rotina X:** youtube 11/11 · prox-calls 65/65 · meetings 13/13+1 skip(win32)
· devin 13/13 · rodada conjunta 102 pass/1 skip/0 fail · typecheck limpo ·
spec gate PASSED (4 specs). Usage contract nos subtrees yt/prox/meetings/devin.

### 41. context + runtime-credentials + runtime-presets — MIGRADOS (lote de substrato de auth; subagente, verificado e integrado)

**Freadas:** `context revoke` (mata auth viva com cascata; plan só com IDs —
NUNCA chave rctx_) e `context credentials remove` (plan identifica por
contextId/label/kind + chave MASCARADA 8 chars). Equivalentes mantidos:
`context prune` (`--apply` + `--confirm prune-contexts` — freio MAIS FORTE) e
`cleanup-agent-runtime` (dry-run default + `--revoke`); `runtime presets`
mantém `--dry-run` opt-in em set/enable/disable/delete (delete tem hard-block
próprio do store quando referenciado). **Surpresas de superfície:**
`runtime credentials remove`/`exec` NÃO EXISTEM (premissa do censo estava
errada) — regra "nasce freado" registrada no spec; `presets create` não tinha
--dry-run (declarada sem freio). Codes: CONTEXT/CREDENTIAL/PRESET_NOT_FOUND
com suggestions restritas a {id, label} — **provas anti-vazamento em teste:**
`not.toContain("rctx_")`, chave completa, nomes de env de API. `--fields` nos
3 lists. Usage contract nos subtrees `context` e `runtime`. Consumidor
`daemon.ts` (hint de revoke) atualizado pelo integrador; specs antigas
wa-overlay/auth citam revoke — dívida de reconciliação registrada.

**Rotina X:** context 37/37 · runtime-credentials 7/7 · runtime-presets 11/11
· spec gate PASSED (3 specs) · skill context-cli (ravi-dev) com Contrato Do CLI.

### 42–45. credentials + connectors + bridges + cloud + sync + channels — MIGRADOS (lote final; subagente, verificado e integrado)

**Freadas:** `credentials connections remove` e `credentials broker exec`
(inspeção do broker: resolve segredo REAL do backend in-process — boundary de
chamadas vivas; `--dry-run` legado documentado como equivalente),
`connectors revoke` e `bridges revoke` (deletam tokens no provider; `--yes`
pré-existente = equivalente documentado), `cloud projects create` (recurso
remoto no Console; validação de visibility ANTES do freio), `sync push` e
`sync pull` (transferência em massa; freio é a PRIMEIRA instrução — antes até
do bridge/enqueue local). Sem freio (declaradas): connectors connect (OAuth
interativo — o consentimento é o freio), bridges/credentials add,
enable/disable, cloud scope set/clear (default local não-secreto), sync retry,
channels create/set (config reversível). `sync inspect` de id desconhecido
deixou de retornar found:false exit 0 → `SYNC_RECORD_NOT_FOUND` exit 1.
`CHANNEL_NOT_FOUND` (config Ravi — colisão conceitual com o code do slack
documentada; desambiguação por `op`) + validação cross-domain de
`--credential-connection`. Anti-vazamento: planos nunca carregam secretRef/
segredo/bridgeToken (asserções negativas). Rethrow de ContractError nos funis
CloudAuthError. `--fields` nos lists. Usage contract nos 6 subtrees.

**Correção de regressão (integrador):** `channels-json.test.ts` estava
QUEBRADO desde o commit do whatsapp (mock de ../context.js sem `hasContext` →
SyntaxError no import; + 6 call sites de group/dm sem o `execute` posicional)
— era falha NOVA vs baseline, fora do escopo nominal dos lotes. Corrigido:
mock + 14 call sites; **8/8 pass** (baseline original restaurada).

**Rotina X:** credentials 13/13 (novo) · connectors 5/5 (novo) · bridges 7/7 ·
cloud-projects 7/7 · cloud-scope 4/4 · sync 6/6 · channels 17/17 ·
channels-json 8/8 · typecheck limpo · spec gate PASSED (7 specs) ·
`sdk:generate`/`sdk:check` current (regen final da onda) · build ok · lista
AGENT_CONTRACT_DOMAINS reordenada alfabeticamente com os 58 roots migrados.

### INCIDENTE — limite de sessão da conta (2026-08-06 ~05:00)

Os 5 agentes em voo da onda seguinte foram terminados pelo limite de sessão da
API (reset 7:30am America/Sao_Paulo): lote settings/self/feedback/rules/specs
(QUASE completo — parcial preservado no working tree, compila), e
slack / youtube+prox-calls+meetings+devin / mídia+stickers+react /
costs+metrics+insights (mal começaram). Plano: retomar pós-reset com
re-despacho; nada foi perdido nem revertido.

---

## FASE 2 — Integração final (snapshot provisório, 2026-08-06)

**Veredito histórico, invalidado pela FASE 3: "zero falhas novas".**

- `bun test src/channels/`: **254 pass / 1 fail** (baseline: 145/110). A única
  falha restante consta na lista da baseline; **109 falhas da baseline foram
  CORRIGIDAS** pelo hardening EBUSY de `src/test/ravi-state.ts`
  (oven-sh/bun#25964).
- Varredura `test:cli-commands` (arquivo a arquivo): todos verdes exceto
  pré-existentes ambientais win32 documentados: `tasks-profiles` (3, EBUSY
  próprio, verificado no virgem), `daemon` (1, EPERM symlink — privilégio
  Windows), `doctor` (1, path `~/` vs backslash). `runtime-presets` e `sync`
  flakaram sob contenção e passam isolados (11/11, 6/6).
- Demais segmentos da suíte oficial: 544+246+1+2+79+13+8+4+39 pass; as 22
  falhas observadas (bash stdio, hooks MEMORY.md, projects smoke, task profile
  catalog, task substrate, transcripts) estão TODAS em paths com **0 commits
  nossos** (`git log def9a763..HEAD` vazio para src/bash, src/hooks,
  src/projects, src/tasks, src/workflow-substrate, src/transcripts.ts) —
  pré-existentes ambientais win32 por definição; a baseline nunca alcançou
  esses segmentos porque a cadeia abortava em channels.
- `test:sdk`: 49/49 · `sdk:check`: artifacts current · `bun run typecheck`:
  limpo · `bun run build`: ok.
- **Quality gate local (`GITHUB_BASE_REF=dev`): PASSED** — 65 spec ids
  alterados validados, 273 specs indexadas, coverage gate não disparado
  (nenhum path de runtime tocado).
- `origin/dev` inalterado em `def9a763` — rebase desnecessário; branch com os
  commits de migração limpos à frente.

**Cobertura final:** 45 entradas de domínio MIGRADAS (58 roots commander no
usage-contract em ordem alfabética), 13 domínios dispensados com justificativa
(tabela acima), 54 specs `cli/*` novas/atualizadas + 3 specs root com
companheiros criados (mail) ou corrigidos (watch CHECKS), ~30 skills/docs/
hints/prompts de agente ensinando o contrato.

---

## FASE 3 — Revisao adversarial e compatibilidade (2026-08-07)

Esta fase substitui os vereditos provisórios anteriores. A migração só pode
ser aprovada pelo comportamento do head publicado, nunca pela quantidade de
testes nem por um CI executado em um commit anterior.

### Regressoes detectadas e corrigidas

- O smoke oficial de `projects fixtures seed` invocava uma operação destrutiva
  sem `--execute`. Era uma regressão da migração mesmo sem alteração no arquivo
  do teste, pois o consumidor spawna o CLI global alterado.
- O bootstrap do processo real convertia `ContractError` de uso em exit 1 e
  reimprimia `Error:` quando havia contexto de agente. O processo agora
  preserva o envelope único e exit 2 com e sem contexto.
- `crm contact show`, `crm task show`, `audio generate` sem texto e
  `image generate` sem provider ainda escapavam por handlers legados. Esses
  caminhos agora retornam JSON canônico, sem stderr textual concorrente.
- A superfície de tools concatenava output humano do dry-run ao envelope e
  produzia conteúdo que não passava em `JSON.parse`. Agora retorna exatamente
  um envelope canônico.
- A skill oficial `cli-creator` ainda ensinava exit 0/1 e proibia exit 2. Ela
  agora aponta para a spec global e ensina 0/1/2/3, `ContractError`, paridade
  de transportes e confirmação baseada em risco.
- Consumers de teste e mocks que atravessam o CLI global foram atualizados em
  vez de serem classificados como falhas preexistentes apenas pelo path.

### Release note — autorizacao e grants

A migração mantém um inventário versionado de **69 operações reclassificadas
de `read` para `mutate` ao longo da branch**. O inventário deve corresponder
exatamente ao `CommandAccess` vivo e é validado pelo gate central de REBAC.

Na abertura dos stores, grants `read` exatos de menor privilégio recebem o
grant `mutate` correspondente em quatro superfícies duráveis: defaults de
agente, permission tags do sistema/provider, observer rules e observer
bindings. O grant `read` original é preservado, a migração é idempotente e
admin/full/group grants permanecem inalterados. Contextos runtime ativos e não
revogados recebem os mesmos grants exatos; contextos expirados ou revogados
permanecem intactos. Wildcards `read` expandem somente para os grants `mutate`
exatos das operações reclassificadas que já autorizavam; nunca viram um
wildcard `mutate`. O log identifica os agentes afetados.

Rollback exige cuidado: reverter o código da migração não remove grants
`mutate` já anexados. Qualquer remoção deve ser uma auditoria explícita dos
quatro stores, não um rollback destrutivo automático.

### Politica de confirmacao recalibrada

- Geração local de áudio/imagem executa diretamente; somente entrega externa
  (`--send`) e TTS disparado exigem confirmação. Vídeo/transcrição não alegam
  um freio monetário sem estimativa confiável e limite configurado.
- `whatsapp dm read` é sempre leitura local direta, sem receipt. `dm ack` é a
  operação externa separada e exige confirmação.
- `prox calls profiles configure` só bloqueia quando haverá sincronização real
  com ElevenLabs. `--skip-provider-sync` e updates locais continuam diretos.
- `daemon logs --clear` bloqueia antes do flush destrutivo; leituras de log
  continuam diretas.
- `devin sessions insights --generate` e `sessions archive` confirmam a
  alteração externa; leitura de insights, sync e o damage-stop `terminate`
  continuam diretos.
- Planos e audit inputs desses fluxos são minimizados/redigidos: corpos,
  telefone, motivo, valores dinâmicos, message ids e caminhos de prompt não
  podem ser copiados para envelopes ou auditoria.

### Transportes, consumidores e gates

CLI, tools e gateway/SDK preservam `op`, envelope, `error.code` e a taxonomia
0/1/2/3. Auditoria distingue `blocked`, `usage_error`, `denied` e `failed`.
Specs, skills, hints e exemplos que invocam operações freadas devem carregar a
confirmação correta. OpenAPI e SDKs TypeScript/Swift são derivados do registry
vivo. Neste follow-up, como a execução local de Bun foi desabilitada por
decisão do operador, hashes e snapshots foram reproduzidos estaticamente; os
checks de drift executados pela CI são a autoridade sobre essa reprodução.

Evidência focada observada nesta fase: 4 testes de processo real, 35 testes de
tools/gateway, 12 testes de autorização/migração, 21 testes do observation
plane e 84 testes de SDK/OpenAPI passaram. Build, typecheck, checks de drift
dos artefatos gerados, lint/formatter dos arquivos alterados e o quality gate
completo baseado no diff também passaram localmente.

O primeiro CI do head expandido (`31149330318`, SHA `7e20e378`) detectou uma
regressão real de isolamento de testes: o mock de `src/nats.ts` em
`rtk-rewrite.test.ts` preservava apenas `publish` e removia o export `nats` no
Bun 1.3.11, causando 29 erros de importação no mesmo processo. O mock passou a
preservar todos os exports não substituídos e ganhou um teste de regressão.

O CI Linux `31149690976` do head publicado `a7d668d1` passou Build, Typecheck,
Test e Quality Gate (specs + coverage). PR Description e GitGuardian também
passaram. Com os checks globais observados, a spec normativa
`.ravi/specs/cli/SPEC.md` foi promovida de `draft` para `active`.

---

## FASE 4 — fechamento adversarial da PR 399 (2026-08-07)

Esta fase substitui o veredito final da FASE 3. A spec voltou para `draft`
porque novos commits corrigiram lacunas encontradas depois daquele CI; o run
verde de `a7d668d1` é evidência histórica, não aprovação do head atual.

### Correções adicionais integradas

- `RaviAppError` dos handlers reais de Apps passou a preservar o contrato em
  CLI, tool e gateway, em vez de virar erro genérico ou HTTP 500 semântico.
- Contextos runtime ativos passaram a receber os grants exatos de
  compatibilidade descritos acima, inclusive quando o grant legado era um
  wildcard `read`; contextos expirados/revogados continuam inalterados.
- Responses binárias não-success agora viram falha contratual nos três
  transportes; sucesso binário deixa de ser apresentado como output vazio.
- Planos e audit inputs de Devin, grupos e Slack foram minimizados: conteúdo,
  telefones, IDs e refs sensíveis deram lugar a tamanhos, contagens, presença,
  valores mascarados e descrição do efeito material.
- A inspeção read-only de artifacts preserva o artifact existente quando o
  banco possui schema parcial; tabelas posteriores ausentes não transformam o
  estado inteiro em vazio e nenhuma tabela é criada no dry-run.
- Todo comando que expõe `--execute` agora é `mutate` e declara
  `requiresConfirmation: true`. Em comandos condicionais, essa metadata indica
  que existe um caminho confirmável; a invocação segura continua imediata.
- O gate global passou a verificar a relação nos dois sentidos, e a seleção da
  CI inclui taxonomia de processo, paridade de transportes, cloud errors,
  schema inference, artifacts e drift TypeScript/OpenAPI/Swift.
- A spec global foi consolidada como fonte normativa; specs de domínio ficam
  responsáveis somente pelas classificações, exceções e checks locais.

### Estado de verificação

Por decisão explícita do operador, nenhum Bun/Bunx foi executado localmente
nesta fase. Cada commit foi verificado por diff estático, arquivos staged
explícitos e `git diff --check`; testes, build, typecheck e quality gate só
contam quando a CI Linux da PR 399 terminar no mesmo SHA.

### Evidência final do head de implementação

O CI Linux [`31209185258`](https://github.com/filipexyz/ravi/actions/runs/31209185258)
do SHA `652662ab96df85f5d13f84c23d6d643ddc29ad38` passou, por identidade:

- PR Description;
- Build;
- Typecheck;
- Test, incluindo taxonomia de processo, CLI, tools, gateway/SDK, REBAC,
  auditoria, redaction e consumidores;
- Quality Gate (specs + coverage), com spec gate e coverage gate verdes;
- checks de drift dos snapshots TypeScript SDK, OpenAPI e Swift executados pela
  suíte oficial, sem diferenças geradas pendentes.

As falhas observadas nas rodadas anteriores foram corrigidas em commits
isolados: estado compartilhado em `prox-calls`, mocks incompletos de Slack,
fixtures de app sintaticamente inválidos ou sem o grant necessário e ausência
de um teste focado para a orientação sentinel do Omni. Nenhuma dessas falhas
foi reclassificada como preexistente apenas pelo caminho do arquivo.

A spec global foi promovida novamente para `active` neste commit documental.
Como qualquer commit muda o head da PR, a promoção só sustenta o veredito final
se a CI deste commit também ficar verde. O resultado exato desse último run
deve constar no corpo da PR e no relatório final, sem criar um ciclo de commits
apenas para registrar o próprio SHA.

**Veredito do head de implementação: APPROVE. Veredito final da PR: condicionado
à CI verde do commit documental de promoção.**

---

## FASE 5 — força-tarefa adversarial de privacidade e gates (2026-08-08)

Esta fase substitui o veredito final da FASE 4 para o head atual. O CI verde de
`652662ab` continua como evidência histórica, mas não aprova os commits
posteriores. A spec global voltou para `draft` até a CI Linux da PR 399 passar
no SHA exato publicado.

### Fatos de comportamento atualizados

- Apps deixou de ser apenas scaffolding dispensado: o roteador público, o
  subprocesso externo e o contexto filho least-privilege participam do
  contrato e do gate oficial.
- `pages create` e `pages domains` alteram o Console externamente e agora são
  freados antes de credenciais, resolução de projeto ou chamada de provider.
  As afirmações históricas da entrada 12 de que essas operações eram imediatas
  não descrevem mais o runtime.
- `heartbeat trigger` continua imediato quando não existe trabalho acionável,
  retornando `skipped`; quando há trabalho enfileirável, exige `--execute` antes
  da publicação. Isso supersede a afirmação histórica de ausência total de
  freio na entrada 19+20+21.
- Geração local de áudio e imagem permanece imediata. Entrega externa exige
  confirmação e o dry-run ocorre antes de DB, provider, artifact, destino ou
  fila. Validações puras de imagem continuam antes do freio.

### Fechamentos de privacidade e paridade

- A redação central de auditoria cobre texto autoral em `title`,
  `instructions`, `reason` e `query`, além da redação contextual de valores de
  settings.
- Planos, stickers ausentes e cloud logout não refletem caminho local, conteúdo
  integral nem mensagem bruta de provider.
- O gateway remoto valida a coerência do contrato e projeta detalhes por
  allowlist: preserva apenas identificadores estáveis e formas canônicas de
  flags/posicionais; descarta texto livre, paths, URLs, tokens e objetos.
- Os testes de redaction e audit passaram a fazer parte de
  `test:agent-contract`; Apps integra a suíte principal; os dois snapshots
  OpenAPI versionados são verificados pela CI.

### Evidência local antes da publicação

O head de implementação imediatamente anterior a este registro foi
`25745fd4`. Foram observados localmente, por identidade:

- image contract: 9 testes verdes;
- remote gateway: 16 testes verdes;
- redaction + audit: 15 testes verdes;
- Apps router: 26 testes verdes, incluindo o subprocesso/contexto filho;
- SDK TypeScript, `docs/openapi.json`, `openapi.json` e Swift regenerados e sem
  drift nos checks canônicos.

Esses resultados locais não substituem build, typecheck, suíte completa e
quality gate da CI. Não há veredito final para esta fase até o head documental
ser publicado na PR 399 e todos os checks obrigatórios passarem no mesmo SHA.

### Primeira rodada de CI da fase 5

O CI Linux [`31281927163`](https://github.com/filipexyz/ravi/actions/runs/31281927163)
do SHA `d477d8b755dca6f24a94ac10cd25948afda41169` passou Build e Typecheck, mas
falhou em Test com cinco identidades; por consequência, Quality Gate foi
ignorado nessa rodada.

Três falhas mostraram que a auditoria já redigia `reason` no evento publicado,
enquanto a chave de deduplicação ainda preservava o texto integral. O commit
`a8ca0848` passou a construir a chave com o mesmo valor saneado e atualizou os
testes de permissões e aprovação. As outras duas falhas eram contaminação de
módulo no processo compartilhado de testes: dois mocks de NATS do Omni não
implementavam `isExplicitConnect` e `nats.close`, exigidos pelo caminho de Apps.
O commit `7f648bbd` completou esses mocks.

Depois das correções, passaram localmente 10 testes de permissões/aprovação e
53 testes no lote conjunto Omni + Apps que reproduz a ordem relevante da CI.
A spec permanece `draft`; somente uma nova CI verde no SHA exato pode promover
esta fase para aprovada.

O CI Linux [`31282273679`](https://github.com/filipexyz/ravi/actions/runs/31282273679)
do SHA `05cda8798042e92f2b01b45a04e864d2dfa27bf8` voltou a passar Build e
Typecheck. Test parou em uma única identidade, `channels-json.test.ts`, antes de
executar seus casos: o mock parcial não expunha dependências agora alcançadas
pelo grafo de imports no Bun 1.3.11 da CI. O commit `0b938edf` completou apenas
os mocks desse teste; seus oito casos passaram localmente depois da correção.
Quality Gate permaneceu ignorado nessa rodada e a spec continua `draft`.

O CI Linux [`31282534997`](https://github.com/filipexyz/ravi/actions/runs/31282534997)
do SHA `e778fbe0907ca21c2624e5092818ad243d52ca5e` passou Build e Typecheck e
alcançou `context.test.ts`, onde três expectativas ainda exigiam motivos e
comandos Bash integrais em eventos de negação. O commit `ee215584` alinhou as
expectativas à redação central e minimizou também o `detail` e o comando
persistido para apenas seu comprimento. Os 65 testes focados de Bash hook e
contexto passaram; Quality Gate continuou ignorado e a spec permanece `draft`.

O CI Linux [`31282844020`](https://github.com/filipexyz/ravi/actions/runs/31282844020)
do SHA `504c570207ba7df6a20defcee28b76f2e8de96b0` passou Build e Typecheck e
falhou em uma única identidade de `inbox.test.ts`. O plano de replay usava o
campo `subject` para um tópico NATS, colidindo semanticamente com a redação
central de assunto de mensagem. O commit `26a9a543` renomeou somente esse campo
estruturado para `eventTopic` no runtime, teste e spec do domínio, sem afrouxar
a política global de privacidade. Os 11 testes focados de inbox passaram;
Quality Gate permaneceu ignorado e a spec continua `draft`.

O CI Linux [`31283066860`](https://github.com/filipexyz/ravi/actions/runs/31283066860)
do SHA `d66e94b01691e34d517e1554174de2cfe2f08156` passou Build e Typecheck e
falhou em duas expectativas do mesmo plano de `skills install`. O identificador
mínimo de origem usava `sourceName`, chave que a política central trata como
conteúdo privado. O commit `47ee78ea` renomeou o campo para `sourceLabel`,
preservando somente `catalog` ou o basename local e mantendo caminho, nome de
skill e conteúdo ausentes. Os 29 testes focados de skills passaram; Quality
Gate permaneceu ignorado e a spec continua `draft`.

O CI Linux [`31283228716`](https://github.com/filipexyz/ravi/actions/runs/31283228716)
do SHA `8bd109aac24053072008f5f9c23a098215c1a6f4` passou Build e Typecheck e
falhou em uma expectativa de `tag-rules validate`. Os detalhes já continham
basename e categoria estável, mas mantinham um campo `message` redundante que a
redação central mascarava. O commit `6bf93383` removeu esse texto dos detalhes,
preservando o código canônico e a mensagem do envelope. Os 7 testes focados de
tag-rules passaram; Quality Gate permaneceu ignorado e a spec continua `draft`.

O CI Linux [`31283371350`](https://github.com/filipexyz/ravi/actions/runs/31283371350)
do SHA `4cf6d5783640747b9ef6d55b1f9fbb5855b2183f` passou Build e Typecheck e
falhou em uma expectativa stale do smoke de processo. O runtime já normalizava
falhas do helper legado como `COMMAND_FAILED`, exit 1 e mensagem pública
genérica, conforme os testes centrais de CLI, tool e gateway, mas o smoke de
audio ainda exigia o texto bruto do path inválido. O commit `ffa79c1e` alinhou
somente essa expectativa. Os 9 testes reais de processo passaram; Quality Gate
permaneceu ignorado e a spec continua `draft`.

O CI Linux [`31283577682`](https://github.com/filipexyz/ravi/actions/runs/31283577682)
do SHA `9fbbd7dd2e8940c5923745e97b38570e78ca9b2e` passou Build, Typecheck, Test e
Quality Gate (specs + coverage). Essa é a primeira evidência verde da fase 5 no
head exato de implementação após os fechamentos adversariais. A spec global foi
promovida para `active` neste commit documental. Como a promoção muda o head, o
veredito final permanece condicionado à CI verde deste próprio commit; o
resultado pode ser registrado no corpo da PR sem criar outro ciclo documental.

---

## FASE 6 - fechamento de privacidade nativa e leitura pura (2026-08-09)

Esta fase substitui o veredito da FASE 5 para qualquer head posterior a
`fecec02e`. A CI verde desse SHA continua sendo evidencia historica, mas nao
valida as mudancas abaixo. A spec global voltou para `draft` ate a CI Linux da
PR 399 passar no novo SHA exato.

### Findings reproduzidos e decisao minima

- A sanitizacao central preservava pathname de URL e nao reconhecia aliases
  comuns como `cwd`, `outputDir`, `endpoint` e `credential`. Provenance de CLI
  e planos recebidos do gateway podiam atravessar as fronteiras de audit/tool
  com dados privados.
- O runtime nativo Codex/Kimi entregava o comando negado integral para a
  persistencia de `permission_denials` e para `ravi.audit.denied`; a protecao
  anterior cobria apenas o hook legado de Bash.
- `whatsapp dm read --no-ack` era leitura pura, mas a autorizacao estatica da
  operacao era `mutate`. O acoplamento entre leitura local e receipt implicito
  foi removido: `dm read` agora e sempre `read`; `dm ack --execute` e o unico
  caminho que publica o receipt.

### Fechamentos implementados

- O sanitizador central redige paths por chave e por valor, remove pathname,
  credenciais, query e fragment de URLs publicas, e minimiza comandos para um
  marcador com comprimento. A mesma regra protege ContractError, provenance,
  auditoria e denial records.
- O gateway remoto nao confia em `plan` arbitrario. Ele projeta apenas metadata
  estrutural tipada e identificadores de gramatica restrita, descartando texto
  livre, paths, URLs, comandos, secrets e chaves desconhecidas.
- Testes adversariais usam sentinelas no ContractError, CLI audit, provenance,
  gateway remoto, banco de denials, evento de audit e host-services nativo.
- A superficie WhatsApp, os consumidores, a skill, a spec de dominio e os SDKs
  gerados foram alinhados a separacao `read`/`ack`; a entrada foi retirada do
  inventario read-to-mutate sem remover o grant legado de leitura.

### Estado de verificacao antes da publicacao

Por instrucao explicita do operador, nenhum Bun/Bunx foi executado localmente
nesta fase. A verificacao local fica limitada a revisao adversarial dos diffs,
arquivos staged explicitos e `git diff --check`. Build, typecheck, testes,
snapshots gerados e quality gate so contam quando a CI da PR 399 terminar no
mesmo SHA publicado. Enquanto isso, o veredito permanece **DO NOT APPROVE**.

### Primeira rodada de CI da fase 6

O CI Linux [`31294160621`](https://github.com/filipexyz/ravi/actions/runs/31294160621)
do SHA `806b0718dc5d6b8186c35e312a1f11ee50830f19` passou Build e Typecheck,
mas Test falhou em duas expectativas do mesmo arquivo, `pages.test.ts`. A
deteccao de path por valor tratava a rota publica material (`/` ou `/guide`)
como caminho local privado. O Quality Gate foi ignorado por consequencia.

O commit `42d99343` manteve a protecao de paths desconhecidos e criou uma
excecao explicita apenas para o campo estrutural `route`, ainda passando seu
valor pelo sanitizador de tokens. O teste central de redaction agora protege
essa distincao. A spec permanece `draft`; uma nova CI no head exato e
necessaria para qualquer aprovacao.

### Segunda rodada de CI da fase 6

O CI Linux [`31294308314`](https://github.com/filipexyz/ravi/actions/runs/31294308314)
do SHA `cebb612ed2ad39784481dc45ddbb4f2c13a7902d` passou Build e Typecheck e
avancou pelos checks de Pages e SDK. Test falhou somente em uma expectativa
obsoleta de `command-access.test.ts`: o teste ainda exigia que o comando negado
fosse persistido em texto puro, embora o runtime ja o redigisse na auditoria e
no banco.

O commit `c0966db4` alinhou as duas expectativas ao marcador estruturado
`[REDACTED:content length=11]`, preservando como comportamento normativo a
ausencia do comando privado integral. A spec permanece `draft`; uma nova CI no
head exato continua necessaria para qualquer aprovacao.

### Terceira rodada de CI da fase 6

O CI Linux [`31294567287`](https://github.com/filipexyz/ravi/actions/runs/31294567287)
do SHA `f90e8d275d30bc1da29a4876411720e216c2a6fc` passou Build, Typecheck e
todos os testes comportamentais alcancados, inclusive a expectativa de comando
negado redigido. Test falhou no check de drift OpenAPI: as duas copias tinham o
corpo atual, mas conservavam o hash `info.version` anterior.

O commit `1a866b52` recalculou o hash deterministico para
`f957e4614d5d334b` em `openapi.json` e `docs/openapi.json`. A igualdade entre
as copias e o hash do corpo foram verificados com Node, sem Bun local. A spec
permanece `draft`; uma nova CI no head exato continua necessaria para qualquer
aprovacao.

### Quarta rodada de CI da fase 6

O CI Linux [`31294999558`](https://github.com/filipexyz/ravi/actions/runs/31294999558)
do SHA `cd8032c8b7681478637b6323687350fa7745a64d` passou Build, Typecheck,
testes comportamentais, os dois checks OpenAPI e o check do SDK TypeScript.
Test falhou somente no check final do SDK Swift, que informou um artefato
gerado divergente.

O arquivo divergente era `RaviVersion.generated.swift`: seu registry hash nao
acompanhou o hash ja validado pelo SDK TypeScript. O commit `d5e3c19b` alinhou
ambos a `sha256:2389d0925c0f408c05773debd2f094c19705b8f392212fbdc8b467b2151b8e79`.
A spec permanece `draft`; uma nova CI no head exato continua necessaria para
qualquer aprovacao.

### Quinta rodada de CI da fase 6 e promocao normativa

O CI Linux [`31295216577`](https://github.com/filipexyz/ravi/actions/runs/31295216577)
do SHA `cfcf0a7c0511341f396f64d3e3fec9e6631b201a` passou Build, Typecheck,
Test e Quality Gate (specs + coverage). A descricao obrigatoria da PR tambem
passou no run `31295216571`.

Essa e a primeira evidencia integralmente verde da fase 6 no head exato de
implementacao depois dos fechamentos de privacidade nativa, gateway remoto,
permissao de leitura WhatsApp e snapshots gerados. A spec global foi promovida
para `active` neste commit documental. Como a promocao muda o head, o veredito
final permanece condicionado a CI verde deste proprio commit; o resultado pode
ser registrado no corpo da PR sem criar outro ciclo documental.

---

## FASE 7 - confirmacao proporcional para contencao (2026-08-10)

Esta fase corrige classificacoes de confirmacao encontradas por auditoria
adversarial depois da fase 6. As entradas anteriores permanecem como historico
dos heads que elas descreviam; esta secao substitui suas conclusoes para o head
atual.

### `context revoke`: reducao de autoridade imediata

O CI Linux [`31362559148`](https://github.com/filipexyz/ravi/actions/runs/31362559148)
do SHA `a91420b907a29801900672cad1f4020e2b6da536` passou Build e Typecheck e
falhou somente no novo teste que exigia revogacao imediata: o runtime ainda
retornava `WRITE_REQUIRES_EXECUTE`, exit 3, antes de chamar
`revokeRuntimeContext`.

A correcao mantem `CommandAccess.kind: mutate`, risco destrutivo, validacao de
existencia, cascata e auditoria, mas remove `requiresConfirmation`, a opcao
`--execute` e o dry-run. Revogar um contexto reduz autoridade e exposicao; por
isso executa em uma chamada conforme a politica global. O hint do daemon, a
skill oficial, os consumidores e a spec de dominio foram alinhados. Os
artefatos gerados serao atualizados em um commit dedicado depois de consolidar
as reclassificacoes desta fase.

### `whatsapp group demote`: contencao sem segunda chamada

O CI Linux [`31363188032`](https://github.com/filipexyz/ravi/actions/runs/31363188032)
do SHA `0a6d17709e11301a8851723900b8134dfbbe5b34` passou Build e Typecheck e
falhou somente no novo teste de `group demote`: 27 testes do arquivo passaram,
mas a operacao ainda retornava `WRITE_REQUIRES_EXECUTE`, exit 3, antes de
chamar o provider.

A correcao mantem a autorizacao `mutate`, o risco e o mesmo caminho do provider,
mas remove a confirmacao e o parametro `--execute` apenas de `demote`. Promover
continua freado porque amplia autoridade; demover remove poder administrativo e
executa imediatamente. A skill, os exemplos, os consumidores e a spec WhatsApp
foram atualizados sem mudar grants REBAC.

### `slack canvas-access-delete`: remocao de compartilhamento imediata

O CI Linux [`31363483451`](https://github.com/filipexyz/ravi/actions/runs/31363483451)
do SHA `9d5802c5150851a54256e9cd786c30e9c6f3aa25` passou Build e Typecheck e
avancou ate a suite Slack. Cinquenta e oito testes do arquivo passaram; somente
o novo teste de `canvas-access-delete` falhou porque o helper de mutacoes ainda
retornava `WRITE_REQUIRES_EXECUTE`, exit 3, antes de hidratar credenciais ou
chamar `canvases.access.delete`.

A correcao mantem `kind: mutate`, recurso, acao, risco e redactions, remove
somente a confirmacao/flag e reutiliza o contexto Slack existente de execucao.
Remover acesso reduz compartilhamento e passa a executar em uma chamada. A
matriz Slack fica com 23 operacoes freadas e 13 imediatas; specs, skills,
runbooks e consumidores foram alinhados, sem mudanca de grants REBAC.

Por instrucao explicita do operador, nenhum Bun foi executado localmente. A
validacao local desta etapa foi revisao do diff, varredura de consumidores,
revisao independente e `git diff --check`.

O CI Linux [`31364200638`](https://github.com/filipexyz/ravi/actions/runs/31364200638)
do SHA `962c7969cab12bdd44b7682558065404093f5bde` passou Build, Typecheck,
Test e Quality Gate (specs + coverage), incluindo a consistencia dos snapshots
OpenAPI e SDKs TypeScript/Swift atualizados para as tres operacoes. Esse run
fecha a implementacao da fase 7. Como este registro factual cria um novo head,
o veredito final permanece condicionado a CI verde do proprio commit
documental; o resultado pode ser registrado no corpo da PR sem outro ciclo.

---

## FASE 8 - argv privado e compatibilidade de leitura (2026-08-10)

Esta fase substitui o veredito da fase 7 depois de uma nova revisao adversarial.
O bloqueador de privacidade nao fazia parte dos 26 bugs consolidados antes
desta rodada; com sua confirmacao, o inventario passa a 27 bugs de produto
confirmados e corrigidos. A compatibilidade abaixo e registrada separadamente
como migracao, nao como novo efeito desejado.

### Auditoria nao persiste valores crus de `argv`

O CI Linux [`31402772780`](https://github.com/filipexyz/ravi/actions/runs/31402772780)
do SHA `864ee56209704dbfa3a82407c59c2c57c7f62b71` passou Build e Typecheck e
falhou somente no novo teste adversarial. `cliInvocation.process.argv`
preservava titulo e `--instructions` de task, URI privada de artifact e convite
posicional de WhatsApp. A evidencia mostrou ainda que `parentProcess.argv`
podia carregar a linha integral do processo pai.

A correcao remove a lista incompleta de aliases sensiveis. Proveniencia de
processo e processo pai agora guarda somente `[REDACTED:argv count=N]`; comando
canonico e `input` redigido continuam nos campos proprios do evento. O run
[`31403300522`](https://github.com/filipexyz/ravi/actions/runs/31403300522)
detectou um import removido em excesso no Typecheck; o commit `457ff42d`
restaurou somente esse import. O CI
[`31403444146`](https://github.com/filipexyz/ravi/actions/runs/31403444146)
passou Build, Typecheck, Test e Quality Gate (specs + coverage), incluindo
sentinelas nos tres formatos e a proveniencia do processo pai.

### `whatsapp dm read --no-ack` permanece aceito durante a migracao

O comportamento normativo permanece: `dm read` e leitura local `read` e nunca
envia receipt; `dm ack --execute` e a operacao externa explicita. Para evitar
quebrar scripts seguros existentes, `--no-ack` volta como no-op obsoleto e nao
deve ser usado por consumidores novos. `--execute` continua rejeitado em
`dm read`, evitando sucesso enganoso para quem esperava envio de receipt.

O CI [`31403868928`](https://github.com/filipexyz/ravi/actions/runs/31403868928)
do SHA `2c4460ae667f016f2e34db4c85ccf8641ed22094` passou Build e Typecheck e
falhou somente porque a flag de compatibilidade ainda nao existia. Depois da
implementacao, o run
[`31404175734`](https://github.com/filipexyz/ravi/actions/runs/31404175734)
passou os testes comportamentais e falhou apenas no check deterministico que
identificou quatro artefatos TypeScript divergentes. OpenAPI e SDKs
TypeScript/Swift foram alinhados em commit dedicado, com `GIT_SHA` preservado.

Por instrucao explicita do operador, nenhum Bun foi executado localmente. O
head final com este registro e os snapshots atualizados ainda precisa passar a
CI completa antes de restaurar o veredito **APPROVE**.

---

## FASE 9 - fundacao compartilhada de CLI agent-first (2026-08-21)

Esta fase inicia em estado **DRAFT**. Ela adiciona a fronteira comum de saida,
erros publicos tipados, validadores de campos e paginacao e metadados
descobríveis de operacao, efeito, risco e confirmacao. As regras de negocio e a
prova de ausencia de efeito de cada mutacao continuam pertencendo aos PRs de
dominio.

A primeira candidata foi classificada como **NO-GO** pela revisao independente:
os gates `test:agent-contract` e `test:sdk` excederam limites de tempo, os dois
testes centrais novos nao estavam listados em `CHECKS.md` e a spec prometia
rigidez de campos e classificacao real alem do recorte migrado. O ocorrido esta
registrado em `docs/postmortems/0001-cli-foundation-gates-no-go.md`.

O recorte factual desta fase e:

- `agents list` e o primeiro comando com campos estritos; os demais permanecem
  legados ate o PR de seu dominio;
- leituras sao projetadas como `none`, enquanto mutacoes sem revisao permanecem
  visivelmente `unclassified`;
- a prova sintetica valida o mecanismo comum de freio, nao substitui a prova de
  uma mutacao real;
- a fronteira de flush cobre comandos registrados de execucao unica; loops
  interativos e callbacks de ciclo de vida permanecem excecoes declaradas;
- o limite maximo de paginacao deixa de ser reduzido silenciosamente e passa a
  falhar como erro de uso.

Promocao para `active`, commit, push e PR ficam condicionados aos gates oficiais
aplicaveis e a uma nova revisao independente do SHA exato.

### Terceira revisao independente e liberacao para PR

A terceira revisao independente classificou a candidata local como
**CLOSABILITY_READY · INDEPENDENTLY_VERIFIED · LIVE_UNAUTHORIZED**. Ela
confirmou a supressao NATS em chamadas permitidas e negadas, a mascara restrita
ao literal de `GIT_SHA`, a taxonomia de exit e a coerencia entre codigo, Ravi
Spec, ADR, runbook e postmortem.

No estado aprovado, `test:sdk` passou com 75 testes e 297 assercoes,
`tools-export` com 14 testes e 65 assercoes, typecheck, build, quality gate
sobre 34 caminhos e lint documental passaram. O `test:agent-contract` passou
fora das mesmas duas falhas de portabilidade de `artifacts/store.test.ts`
reproduzidas na `dev` no Windows. O pacote instalavel local tem SHA-256
`581CA4862028E0A91C5025B9AE575188F8E16C1AA857731088F13DE436DF4B75`.

Este GO autoriza commit, push e abertura da PR. A spec permanece `draft` e
qualquer merge ou uso na VPS continua condicionado a CI Linux verde no commit
exato e a autorizacao humana de implantacao.

### Correcao da espera de saida sem limite

A auditoria posterior ao primeiro commit encontrou uma espera sem prazo quando
o Bun mantinha o indicador de buffer ativo. A fundacao passou a verificar o
progresso em intervalos curtos, interromper a espera depois de cinco segundos,
garantir a terminacao em `finally` e remover a segunda descarga no encerramento
global.

O teste nativo agora cobre stream permanentemente preso e processo-filho que
excede seu prazo, alem dos caminhos reais de JSON maior que 64 KiB, falha e
versao. O recorte focado passou com 23 testes e 93 assercoes; metadados,
paginacao e runtime passaram com 27 testes e 107 assercoes; `test:sdk` passou
com 75 testes e 297 assercoes, seguido de `sdk:check`. Typecheck, build, quality
gate dos 34 caminhos e lint documental tambem passaram.

O GO anterior fica superado pela mudanca de codigo. Novo commit, pacote e
revisao independente do SHA exato sao obrigatorios antes de push e PR.

### Primeira CI Linux da PR 426

O run Linux `32450827025` do SHA
`677cd83857fe6b6d2f92e66b3fd2dd61d4928f3c` passou pela suite de canais e
avancou ate os testes da CLI, mas falhou ao carregar sincronamente o bundle do
daemon. O top-level await adicionado pela fronteira de saida tornou o bundle
incompativel com o `require` usado pelo PM2, embora a execucao direta local
continuasse funcional.

O caminho de versao foi movido para `bootstrapCli` e a promessa raiz voltou a
ser iniciada sem top-level await. A CI vermelha invalida o GO e o pacote do SHA
anterior. Nova validacao integral, pacote, revisao independente e CI Linux sao
obrigatorios.

Na revalidacao local, uma selecao ampliada incluiu indevidamente
`src/runtime/codex-provider.test.ts`: 20 casos de scripts `.mjs` temporarios
falharam com `ENOENT` no Windows e 50 passaram. O recorte correto da fundacao,
sem esse arquivo alheio, passou com 27 testes e 107 assercoes. A suite integral
permanece sob autoridade da CI Linux do novo SHA.

O bundle corrigido foi carregado sincronamente por `require` e `daemon status`
terminou com codigo 0. O recorte de saida e erros passou com 23 testes e 93
assercoes; o SDK completo passou com 75 testes e 297 assercoes, seguido de
`sdk:check`. Typecheck, build integral, quality gate dos 34 caminhos e lint
documental tambem passaram. O fechamento ainda depende de commit exato, revisao
independente, novo pacote e CI Linux verde no mesmo SHA.

A segunda CI Linux, run `32451955010` no SHA
`ec6d13ccdcbcdb90b7b8a224c90a4f8892e2af16`, passou build, typecheck e o teste
sincrono do daemon, mas falhou em dois casos de `sdk.test.ts`. Catches antigos
do SDK recapturavam o sinal privado de termino de `fail()` e substituiam a
mensagem publica por `CLI termination requested.`.

A correcao relanca a mesma instancia privada antes de qualquer conversao de
erro e concentra todos os catches externos do SDK nesse funil. Os dois testes
agora exigem codigo 1, exatamente uma mensagem publica e ausencia do texto
interno. O recorte afetado passou com 26 testes e 74 assercoes. Os testes de
comandos posteriores ao SDK tambem passaram; somente o cleanup de
`tasks-profiles.test.ts` repetiu os tres `EBUSY` ja conhecidos da base Windows.
O NO-GO permanece ate novo commit, pacote, revisao independente e CI Linux.

Na revalidacao final da segunda correcao, contexto, sinal, saida nativa, SDK,
ferramentas e gateway passaram com 86 testes e 310 assercoes. O processo real
passou com 11 testes e 63 assercoes; o SDK completo passou com 75 testes e 297
assercoes, seguido de `sdk:check`. Typecheck, build integral e quality gate dos
36 caminhos passaram.

O primeiro `biome check` apontou apenas finais de linha misturados nos dois
arquivos SDK editados no Windows. A formatacao oficial corrigiu o problema; o
check e os 20 testes dos arquivos formatados passaram. Novo SHA, pacote, revisao
independente e CI Linux verde continuam obrigatorios.

### COMMANDS read-only agent-first - incremento local

**Base:** `560517a43248c3798f82e3da98c088df0743016e`. O slice cobre
`commands list`, `show`, `validate` e `run`; nenhuma operacao escreve e `run`
continua sendo somente preview do prompt. A fachada conversacional proposta no
dossie foi adiada porque revisao do registry, integridade do envelope,
sombreamento real, materialidade e roteamento de engine ainda exigem decisao.

**Contrato implementado:** nome vazio/invalido vira
`INVALID_COMMAND_NAME`, exit 2, antes da resolucao do agente; paginacao invalida
preserva o `USAGE_ERROR`, exit 2, da fundacao; `--fields` usa um conjunto
estavel de 13 campos e rejeita qualquer desconhecido, inclusive misturado ou
com lista vazia. Permanecem compativeis nomes sem distincao de caixa e com `#`,
`items` igual a `commands`, veredito exit 1 de `validate` e
`renderedPromptSha256`.

**Evidencia nativa:** contrato do handler 24/24, 93 assercoes; registro e
renderer 7/7, 24 assercoes; processo real isolado 9/9, 33 assercoes. O grupo
sem subcomando imprimiu help com exit 0. As quatro
operacoes preservaram hashes dos command files e o digest logico final de
agente, rotas e sessoes; auditoria NATS ficou suprimida no processo isolado.
Os testes proporcionais da fundacao de registry passaram 27/27, com 76
assercoes. Codegen e `sdk:check`, typecheck, build integral, Biome dos seis
arquivos TS, markdownlint dos dez documentos e quality gate explicito dos 18
caminhos passaram. A geracao atualizou a descricao de `--fields` no schema SDK
e o hash de registry/versionamento derivado.

**Estado:** implementacao local pronta para revisao, sem commit, push, PR ou
VPS. A fachada futura e as decisoes acima permanecem fora deste incremento.

### Correcao da divergencia dos contratos gerados

A verificacao independente do handoff encontrou os dois snapshots OpenAPI e
cinco artefatos Swift divergentes do registry vivo, apesar do relato anterior
de que estavam atuais. O TypeScript SDK estava sincronizado, mas isso nao prova
as outras superficies. A candidata voltou para **NO-GO** sem commit, pacote,
push, PR ou acesso remoto.

Os dois OpenAPI e todos os arquivos Swift foram regenerados pelos comandos
oficiais. O incidente esta em
`docs/postmortems/0002-commands-generated-contract-drift.md`. Checks de drift,
SDK e gates finais devem ser repetidos antes de qualquer promocao.

### Fechamento local da divergencia gerada de COMMANDS

Depois da regeneracao oficial, os dois checks OpenAPI e o check deterministico
do SDK Swift passaram separadamente. O SDK completo passou 75 testes com 297
assercoes e `sdk:check` verde. O recorte de commands foi repetido e passou 40
testes com 150 assercoes, incluindo nove casos de processo real isolado.

Typecheck, build integral, Biome focado, lint dos nove documentos aplicaveis e
quality gate dos 23 caminhos com 274 specs indexadas tambem passaram. Isso
fecha apenas a correcao local do drift. Commit exato, pacote, nova auditoria
independente e CI Linux ainda sao obrigatorios antes de push ou PR; merge e VPS
continuam fora deste checkpoint.

Uma recaptura posterior do Biome encontrou finais de linha Windows no arquivo
compartilhado de schemas depois da geracao. O formatador oficial normalizou
somente esse arquivo, sem mudanca semantica. O Biome focado e os 40 testes de
commands foram repetidos; as 150 assercoes passaram. A evidencia de estilo e
teste anterior a essa normalizacao nao e usada como captura final.

### Recaptura final do coordenador para COMMANDS

O recorte final passou 40 testes com 150 assercoes e typecheck. A primeira
execucao do SDK sob carga paralela teve timeout em dois hooks inalterados de
cinco segundos e foi descartada; a repeticao isolada passou os 75 testes com
297 assercoes e `sdk:check`.

Passaram tambem os dois checks OpenAPI, o check deterministico Swift, build
integral, Biome dos seis fontes de commands/framework, lint dos 11 documentos
alterados localmente, `git diff --check`, os 40 testes nativos do quality gate e
o runner sobre 56 caminhos acumulados da foundation e do dominio. Foram
indexadas 274 specs, com aprovacao de `cli/commands`, `cli/foundation` e
`commands`. O drift gerado esta fechado localmente. Ainda faltam commit exato,
pacote, auditoria independente e CI Linux; nao houve push, PR, merge ou VPS.

### NO-GO independente do pacote COMMANDS

A auditoria independente rejeitou o commit
`d648b40691300af98818331313a7445b93ab1e90` e o pacote de 4.944.320 bytes com
SHA-256
`206A02D753F590AEF798A74DA80C93D93A0963EF0F0ED721A1E9B253A4C2F4AB`.
Nada foi enviado ou usado para abrir PR.

O `--fields` produzia registros parciais que os schemas publicados ainda
tratavam como completos; propriedades nao enumeraveis mascaravam o erro antes
do JSON real. As operacoes chamadas read-only tambem abriam SQLite gravavel,
alteravam WAL/SHM e tentavam auditoria NATS. O teste de processo suprimia esses
eventos e observava apenas parte do estado, deixando os efeitos escaparem.

Novo candidato deve tornar a projecao honesta depois de serializar, usar leitura
de configuracao sem inicializacao ou escrita, impedir auditoria por politica
declarada do dominio, comparar todos os arquivos e tabelas relevantes, testar o
help compartilhado e regenerar todos os contratos. O candidato rejeitado fica
em NO-GO definitivo.

### Recaptura do substituto de COMMANDS

O substituto removeu campos ocultos, publicou schema de projecao parcial
estrito, passou o retorno por round-trip JSON e usa leitura SQLite dedicada sem
inicializacao ou escrita. CLI, tool e gateway compartilham `audit: none`; a
politica agora recusa esse opt-out fora de leituras de baixo risco e efeito
`none`.

Passaram nove testes de processo com 51 assercoes sem supressao de auditoria,
41 testes isolados de gateway com 171 assercoes, 12 testes do router com 60
assercoes, 75 testes SDK com 297 assercoes, build, typecheck, Biome, Markdown e
todos os checks gerados. Uma captura paralela do gateway teve dois timeouts e
foi descartada; a repeticao isolada passou. O primeiro quality gate bloqueou a
falta do teste aprovado de router; depois dos dois casos nativos, o runner
passou sobre 35 caminhos e indexou 274 specs. Commit, pacote, auditoria
independente e CI Linux ainda sao obrigatorios; segue NO-GO para push ou PR.
