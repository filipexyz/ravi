---
name: permissions-manager
description: |
  Administra o provider legado de grants locais do Ravi. Use quando o usuário quiser:
  - Ver, conceder ou revocar grants locais de agents
  - Verificar se o estado do provider local-grants permitiria algo
  - Sincronizar grants locais com configs dos agents
  - Entender a diferença entre grants legados, materialização e provider runtime
---

# Permissions Manager (legacy relation ledger)

O Ravi usa o **Permission Provider Runtime** como única superfície de autorização.

`ravi permissions` administra o provider legado `local-grants`: ele mantém relações
locais e pode materializar capabilities em contextos runtime, mas não é a cadeia
ativa de autorização direta do core.

Consequências práticas:

- Runtime ativo autoriza por `provider-runtime`, principalmente por contexto já
  materializado (`context-capabilities`).
- Grants locais podem alimentar snapshots de capabilities por uma interface de
  materializer.
- Um grant local não deve ser tratado como bypass direto do runtime.
- `ravi permissions check` verifica o estado do provider legado, não garante que
  uma chamada runtime sem contexto será permitida.

Permissões no Ravi são relações: **(sujeito) tem (relação) sobre (objeto)**.

Exemplo: `(agent:dev) access (session:dev-*)` — o agent dev pode acessar sessões que começam com "dev-".

## IMPORTANTE: Object Types

O object type no grant DEVE corresponder ao que o provider/materializer usa. Se errar o type, a capability não materializa como esperado.

**Regra:** Comandos CLI usam `group:<nome-do-grupo>`. Sessões usam `session:<pattern>`. Sistema usa `system:*`.

## Referência Rápida de Grants

### Acesso a grupos de comandos CLI (scope: admin)

O scope `admin` no decorator `@Group` checa `execute` no object type `group`:

```bash
# Formato: ravi permissions grant agent:<id> execute group:<grupo>

# Daemon (restart, status, logs)
ravi permissions grant agent:dev execute group:daemon

# Agents (create, delete, set, tools, bash)
ravi permissions grant agent:dev execute group:agents

# Sessions (list, send, ask, read, reset, delete...)
ravi permissions grant agent:dev execute group:sessions

# Contacts (list, add, approve, block, tags)
ravi permissions grant agent:dev execute group:contacts

# Routes (add, remove, set, list)
ravi permissions grant agent:dev execute group:routes

# Settings (list, get, set)
ravi permissions grant agent:dev execute group:settings

# Channels (status, start, stop, restart)
ravi permissions grant agent:dev execute group:channels

# Heartbeat (set, enable, disable, trigger)
ravi permissions grant agent:dev execute group:heartbeat

# Matrix (add, remove, send, rooms)
ravi permissions grant agent:dev execute group:matrix

# WhatsApp groups (create, members, invite)
ravi permissions grant agent:dev execute group:whatsapp.group

# Service (install, uninstall, start, stop)
ravi permissions grant agent:dev execute group:service
```

**Subcomando específico** — dá acesso a só um comando dentro do grupo:

```bash
# Só restart, não status/logs
ravi permissions grant agent:dev execute group:daemon_restart

# Só list, não create/delete
ravi permissions grant agent:dev execute group:agents_list
```

### Superadmin (scope: superadmin)

```bash
# Acesso total — permissions, e todos os outros grupos
ravi permissions grant agent:dev admin system:*
```

### Sessões (inline scope checks)

```bash
# Acessar sessões (ler, enviar)
ravi permissions grant agent:dev access session:dev-*

# Modificar sessões (reset, delete, rename, set-model)
ravi permissions grant agent:dev modify session:dev-*
```

### Contatos (scope: writeContacts)

```bash
# Criar/aprovar/bloquear contatos
ravi permissions grant agent:dev write_contacts system:*

# Ler contatos das próprias sessões
ravi permissions grant agent:dev read_own_contacts system:*

# Ler contatos com tag específica
ravi permissions grant agent:dev read_tagged_contacts system:leads
```

### Scope `open` e `resource`

`open` NÃO é bypass para runtime com agent.

- CLI local sem principal pode executar comandos `open`.
- Se houver `agentId`/contexto runtime, o contexto precisa ter `execute group:<grupo>` ou `execute group:<grupo>_<comando>`.
- `resource` continua usando checagens de ownership no comando, mas não deve ser usado para mutação sensível sem dono resolvido.

Exemplo:

```bash
ravi permissions grant agent:dev execute group:apps
ravi permissions grant agent:dev execute group:apps_run
```

## ERROS COMUNS

❌ **ERRADO** — usar `system:daemon` pra liberar o grupo daemon:

```bash
ravi permissions grant agent:dev execute system:daemon
```

Isso não funciona! O provider checa `group:daemon`, não `system:daemon`.

✅ **CERTO:**

```bash
ravi permissions grant agent:dev execute group:daemon
```

❌ **ERRADO** — usar `admin` pra dar acesso a um grupo específico:

