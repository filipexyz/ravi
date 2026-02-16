---
name: permissions-manager
description: |
  Gerencia permissões REBAC do sistema Ravi. Use quando o usuário quiser:
  - Ver, conceder ou revocar permissões de agents
  - Verificar se um agent tem permissão pra algo
  - Sincronizar permissões com configs dos agents
  - Entender o modelo de permissões
---

# Permissions Manager (REBAC)

Permissões no Ravi são relações: **(sujeito) tem (relação) sobre (objeto)**.

Exemplo: `(agent:dev) access (session:dev-*)` — o agent dev pode acessar sessões que começam com "dev-".

## IMPORTANTE: Object Types

O object type no grant DEVE corresponder ao que o engine checa. Se errar o type, a permissão não funciona.

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

### Grupos que NÃO precisam de grant (scope: open/resource)

Estes funcionam pra qualquer agent sem grant:
- `sessions` (open) — mas comandos de modificação checam session scope inline
- `media` (open)
- `react` (open)
- `tools` (open)
- `transcribe` (open)
- `video` (open)
- `whatsapp.dm` (open)
- `cron` (resource) — checa ownership do recurso
- `triggers` (resource) — checa ownership do recurso
- `outbound` (resource) — checa ownership do recurso

## ERROS COMUNS

❌ **ERRADO** — usar `system:daemon` pra liberar o grupo daemon:
```bash
ravi permissions grant agent:dev execute system:daemon
```
Isso não funciona! O engine checa `group:daemon`, não `system:daemon`.

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

### SDK Tools (use tool:*)

Controla quais SDK tools (Bash, Read, Edit, Write, etc.) um agent pode usar:

```bash
# Permitir tool específica
ravi permissions grant agent:dev use tool:Bash
ravi permissions grant agent:dev use tool:Read

# Permitir TODAS as tools (bypass)
ravi permissions grant agent:dev use tool:*

# Verificar
ravi permissions check agent:dev use tool:Bash
```

SDK tools disponíveis: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`, `TodoRead`, `TodoWrite`, `NotebookEdit`, `AskUserQuestion`.

### Executáveis do sistema (execute executable:*)

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
# SDK tools padrão (Bash, Read, Edit, Write, etc.)
ravi permissions init agent:dev sdk-tools

# Todas as SDK tools
ravi permissions init agent:dev all-tools

# Executáveis seguros (git, node, bun, ravi, etc.)
ravi permissions init agent:dev safe-executables

# Tudo: todas tools + todos executáveis
ravi permissions init agent:dev full-access
```

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

Quando o engine verifica `can(agent:dev, execute, group:daemon)`:

1. Agent é superadmin? → checa `(agent:dev, admin, system:*)` → sim = allowed
2. Relação direta? → checa `(agent:dev, execute, group:daemon)` → sim = allowed
3. Wildcard? → checa `(agent:dev, execute, group:*)` → sim = allowed
4. Pattern match? → checa patterns como `group:dae*` → match = allowed
5. Nenhum match → denied
