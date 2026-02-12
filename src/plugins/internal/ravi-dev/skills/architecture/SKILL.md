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

Ravi e um sistema multi-agent construido sobre o Claude Agent SDK que orquestra conversas em multiplas plataformas (WhatsApp, Matrix, TUI).

**Repositorio:** `/Users/luis/dev/filipelabs/ravi.bot`
**Runtime:** Bun | **DB:** SQLite | **PubSub:** notif.sh | **AI:** Claude SDK

## Fluxo Principal de Mensagens

```
[WhatsApp/Matrix/TUI]
    -> Channel Plugin (normaliza mensagem)
    -> Gateway (formata envelope, resolve rota)
    -> notif.emit("ravi.{sessionKey}.prompt")
    -> RaviBot (Claude SDK query)
    -> notif.emit("ravi.{sessionKey}.response")
    -> Gateway (roteia para canal)
    -> [WhatsApp/Matrix/TUI]
```

## Componentes Core

### daemon.ts - Ponto de Entrada
Orquestra startup de todos os subsistemas:
1. Carrega env de `~/.ravi/.env`
2. Inicia RaviBot (Claude SDK)
3. Cria Gateway com channel plugins
4. Registra WhatsApp + Matrix
5. Inicia HeartbeatRunner, CronRunner, OutboundRunner, TriggerRunner

### gateway.ts - Orquestrador de Mensagens
**Inbound:** Channel normaliza msg -> Gateway resolve rota -> emite prompt
**Outbound:** Bot emite response -> Gateway extrai target -> envia pro canal

Subscriptions importantes:
- `{channelId}.*.inbound` - Msgs dos canais
- `ravi.*.response` - Respostas do bot
- `ravi.outbound.deliver` - Envio direto do outbound
- `ravi.media.send` - Envio de midia

Features:
- Ghost detection via `_emitId` (previne duplicatas de restarts)
- Typing indicator automatico
- Outbound suppression (msgs de contatos outbound nao geram prompt)

### bot.ts - Core do Bot
Processa prompts usando Claude Agent SDK.

**Fluxo:**
1. Subscribe em `ravi.*.prompt`
2. Resolve agent config pela session key
3. Debounce se configurado
4. Cria/resume SDK session
5. Streama resposta -> emite responses parciais
6. Gerencia interrupts (msg nova durante processamento)

**Interrupt handling:**
- Tool rodando -> enfileira msg
- Sem tool -> aborta query atual
- Apos tool terminar -> checa fila -> interrupt
- Msgs enfileiradas sao combinadas em 1 prompt

**Abort control:**
- Cada sessao tem AbortController
- Novo prompt aborta subprocess anterior
- Daemon stop aborta TODOS os controllers
- Watchdog de 5min detecta sessoes travadas

### router/ - Sistema de Roteamento

**Resolucao de rota (prioridade):**
1. Agent atribuido ao contato
2. Rota com pattern match
3. AccountId = AgentId (Matrix)
4. Agent default

**Session keys:**
```
agent:{agentId}:{scope}:{peerId}
agent:main:main                          # Todas DMs (scope=main)
agent:main:dm:5511999                    # Por contato
agent:main:whatsapp:group:123456         # Grupo
agent:main:outbound:queueId:phone        # Outbound
```

**DM Scopes:**
- `main` - Todas DMs compartilham 1 sessao
- `per-peer` - Isolado por contato (default)
- `per-channel-peer` - Isolado por canal+contato
- `per-account-channel-peer` - Isolamento total

**Arquivos:**
- `router/resolver.ts` - Resolve rota -> session key
- `router/session-key.ts` - Constroi/parseia session keys
- `router/sessions.ts` - CRUD de sessoes (SQLite)
- `router/config.ts` - Carrega config de agents/routes
- `router/router-db.ts` - Camada de banco

### channels/ - Abstracao de Canais

Interface unificada para plataformas de mensagem.

**Adapters:**
- ConfigAdapter - Configuracao de contas
- SecurityAdapter - Controle de acesso
- OutboundAdapter - Envio de msgs, typing, reactions
- GatewayAdapter - Lifecycle de conexao
- StatusAdapter - Health monitoring

**WhatsApp (`channels/whatsapp/`):**
- Baileys SDK, multi-account, QR pairing
- Media download com limites de tamanho
- Transcricao de audio (OpenAI Whisper)
- JID/LID resolution
- Sessao em `~/ravi/sessions/whatsapp/{accountId}/`