```bash
ravi permissions grant agent:dev admin group:daemon
```

`admin` só funciona com `system:*` (superadmin total).

✅ **CERTO** — usar `execute`:

```bash
ravi permissions grant agent:dev execute group:daemon
```

❌ **ERRADO** — confundir `group` com `executable`:

```bash
ravi permissions grant agent:dev execute group:*   # libera comandos CLI, NÃO executáveis
```

✅ **CERTO** — object types separados:

```bash
ravi permissions grant agent:dev execute group:*        # comandos CLI
ravi permissions grant agent:dev execute executable:*   # executáveis do sistema
```

❌ **ERRADO** — relação errada pra executáveis:

```bash
ravi permissions grant agent:dev use executable:git   # "use" é pra SDK tools
```

✅ **CERTO:**

```bash
ravi permissions grant agent:dev execute executable:git  # executáveis usam "execute"
ravi permissions grant agent:dev use tool:Bash           # SDK tools usam "use"
```

### SDK Tools (use tool:\*)

Controla quais SDK tools um agent pode usar:

```bash
# Permitir tool específica
ravi permissions grant agent:dev use tool:Bash
ravi permissions grant agent:dev use tool:Read

# Permitir TODAS as tools (bypass)
ravi permissions grant agent:dev use tool:*

# Verificar estado legado do provider
ravi permissions check agent:dev use tool:Bash
```

SDK tools disponíveis: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`, `TaskOutput`, `TaskStop`, `TodoWrite`, `NotebookEdit`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `Skill`, `TeamCreate`, `TeamDelete`, `SendMessage`, `LSP`, `ToolSearch`.

### Overrides de delegação (`delegate_*`)

Em turn-scoped authority, o contexto efetivo é limitado por agent, ator e
superfície. Para liberar uma capability específica num grupo ou agent mesmo
quando o contato atual não tem o grant direto, use `delegate_<relação>`:

```bash
# O agent ainda precisa ter a capability normal
ravi permissions grant agent:dev use tool:Bash

# Exceção no grupo: satisfaz ator e superfície para esse chat
ravi permissions grant chat:chat_group_1 delegate_use tool:Bash

# Exceção no agent: satisfaz só a perna do ator; o chat ainda precisa permitir
ravi permissions grant agent:dev delegate_use tool:Bash
```

Regras:

- `delegate_use tool:Bash` não é `use tool:Bash`; ele só conta durante a
  materialização de contexto delegado.
- Override de chat satisfaz ator e superfície naquele chat.
- Override de agent satisfaz só o ator, e não ignora a política do chat.
- O teto do executor continua valendo: se o agent não tem `use tool:Bash`, o
  override não libera Bash.
- `delegate_admin` é rejeitado/ignorado; superadmin continua sendo fluxo de
  break-glass separado.
- Ator desconhecido e automação não recebem override humano; automações precisam
  de grants `automation:<id>`.

Diagnóstico:

```bash
ravi permissions explain use tool:Bash --agent dev --actor contact:luis --chat chat:chat_group_1 --json
```

O `explain` deve mostrar `delegate_use` como provenance quando um override
autoriza a decisão. Se a decisão final for `allowed=true`, os branches
`actor`, `surface` e `effective` não devem aparecer como `deny` para a mesma
capability. Em constraints de superfície, `constrain role:<id>` prevalece sobre
allows diretos da surface; só capabilities presentes no role constraint passam.

### Tool Groups (use toolgroup:\*)

Em vez de dar grant tool por tool, use **tool groups** pra conceder acesso a um conjunto de tools de uma vez:

```bash
# Conceder um grupo
ravi permissions grant agent:dev use toolgroup:read-only

# Conceder todos os grupos
ravi permissions init agent:dev tool-groups

# Revocar um grupo
ravi permissions revoke agent:dev use toolgroup:read-only

# Verificar — o check resolve transparentemente
ravi permissions check agent:dev use tool:Read   # ✓ se tem toolgroup:read-only
```

**Grupos disponíveis:**

| Grupo       | Tools                                                   |
| ----------- | ------------------------------------------------------- |
| `read-only` | Read, Glob, Grep, WebFetch, WebSearch, LSP, ToolSearch  |
| `write`     | Edit, Write, NotebookEdit                               |
| `execute`   | Bash, Task, TaskOutput, TaskStop                        |
| `plan`      | EnterPlanMode, ExitPlanMode, AskUserQuestion, TodoWrite |
| `teams`     | TeamCreate, TeamDelete, SendMessage                     |
| `navigate`  | EnterWorktree, Skill                                    |

**Como funciona:** Quando o provider checa `can(agent:X, use, tool, Read)`, se não encontra grant direto pra `tool:Read`, verifica se o agent tem algum `toolgroup` que inclui `Read`. Se sim, permite.

**Combina com grants individuais:** Um agent pode ter `toolgroup:read-only` + `tool:Bash` — os dois se somam.

### Executáveis do sistema (execute executable:\*)

Controla quais binários do sistema um agent pode rodar via Bash:

```bash
# Permitir executável específico
ravi permissions grant agent:dev execute executable:git
ravi permissions grant agent:dev execute executable:node
ravi permissions grant agent:dev execute executable:ravi

