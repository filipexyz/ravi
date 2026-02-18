---
name: ravi-architecture
description: |
  Documentacao completa da arquitetura do Ravi. Use quando precisar:
  - Entender como o sistema funciona end-to-end
  - Modificar componentes existentes
  - Adicionar novos subsistemas
  - Debugar fluxos de mensagem
  - Onboarding no codebase
---

# Ravi - Arquitetura do Sistema

Ravi é um sistema multi-agent construído sobre o Claude Agent SDK que orquestra conversas em múltiplas plataformas via omni (WhatsApp, Discord, Telegram).

**Repositório:** `/Users/luis/dev/filipelabs/ravi.bot`
**Runtime:** Bun | **DB:** SQLite | **PubSub:** NATS JetStream | **AI:** Claude SDK

## Fluxo Principal de Mensagens

```
[WhatsApp/Discord/Telegram]
    -> omni API (child process)
    -> NATS JetStream (stream MESSAGE)
    -> OmniConsumer (subscriber JetStream)
    -> nats.emit("ravi.{sessionKey}.prompt")
    -> RaviBot (Claude SDK query)
    -> nats.emit("ravi.{sessionKey}.response")
    -> Gateway
    -> OmniSender (HTTP POST /api/v2/messages/send)
    -> omni API
    -> [WhatsApp/Discord/Telegram]
```

## Componentes Core

### daemon.ts - Ponto de Entrada
Orquestra startup de todos os subsistemas:
1. Carrega env de `~/.ravi/.env`
2. Inicia nats-server com JetStream (`local/server.ts`)
3. Inicia omni API server (`local/omni.ts`)
4. Inicia RaviBot (Claude SDK)
5. Inicia OmniConsumer + Gateway
6. Inicia HeartbeatRunner, CronRunner, OutboundRunner, TriggerRunner

Shutdown tem timeout global de 15s (force-exit se travar).

### local/server.ts - nats-server
Spawna nats-server com JetStream habilitado (`-js`). Armazena em `~/.ravi/jetstream/`.
Inclui recovery automático: se startup falhar (WAL corrompido), limpa storage e reinicia.

### local/omni.ts - omni API
Spawna omni API como child process (bun). Gerencia:
- Build do bundle na primeira vez
- Migrations de banco
- API key bootstrap (`~/.ravi/omni-api-key`)
- Healthcheck via HTTP GET /health

### omni/consumer.ts - Inbound
Subscriber de dois streams JetStream do omni:
- `MESSAGE` (filter: `message.received.>`) → prompts de agente
- `INSTANCE` (filter: `instance.>`) → QR codes, conexão

Comportamento:
- `start()` aguarda consumers ficarem prontos (timeout 60s, continua em background)
- `msg.ack()` apenas após handler suceder; `msg.nak()` em erro (retry automático)
- Auto-reconnect em erro de consumo (loop com retry 2s)
- Config subscription com auto-reconnect para `ravi.config.changed`

### omni/sender.ts - Outbound
HTTP client para omni REST API (`@omni/sdk`). Métodos:
- `send(instanceId, to, text)` — texto
- `sendTyping(instanceId, to, active)` — indicador de digitação
- `sendReaction(instanceId, to, messageId, emoji)` — reação
- `sendMedia(instanceId, to, path, type, filename, caption)` — mídia

Retry com backoff exponencial (3x, 1s/2s/3s). Só retenta TypeErrors (rede) e 5xx.

### gateway.ts - Orquestrador Interno
Subscriptions internas do ravi (não gerencia canais):
- `ravi.*.response` → OmniSender.send()
- `ravi.outbound.deliver` → OmniSender.send()
- `ravi.*.claude` → typing heartbeat → OmniSender.sendTyping()
- `ravi.outbound.reaction` → OmniSender.sendReaction()
- `ravi.config.changed` → sync REBAC

### bot.ts - Core do Bot
Processa prompts usando Claude Agent SDK.

**Fluxo:**
1. Subscribe em `ravi.*.prompt`
2. Resolve agent config pela session key
3. Debounce se configurado
4. Cria/resume SDK session
5. Streama resposta → emite responses parciais
6. Gerencia interrupts (msg nova durante processamento)

**Abort control:**
- Cada sessão tem AbortController
- Novo prompt aborta subprocess anterior
- Daemon stop aborta TODOS os controllers
- Watchdog de 5min detecta sessões travadas

### router/ - Sistema de Roteamento

**Resolução de rota (prioridade):**
1. `account.{id}.agent` setting
2. Agent atribuído ao contato
3. Rota com pattern match
4. Agent default

**Session keys:**
```
agent:{agentId}:{scope}:{peerId}
agent:main:main                          # Todas DMs (scope=main)
agent:main:dm:5511999                    # Por contato
agent:main:whatsapp:group:123456         # Grupo
agent:main:outbound:queueId:phone        # Outbound
```

