---
name: events
description: |
  Referência do sistema de eventos NATS. Use quando precisar:
  - Entender os tópicos e fluxo de eventos do Ravi
  - Emitir eventos manualmente via código
  - Debugar fluxo de mensagens entre componentes
---

# NATS Event Bus

O NATS é o pub/sub central do Ravi. Todas as mensagens, prompts, tool calls e respostas passam por ele como eventos em tópicos.

## Conceitos

- **Topic/Subject**: Namespace hierárquico separado por `.` (ex: `ravi.session.main.prompt`)
- **Event**: Payload JSON publicado num subject
- **Wildcards**: `*` casa com um nível, `>` casa com múltiplos níveis
- **Connection**: TCP direto para `nats://127.0.0.1:4222` (sem HTTP/WebSocket intermediário)

## Comandos CLI

### Stream ao vivo

```bash
ravi events stream
ravi events stream -f "ravi.session.*"
ravi events stream --only tool
```

### Replay de eventos persistidos

Use `replay` quando precisar reconstruir uma janela histórica do JetStream:

```bash
# Últimos 15 minutos, todos os streams não-KV
ravi events replay

# Mensagens inbound de canal em uma janela específica
ravi events replay --stream MESSAGE --subject "message.received.>" --since 2026-04-19T11:35:00Z --until 2026-04-19T11:45:00Z

# Filtrar por chat/session/texto e imprimir JSONL
ravi events replay --stream MESSAGE --subject "message.received.>" --chat "120363...@g.us" --contains "perdeu contexto" --json

# Reconstruir uma sessão: resolve session name/key + chatId quando existir
ravi events replay --stream RAVI_EVENTS,MESSAGE,REACTION,SYSTEM --session main-dm-615153 --since 2h --raw

# Filtros por JSON path
ravi events replay --stream MESSAGE --where "payload.chatId=63295117615153@lid;payload.content.type=text"
```

Filtros úteis:

- `--stream`: stream(s) separados por vírgula (`MESSAGE,CUSTOM,SYSTEM`)
- `--subject`: filtro de subject NATS (`message.received.>`)
- `--since` / `--until`: ISO, epoch ou duração (`15m`, `2h`, `1d`)
- `--contains`: busca textual no payload bruto e subject
- `--where`: `path=value`, `path!=value` ou `path~=texto`
- `--session`: resolve sessão local e filtra por name/key/chatId quando possível
- `--chat`, `--agent`: filtros substring práticos
- `--raw`: imprime payload bruto armazenado
- `--json`: imprime JSONL

Para timeline completa de sessão, use `RAVI_EVENTS` junto de `MESSAGE`/`REACTION`/`SYSTEM`.
`MESSAGE` sozinho cobre canal, mas não cobre eventos internos como prompt consumido, interrupção de turno, tool, response, delivery e abort.

## Tópicos do Ravi

### Sessões (por session name)

| Tópico | Payload |
|--------|---------|
| `ravi.session.{name}.prompt` | `{ prompt, source?: { channel, accountId, chatId }, context?, _agentId? }` |
| `ravi.session.{name}.response` | `{ response, target?: { channel, accountId, chatId }, _emitId, _instanceId, _pid, _v: 2 }` |
| `ravi.session.{name}.claude` | Evento bruto do SDK Claude: `{ type: "system"\|"assistant"\|"result"\|"silent"\|..., _source? }` |
| `ravi.session.{name}.tool` | Start: `{ event: "start", toolId, toolName, safety, input, timestamp, sessionName, agentId }` / End: `{ event: "end", toolId, toolName, output, isError, durationMs, timestamp, sessionName, agentId }` |
| `ravi.session.{name}.stream` | `{ chunk }` — streaming de text deltas pro TUI |
| `ravi.session.{name}.delivery` | `{ status: "delivered"\|"failed"\|"dropped", reason?, emitId?, messageId?, target?, durationMs?, textLen? }` |
| `ravi.session.abort` | `{ sessionKey?, sessionName?, source?, action?, reason?, actor?, correlationId? }` — abortar sessão ativa com provenance auditável |

> **Nota:** O tópico usa o **session name** (ex: `agent-main-abc123`), não o session key (ex: `agent:main:main`). O prompt vai via JetStream WorkQueue stream (`SESSION_PROMPTS`), os demais são plain NATS pub/sub.

### Inbound (canais → bot)