# Permitir TODOS os executáveis (bypass)
ravi permissions grant agent:dev execute executable:*

# Verificar
ravi permissions check agent:dev execute executable:git
```

### Templates (atalhos)

```bash
# SDK tools padrão (uma relação por tool)
ravi permissions init agent:dev sdk-tools

# Todas as SDK tools (wildcard)
ravi permissions init agent:dev all-tools

# Todos os tool groups (read-only, write, execute, plan, teams, navigate)
ravi permissions init agent:dev tool-groups

# Executáveis seguros (git, node, bun, ravi, etc.)
ravi permissions init agent:dev safe-executables

# Cobertura completa: wildcards em TODOS os object types reconhecidos pelo provider
# (tool, executable, toolgroup, agent, app, automation, calendar, chat, contact,
# cron, group, mailbox, network, platform_identity, session, system, team, trigger).
# Use quando o agent precisa operar livremente em todas as superfícies (sessions, contatos,
# triggers, crons, agents, system admin), não só rodar tools SDK + binários do sistema.
ravi permissions init agent:dev full-access
```

`full-access` significa "permitido pelo Ravi". Ele não promete que hooks globais do provider, policies locais, RTK, Codex/Claude PreToolUse ou outras integrações externas vão permitir o comando final. Se `permissions check` retorna permitido mas a tool ainda falha, trate como fronteira de runtime/hook e investigue a mensagem de denial antes de adicionar mais grants.

> **Nota histórica:** antes deste PR, `full-access` aplicava apenas `use tool:*` + `execute executable:*` (2 grants) — o nome prometia "tudo" mas deixava de fora as superfícies in-process do local-grants (sessions, contacts, agents, apps, automações, etc). Agora `full-access` cobre os pares `(relation, objectType)` válidos em um único comando.

## Lifetime dos Grants

Grants manuais novos são temporários por padrão.

```bash
# Temporário com TTL padrão de 1h
ravi permissions grant agent:dev execute group:apps

# Temporário customizado
ravi permissions grant agent:dev execute group:apps --ttl 15m
ravi permissions grant agent:dev execute group:apps --expires-at 2026-06-07T15:00:00Z

# Permanente só quando explícito
ravi permissions grant agent:dev execute group:apps --permanent
```

Use `ravi permissions list --all` para auditar grants ativos, expirados e revogados.

## Comandos

### Listar permissões

```bash
# Todas
ravi permissions list

# De um agent específico
ravi permissions list --subject agent:dev

# De um tipo de objeto
ravi permissions list --object group:contacts

# Por relação
ravi permissions list --relation access

# Por source
ravi permissions list --source manual
```

### Conceder permissão

```bash
ravi permissions grant <sujeito> <relação> <objeto>
```

### Revocar permissão

```bash
ravi permissions revoke <sujeito> <relação> <objeto>
```

### Verificar permissão

```bash
ravi permissions check <sujeito> <permissão> <objeto>
```

Verifica se a permissão é resolvida (incluindo wildcards e admin).

```bash
# Dev pode restartar o daemon?
ravi permissions check agent:dev execute group:daemon

# Dev pode acessar sessão dev-grupo1?
ravi permissions check agent:dev access session:dev-grupo1

# Main é superadmin?
ravi permissions check agent:main admin system:*
```

### Sincronizar com configs

```bash
ravi permissions sync
```

Re-lê as configs dos agents e regenera as relações `source=config`. Relações manuais não são afetadas.

### Limpar permissões

```bash
# Limpar só manuais
ravi permissions clear

# Limpar TUDO (inclusive config — rode sync depois)
ravi permissions clear --all
```

## Wildcards

Wildcards só funcionam no final do object ID:

- `*` — tudo
- `dev-*` — tudo que começa com "dev-"
- ❌ `*-dev` ou `a*b` — inválidos

## Sources

- `config` — Geradas automaticamente a partir da config dos agents (re-sync no boot)
- `manual` — Criadas via CLI, persistem entre restarts

## Como Funciona a Resolução

Quando o provider verifica `can(agent:dev, execute, group:daemon)`:

1. Agent é superadmin? → checa `(agent:dev, admin, system:*)` → sim = allowed
2. Relação direta? → checa `(agent:dev, execute, group:daemon)` → sim = allowed
3. Wildcard? → checa `(agent:dev, execute, group:*)` → sim = allowed
4. Pattern match? → checa patterns como `group:dae*` → match = allowed
5. **Tool group?** → se objectType é `tool`, checa se o agent tem algum `toolgroup` que contém essa tool → sim = allowed
6. Nenhum match → denied