**Matrix (`channels/matrix/`):**
- matrix-bot-sdk, multi-account
- E2E encryption, device verification
- Credenciais em `~/ravi/sessions/matrix/accounts.json`
- Cada agent pode ter matrixAccount diferente

## Subsistemas de Automacao

### Outbound (`outbound/`)
Campanhas de mensagens proativas com processamento round-robin.

**Fluxo:**
1. Runner pega proxima queue do DB
2. Arma timer para `nextRunAt`
3. Processa entries por prioridade:
   - Response entries (contato respondeu)
   - Follow-up entries (sem resposta, precisa follow-up)
   - Initial outreach (entries pendentes)
4. Manda prompt para agent com contexto da campanha

**Qualificacao:** cold -> warm -> interested -> qualified/rejected

### Triggers (`triggers/`)
Automacao event-driven disparada por eventos do sistema.

**Fluxo:**
1. Runner subscribe em topics configurados
2. Evento dispara -> busca triggers ativos com match
3. Emite prompt para sessao target do trigger
4. Respeita cooldown entre disparos

### Cron (`cron/`)
Jobs agendados com suporte a multiplos formatos.

**Schedules:** cron expression | interval ("30m") | daily ("09:00") | at (one-time)

**Fluxo:** Timer -> job due -> emite prompt -> calcula proximo run

### Heartbeat (`heartbeat/`)
Check-ins periodicos de agents dentro de horarios ativos.

**Fluxo:**
1. Checa agents com heartbeat enabled
2. Para cada sessao, verifica se esta due
3. Checa active hours (timezone-aware)
4. Envia prompt de status check
5. `HEARTBEAT_OK` = silencioso, qualquer outro texto = envia pro canal

### Session Messaging (`cli/commands/sessions.ts`)
Mensagens entre sessoes (inter-session communication).

**Comandos:** `sessions send` | `sessions inform` | `sessions execute` | `sessions ask` | `sessions answer`

**Ask/Answer flow:**
1. Agent A: `ravi sessions ask <target-session> "pergunta" "sender"`
2. Bot emite `[System] Ask:` para target
3. Agent B responde, usa `ravi sessions answer <origin-session> "resposta" "sender"`
4. Bot emite `[System] Answer:` para origin

## Sistema de Plugins

**Duas fontes:**
1. **Internos** - Embutidos no build, extraidos para `~/.cache/ravi/plugins/`
2. **Usuario** - Customizados em `~/ravi/plugins/`

**Build time:** `gen-plugins.ts` escaneia `src/plugins/internal/` e gera `internal-registry.ts`
**Runtime:** `discoverPlugins()` extrai internos + escaneia user dir -> passa para SDK

## Sistema de Hooks

### PreToolUse (bash/hook.ts)
Intercepta chamadas Bash e valida contra BashConfig do agent.
Modos: bypass | allowlist | denylist

### PreCompact (hooks/pre-compact.ts)
Extrai memorias antes do SDK compactar contexto.
Le `COMPACT_INSTRUCTIONS.md` do agent, roda modelo barato em background, atualiza `MEMORY.md`.

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
  // CLI tools acessam contexto sem parametros
  const ctx = getContext();
});
```

## Storage

```
~/ravi/ravi.db          - SQLite: agents, routes, sessions, contacts, settings
~/.ravi/.env            - API keys e env vars
~/.ravi/logs/           - Logs do daemon
~/ravi/{agent-id}/      - Diretorios dos agents (CLAUDE.md, MEMORY.md)
~/ravi/sessions/        - Sessoes dos canais (WhatsApp, Matrix)
~/.cache/ravi/plugins/  - Plugins internos extraidos
~/.claude/sessions/     - SDK session files (JSONL)
```

## Padroes Importantes

1. **PubSub via notif** - Tudo comunica via topics
2. **Ghost detection** - `_emitId` + `_instanceId` previne duplicatas
3. **Abort control** - AbortController por sessao, cleanup no stop
4. **Debouncing** - Agrupa msgs rapidas por window configuravel
5. **Outbound suppression** - Msgs de contatos outbound nao geram prompt duplicado
6. **Silent token** - `@@SILENT@@` suprime emissao pro canal
7. **Session resumption** - SDK sessions persistem entre mensagens
