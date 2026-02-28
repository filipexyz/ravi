# Plano: Instâncias como Entidade Central

**Data:** 2026-02-27
**Status:** Planejamento
**Contexto:** Preparação para unificação Ravi + Omni

---

## Problema

Hoje "account" não existe como entidade. É um namespace de settings avulsos:

```
account.main.instanceId   = "ef5a692e-..."
account.main.agent        = "main"
account.main.dmPolicy     = "open"        ← acabamos de adicionar
account.main.groupPolicy  = "allowlist"   ← acabamos de adicionar
```

Isso é frágil, não é descobrível por agentes, e não escala. Policies, rotas e configurações de comportamento não têm dono claro.

O objetivo é: **instância é a entidade central**. Tudo parte dela. Um agente pode ler e configurar qualquer coisa via `ravi instances <name> <comando>`.

---

## Modelo de Dados

### Tabela `instances`

Substitui o namespace `account.*` em settings.

```sql
CREATE TABLE instances (
  name             TEXT PRIMARY KEY,           -- "main", "vendas", "ravi-the-bot"
  instance_id      TEXT UNIQUE,                -- UUID do Omni (null até unificação completa)
  channel          TEXT NOT NULL DEFAULT 'whatsapp',  -- whatsapp | telegram | discord | slack
  agent            TEXT REFERENCES agents(id), -- agent padrão
  dm_policy        TEXT NOT NULL DEFAULT 'open',      -- open | pairing | closed
  group_policy     TEXT NOT NULL DEFAULT 'open',      -- open | allowlist | closed
  dm_scope         TEXT,                       -- override de DmScope pra essa instância
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
```

### Tabela `routes` — adição de `policy`

Rotas já existem e têm `account_id` (= instance name). Adicionar campo de override de policy por rota:

```sql
ALTER TABLE routes ADD COLUMN policy TEXT;
-- NULL = herda da instância
-- "open" | "pairing" | "closed" | "allowlist" = override explícito
```

Isso permite: instância com `groupPolicy: closed`, mas rota `group:120363*` com `policy: open`.

### Hierarquia de resolução (policy)

```
route.policy                              ← mais específico
  ↓ (null)
instance.dm_policy / instance.group_policy
  ↓ (null / instância não encontrada)
settings["whatsapp.groupPolicy"]          ← legacy, mantido por compatibilidade
  ↓ (null)
"open"                                    ← default hardcoded
```

---

## CLI: `ravi instances`

Substitui `ravi whatsapp` e absorve `ravi channels status`. Semântica explícita — projetado para uso por agentes.

### Gerenciamento

```bash
ravi instances list
# Lista todas as instâncias com status de conexão, agent, policies

ravi instances show <name>
# Detalhes completos: instance_id, channel, agent, policies, dm_scope, rotas

ravi instances create <name> --channel whatsapp --agent main
# Cria instância local (sem conectar ainda)

ravi instances connect <name> [--channel whatsapp]
# Conecta ao Omni (QR code para WhatsApp, token para outros)
# Absorve: ravi whatsapp connect

ravi instances disconnect <name>
# Desconecta do Omni

ravi instances status <name>
# Status de conexão (isConnected, profileName, etc)
```

### Configuração

```bash
ravi instances set <name> agent <agent-id>
ravi instances set <name> dmPolicy open|pairing|closed
ravi instances set <name> groupPolicy open|allowlist|closed
ravi instances set <name> dmScope per-peer|per-channel-peer|main|per-account-channel-peer

ravi instances get <name> dmPolicy
# Lê valor atual de qualquer campo
```

### Rotas (subgrupo)

Substitui `ravi routes` com contexto explícito de instância.
`ravi routes` continua funcionando como alias (`--account` vira posicional).

```bash
ravi instances routes list <name>
# Lista rotas da instância com detalhes (pattern, agent, policy, priority)

ravi instances routes add <name> <pattern> <agent> [--priority N] [--policy open|closed|pairing|allowlist] [--session <name>] [--dm-scope <scope>]
# Exemplos:
#   ravi instances routes add main "5511*" agent-vendas
#   ravi instances routes add main "group:120363*" agent-grupos --priority 10
#   ravi instances routes add main "thread:*" agent-suporte --policy closed
#   ravi instances routes add main "*" agent-main --policy open

ravi instances routes remove <name> <pattern>

ravi instances routes set <name> <pattern> <key> <value>
# ravi instances routes set main "group:120363*" policy open
# ravi instances routes set main "5511*" agent agent-novo
# ravi instances routes set main "5511*" priority 5

ravi instances routes show <name> <pattern>
# Mostra config completa de uma rota específica
```

### Pendentes

```bash
ravi instances pending list <name>
# Contatos/grupos que tentaram falar mas foram bloqueados por policy

ravi instances pending approve <name> <contact-id>
# Aprova contato → status "allowed" → desbloqueia mensagens futuras

ravi instances pending reject <name> <contact-id>
# Rejeita e descarta
```

---

## Patterns de Rota

O resolver já suporta glob (`*`, `5511*`) e prefixo `group:`. Adicionar:

| Pattern | Exemplo | Semântica |
|---|---|---|
| Número exato | `5511999999999` | DM de número específico |
| Glob | `5511*` | DM de qualquer número com prefixo |
| Grupo | `group:120363418598014488` | Grupo específico |
| Grupo glob | `group:*` | Qualquer grupo |
| Thread | `thread:120363*` | Thread em qualquer grupo com prefixo |
| Thread glob | `thread:*` | Qualquer thread |
| Wildcard | `*` | Catch-all |

Thread usa `threadId` que já é extraído pelo consumer (Slack: `threadTs`, Discord: `threadId`). Falta só o matching no resolver.

---

## Fluxo de Resolução (consumer.ts)

Hoje `resolvePolicy()` faz lookup em 4 camadas de settings. Com a tabela `instances`:

```typescript
function resolvePolicy(
  policyName: "dm_policy" | "group_policy",
  instanceName: string,
  routePolicy?: string,
  defaultValue = "open"
): string {
  // 1. Override explícito na rota
  if (routePolicy) return routePolicy;

  // 2. Config da instância
  const instance = dbGetInstance(instanceName);
  if (instance?.[policyName]) return instance[policyName];

  // 3. Legacy global (compatibilidade)
  const legacyKey = policyName === "dm_policy" ? "whatsapp.dmPolicy" : "whatsapp.groupPolicy";
  return dbGetSetting(legacyKey) ?? defaultValue;
}
```

---

## Fases de Implementação

### Fase 1 — Tabela + migração (sem quebrar nada)

1. Criar tabela `instances` no schema do SQLite
2. Migration: ler todos os `account.*` settings → inserir em `instances`
3. `loadRouterConfig()` passa a ler de `instances` em vez de settings
4. `resolvePolicy()` no consumer usa `instances` (com fallback para settings)
5. `ravi instances list/show/set/get` — comandos básicos

**Resultado:** tudo funciona como antes, mas instances têm tabela própria. Settings `account.*` ficam como legacy (não deletar ainda).

### Fase 2 — CLI completo

1. `ravi instances connect/disconnect/status` (absorve `ravi whatsapp connect`)
2. `ravi instances routes list/add/remove/set/show`
3. `ravi instances pending list/approve/reject`
4. `ravi instances create`
5. `RouteConfig.policy` — campo `policy` em routes + matching no consumer

**Resultado:** CLI semântico completo. Agentes podem configurar tudo via `ravi instances`.

### Fase 3 — Thread patterns

1. Adicionar `thread:` matching no resolver
2. Thread pattern → usa `threadId` já extraído pelo consumer
3. Documentar patterns disponíveis

### Fase 4 — Deprecações

1. `ravi whatsapp` → alias para `ravi instances` com aviso de deprecação
2. `ravi channels status` → alias para `ravi instances list`
3. `ravi routes` → alias para `ravi instances routes` (mantendo flag `--account` por compatibilidade)
4. Settings `account.*` → aviso se encontrados, mas ainda funciona

### Fase 5 — Unificação com Omni (quando chegar)

1. `instance_id` passa a vir do Omni como fonte de verdade
2. Campos `channel`, `name`, `status` do Omni sincronizados localmente (ou consultados em runtime)
3. `ravi instances connect` chama diretamente o Omni unificado
4. Settings `account.*` removidos

---

## O que NÃO muda

- Tabela `routes` — apenas adiciona coluna `policy`
- Tabela `sessions` — intacta
- Tabela `agents` — intacta
- Lógica de `resolveRoute()` — mesma, inputs ficam mais limpos
- NATS/JetStream — nada
- OmniSender — nada
- Como o agente recebe contexto — nada
- `ravi routes` continua funcionando (alias)

---

## Impacto nos arquivos

| Arquivo | O que muda |
|---|---|
| `src/router/router-db.ts` | Tabela `instances`, CRUD functions, migration |
| `src/router/types.ts` | `InstanceConfig` interface, `RouteConfig.policy` |
| `src/router/config.ts` | `loadRouterConfig()` lê de `instances` em vez de settings |
| `src/omni/consumer.ts` | `resolvePolicy()` usa `dbGetInstance()` |
| `src/cli/commands/instances.ts` | Novo arquivo — CLI completo |
| `src/cli/commands/whatsapp.ts` | Vira alias / deprecado |
| `src/cli/commands/channels.ts` | Vira alias |
| `src/cli/commands/routes.ts` | Mantido como alias com `--account` |
| `src/cli/commands/settings.ts` | Remove pattern validators `account.*` (Fase 4) |
| `src/router/resolver.ts` | Adicionar `thread:` pattern matching (Fase 3) |

---

## Notas sobre a unificação com Omni

Quando Ravi e Omni se fundirem, o que o Ravi chama de "instance" é o que o Omni chama de "instance". A diferença é que o Omni é dono do canal/conexão, e o Ravi é dono do comportamento do bot (agent, policies, rotas).

A separação de responsabilidades que deve ser mantida mesmo após a unificação:

- **Omni sabe:** instanceId, channelType, status de conexão, profileName, mensagens
- **Ravi sabe:** qual agent responde, policies de acesso, rotas, configurações de sessão

A tabela `instances` do Ravi não duplica o Omni — ela complementa com o que o Omni não precisa saber.