**Arquivos:**
- `router/resolver.ts` - Resolve rota → session key
- `router/session-key.ts` - Constrói/parseia session keys
- `router/sessions.ts` - CRUD de sessões (SQLite)
- `router/config.ts` - Carrega config de agents/routes
- `router/router-db.ts` - Camada de banco

## Subsistemas de Automação

### Outbound (`outbound/`)
Campanhas de mensagens proativas com processamento round-robin.

**Fluxo:**
1. Runner pega próxima queue do DB
2. Arma timer para `nextRunAt`
3. Processa entries por prioridade:
   - Response entries (contato respondeu)
   - Follow-up entries (sem resposta, precisa follow-up)
   - Initial outreach (entries pendentes)
4. Manda prompt para agent com contexto da campanha

**Qualificação:** cold → warm → interested → qualified/rejected

### Triggers (`triggers/`)
Automação event-driven disparada por eventos do sistema.

**Fluxo:**
1. Runner subscribe em topics configurados
2. Evento dispara → busca triggers ativos com match
3. Emite prompt para sessão target do trigger
4. Respeita cooldown entre disparos

### Cron (`cron/`)
Jobs agendados com suporte a múltiplos formatos.

**Schedules:** cron expression | interval ("30m") | daily ("09:00") | at (one-time)

**Fluxo:** Timer → job due → emite prompt → calcula próximo run

### Heartbeat (`heartbeat/`)
Check-ins periódicos de agents dentro de horários ativos.

**Fluxo:**
1. Checa agents com heartbeat enabled
2. Para cada sessão, verifica se está due
3. Checa active hours (timezone-aware)
4. Envia prompt de status check
5. `HEARTBEAT_OK` = silencioso, qualquer outro texto = envia pro canal

### Session Messaging (`cli/commands/sessions.ts`)
Mensagens entre sessões (inter-session communication).

**Comandos:** `sessions send` | `sessions inform` | `sessions execute` | `sessions ask` | `sessions answer`

## Sistema de Plugins

**Duas fontes:**
1. **Internos** - Embutidos no build, extraídos para `~/.cache/ravi/plugins/`
2. **Usuário** - Customizados em `~/ravi/plugins/`

**Build time:** `gen-plugins.ts` escaneia `src/plugins/internal/` e gera `internal-registry.ts`
**Runtime:** `discoverPlugins()` extrai internos + escaneia user dir → passa para SDK

## Sistema de Hooks

### PreToolUse (bash/hook.ts)
Intercepta chamadas Bash e valida permissões via REBAC.
Checa `agentCan(id, "execute", "executable", exec)` pra cada executável parsed.

### PreCompact (hooks/pre-compact.ts)
Extrai memórias antes do SDK compactar contexto.
Lê `COMPACT_INSTRUCTIONS.md` do agent, roda modelo barato em background, atualiza `MEMORY.md`.

## Infraestrutura CLI

### Decorators
```typescript
@Group({ name: "agents" })
class AgentCommands {
  @Command({ name: "list" })
  list() { ... }

  @Command({ name: "create" })
  create(@Arg("id") id: string) { ... }
}
```

### Contexto (AsyncLocalStorage)
```typescript
runWithContext({ sessionKey, agentId, source }, async () => {
  const ctx = getContext();
});
```

## Storage

```
~/ravi/ravi.db          - SQLite: agents, routes, sessions, contacts, settings
~/.ravi/.env            - API keys e env vars
~/.ravi/omni-api-key    - API key para omni (auto-gerada)
~/.ravi/jetstream/      - JetStream storage (nats-server)
~/.ravi/logs/           - Logs do daemon
~/ravi/{agent-id}/      - Diretórios dos agents (CLAUDE.md, MEMORY.md)
~/.cache/ravi/plugins/  - Plugins internos extraídos
~/.claude/sessions/     - SDK session files (JSONL)
```

## Env Vars Importantes

```bash
OMNI_DIR=/path/to/omni-v2      # obrigatório para canal WhatsApp/Discord/Telegram
OMNI_API_PORT=8882              # default
DATABASE_URL=postgresql://...   # banco do omni
NATS_PORT=4222                  # default
```

## Padrões Importantes

1. **JetStream pull consumers** - Mensagens inbound via durable consumers (ACK explícito)
2. **PubSub via NATS** - Tudo comunica via topics internos
3. **Ghost detection** - `_emitId` + `_instanceId` previne duplicatas
4. **Abort control** - AbortController por sessão, cleanup no stop
5. **Debouncing** - Agrupa msgs rápidas por window configurável
6. **Outbound suppression** - Msgs de contatos outbound não geram prompt duplicado
7. **Silent token** - `@@SILENT@@` suprime emissão pro canal
8. **Session resumption** - SDK sessions persistem entre mensagens