| Tópico | Payload |
|--------|---------|
| `ravi.inbound.reaction` | `{ targetMessageId, emoji, senderId }` |
| `ravi.inbound.reply` | `{ targetMessageId, text, senderId }` |
| `ravi.inbound.pollVote` | `{ pollMessageId, votes: [{ name, voters[] }] }` — subscriber existe, publisher vem do omni |

> As mensagens inbound dos canais chegam via **omni JetStream** nos subjects `message.received.{channelType}.{instanceId}`, não via pub/sub ravi. O `OmniConsumer` consome esses streams e traduz para prompts de sessão.

### Delivery (bot → gateway → omni)

| Tópico | Payload |
|--------|---------|
| `ravi.outbound.deliver` | `{ channel, accountId, to, text?, poll?, typingDelayMs?, pauseMs?, replyTopic? }` |
| `ravi.outbound.reaction` | `{ channel, accountId, chatId, messageId, emoji }` |
| `ravi.outbound.receipt` | `{ channel, accountId, chatId, senderId, messageIds[] }` — sem subscriber no ravi, consumido pelo omni |

### Mídia

| Tópico | Payload |
|--------|---------|
| `ravi.media.send` | `{ channel, accountId, chatId, filePath, mimetype, type: "image"\|"video"\|"audio"\|"document", filename, caption? }` |
| `ravi.stickers.send` | `{ channel: "whatsapp", accountId, chatId, stickerId, label, filePath, mimeType, filename }` — envia sticker WhatsApp via omni; canais sem capability de sticker são rejeitados |

### Contatos e Aprovações

| Tópico | Payload |
|--------|---------|
| `ravi.contacts.pending` | `{ type: "account", channel, accountId, senderId, chatId, isGroup }` |
| `ravi.approval.request` | `{ type: "plan"\|"spec"\|"question", sessionName, agentId, delegated, channel, chatId, timestamp, questionCount? }` |
| `ravi.approval.response` | `{ type: "plan"\|"spec"\|"question", sessionName, agentId, approved, reason?, answers?, timestamp }` |

### Instâncias

| Tópico | Payload |
|--------|---------|
| `ravi.instances.unregistered` | `{ instanceId, channelType, subject, from, chatId, isGroup, contentType, timestamp }` — cooldown 5min por instanceId |
| `ravi.whatsapp.qr.{instanceId}` | `{ type: "qr", instanceId, qr, channelType }` |
| `ravi.whatsapp.connected.{instanceId}` | `{ type: "connected", instanceId, channelType, profileName, ownerIdentifier }` |
| `ravi.whatsapp.group.{op}` | `{ accountId, replyTopic, ... }` — ops: list, info, create, leave, add, remove, join (request-reply) |

### Auditoria

| Tópico | Payload |
|--------|---------|
| `ravi.audit.denied` | `{ type: "env_spoofing"\|"executable"\|"session_scope"\|"tool"\|"group", agentId, denied, reason, detail? }` |

### Sistema e Config

| Tópico | Payload |
|--------|---------|
| `ravi.config.changed` | `{}` — configuração alterada via CLI |
| `ravi.triggers.refresh` | `{}` — refresh de subscriptions de triggers |
| `ravi.triggers.test` | `{ triggerId }` — test manual de trigger |
| `ravi.cron.refresh` | `{}` — refresh de timers de cron |
| `ravi.cron.trigger` | `{ jobId }` — trigger manual de cron job |
| `ravi.heartbeat.refresh` | `{}` — refresh de timers heartbeat |

### CLI Tools (emitidos pelo bot)

| Tópico | Payload |
|--------|---------|
| `ravi.{sessionKey}.cli.{group}.{command}` | Evento de execução de CLI tool pelo agent |

## API (src/nats.ts)

```typescript
import { nats } from "./nats.js";

// Publicar evento
await nats.emit("ravi.session.main.prompt", { prompt: "oi" });

// Subscribir a tópicos (wildcards)
for await (const event of nats.subscribe("ravi.session.*.prompt")) {
  console.log(event.topic, event.data);
}

// Múltiplos tópicos
for await (const event of nats.subscribe("ravi.session.*.response", "ravi.session.*.tool")) {
  console.log(event.topic, event.data);
}
```

## Relação com Triggers

O Ravi tem um sistema de **triggers** (`ravi triggers`) que reagem automaticamente a eventos NATS.

- **NATS** = barramento de eventos (pub/sub)
- **triggers** = reações automáticas quando um evento matching acontece

Para gerenciar triggers, use `ravi triggers --help`.
