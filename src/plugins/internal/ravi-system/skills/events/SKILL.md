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

### Sessões (por session)

| Tópico | Conteúdo |
|--------|----------|
| `ravi.session.{name}.prompt` | Prompts recebidos (mensagens, heartbeat, system, cross-send) |
| `ravi.session.{name}.response` | Respostas do agent (com `target` para routing) |
| `ravi.session.{name}.claude` | Eventos brutos do SDK Claude (typing heartbeat) |
| `ravi.session.{name}.tool` | Tool calls (start/end com input/output) |
| `ravi.session.abort` | Abortar sessão ephemeral |

### Inbound (canais)

| Tópico | Conteúdo |
|--------|----------|
| `whatsapp.{accountId}.inbound` | Mensagens WhatsApp recebidas (InboundMessage) |
| `matrix.{accountId}.inbound` | Mensagens Matrix recebidas (InboundMessage) |
| `ravi.inbound.reaction` | Reações recebidas (`emoji`, `targetMessageId`) |
| `ravi.inbound.reply` | Replies recebidos (`targetMessageId`, `text`) |
| `ravi.inbound.pollVote` | Votos em enquetes (`pollMessageId`, `votes`) |

### Outbound

| Tópico | Conteúdo |
|--------|----------|
| `ravi.outbound.deliver` | Mensagens de saída para canais (`channel`, `accountId`, `to`, `text`) |
| `ravi.outbound.receipt` | Read receipts pendentes (`chatId`, `senderId`, `messageIds`) |
| `ravi.outbound.refresh` | Sinal de refresh de filas outbound |

### Contatos e Aprovações

| Tópico | Conteúdo |
|--------|----------|
| `ravi.contacts.pending` | Novo contato/grupo pendente (`type`: contact ou account) |
| `ravi.approval.request` | Pedido de aprovação cascading (`sessionName`, `type`, `text`) |
| `ravi.approval.response` | Resposta de aprovação (`approved`, `reason`) |

### Sistema e Config

| Tópico | Conteúdo |
|--------|----------|
| `ravi.config.changed` | Configuração alterada via CLI |
| `ravi.triggers.refresh` | Sinal de refresh de triggers |
| `ravi.heartbeat.refresh` | Sinal de refresh de timers heartbeat |

### CLI Tools (emitidos pelo bot)

| Tópico | Conteúdo |
|--------|----------|
| `ravi.{sessionKey}.cli.{group}.{command}` | Execuções de CLI tools pelo agent |

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
