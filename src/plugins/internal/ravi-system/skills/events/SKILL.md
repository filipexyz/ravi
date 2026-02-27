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

## Tópicos do Ravi

### Sessões (por session name)

| Tópico | Payload |
|--------|---------|
| `ravi.session.{name}.prompt` | `{ prompt, source?: { channel, accountId, chatId }, context?, _agentId?, _outbound?, _queueId?, _entryId? }` |
| `ravi.session.{name}.response` | `{ response, target?: { channel, accountId, chatId }, _emitId, _instanceId, _pid, _v: 2 }` |
| `ravi.session.{name}.claude` | Evento bruto do SDK Claude: `{ type: "system"\|"assistant"\|"result"\|"silent"\|..., _source? }` |
| `ravi.session.{name}.tool` | Start: `{ event: "start", toolId, toolName, safety, input, timestamp, sessionName, agentId }` / End: `{ event: "end", toolId, toolName, output, isError, durationMs, timestamp, sessionName, agentId }` |
| `ravi.session.{name}.stream` | `{ chunk }` — streaming de text deltas pro TUI |
| `ravi.session.abort` | `{ sessionKey?, sessionName? }` — abortar sessão ephemeral |

> **Nota:** O tópico usa o **session name** (ex: `agent-main-abc123`), não o session key (ex: `agent:main:main`). O prompt vai via JetStream WorkQueue stream (`SESSION_PROMPTS`), os demais são plain NATS pub/sub.

### Inbound (canais → bot)

| Tópico | Payload |
|--------|---------|
| `ravi.inbound.reaction` | `{ targetMessageId, emoji, senderId }` |
| `ravi.inbound.reply` | `{ targetMessageId, text, senderId }` |
| `ravi.inbound.pollVote` | `{ pollMessageId, votes: [{ name, voters[] }] }` — subscriber existe, publisher vem do omni |

> As mensagens inbound dos canais chegam via **omni JetStream** nos subjects `message.received.{channelType}.{instanceId}`, não via pub/sub ravi. O `OmniConsumer` consome esses streams e traduz para prompts de sessão.

### Outbound (bot → gateway → omni)

| Tópico | Payload |
|--------|---------|
| `ravi.outbound.deliver` | `{ channel, accountId, to, text?, poll?, typingDelayMs?, pauseMs?, replyTopic? }` |
| `ravi.outbound.reaction` | `{ channel, accountId, chatId, messageId, emoji }` |
| `ravi.outbound.receipt` | `{ channel, accountId, chatId, senderId, messageIds[] }` — sem subscriber no ravi, consumido pelo omni |
| `ravi.outbound.refresh` | `{}` — sinal de refresh de filas outbound |
| `ravi.outbound.trigger` | `{ queueId }` — trigger manual de fila outbound |

### Mídia

| Tópico | Payload |
|--------|---------|
| `ravi.media.send` | `{ channel, accountId, chatId, filePath, mimetype, type: "image"\|"video"\|"audio"\|"document", filename, caption? }` |

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
| `ravi.copilot.watch` | `{ team, agentId }` — copilot inbox watcher |

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
