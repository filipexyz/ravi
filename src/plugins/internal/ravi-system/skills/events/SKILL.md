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

# Mensagens inbound do WhatsApp em uma janela específica
ravi events replay --stream CHANNEL_INBOUND --subject "ravi.channel.inbound.whatsapp.message.>" --since 2026-04-19T11:35:00Z --until 2026-04-19T11:45:00Z

# Filtrar por chat/session/texto e imprimir JSONL
ravi events replay --stream CHANNEL_INBOUND --subject "ravi.channel.inbound.whatsapp.message.>" --chat "120363...@g.us" --contains "perdeu contexto" --json

# Reconstruir uma sessão: resolve session name/key + chatId quando existir
ravi events replay --stream RAVI_EVENTS,CHANNEL_INBOUND --session main-dm-615153 --since 2h --raw

# Filtros por JSON path
ravi events replay --stream CHANNEL_INBOUND --where "payload.chatId=63295117615153@lid;payload.content.type=text"

# Telegram/Discord pela ponte legada Omni
ravi events replay --stream MESSAGE --subject "message.received.>" --since 1h
```

Filtros úteis:

- `--stream`: stream(s) separados por vírgula (`CHANNEL_INBOUND,RAVI_EVENTS`; `MESSAGE,REACTION,SYSTEM` para a ponte legada)
- `--subject`: filtro de subject NATS (`ravi.channel.inbound.whatsapp.>`)
- `--since` / `--until`: ISO, epoch ou duração (`15m`, `2h`, `1d`)
- `--contains`: busca textual no payload bruto e subject
- `--where`: `path=value`, `path!=value` ou `path~=texto`
- `--session`: resolve sessão local e filtra por name/key/chatId quando possível
- `--chat`, `--agent`: filtros substring práticos
- `--raw`: imprime payload bruto armazenado
- `--json`: imprime JSONL

Para timeline completa de sessão, use `RAVI_EVENTS` junto de `CHANNEL_INBOUND` (WhatsApp) ou `MESSAGE`/`REACTION`/`SYSTEM` (ponte legada, Telegram/Discord).
O stream do canal sozinho cobre o inbound, mas não cobre eventos internos como prompt consumido, interrupção de turno, tool, response, delivery e abort.

## Fonte De Verdade

Os subjects Ravi são classificados em `src/events/topic-registry.ts`.

Categorias:
- `public-trigger`: seguro para catálogo de triggers e automações de operador.
- `replay-only`: entra no replay/debug, mas não deve ser template público por padrão.
- `internal-control`: controle entre componentes; pode ser replayável, mas não é workflow de usuário.
- `workqueue`: stream de trabalho com semântica própria, como `SESSION_PROMPTS`.
- `external-stream`: stream de transporte consumido pelo daemon (`ravi.channel.inbound.>` no `CHANNEL_INBOUND`, e os subjects da ponte legada Omni).

`RAVI_EVENTS` é derivado desse registry. Ao criar publisher NATS novo, classifique
o subject no registry antes de documentar ou usar em trigger.

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
| `ravi.session.reset.requested` / `completed` | audit de reset de sessão |
| `ravi.session.delete.requested` / `completed` | audit de delete de sessão |
| `ravi.session.prune.requested` / `completed` | audit de prune de sessões |
| `ravi.session.model.changed` | mudança de modelo/runtime provider da sessão |

> **Nota:** O tópico usa o **session name** (ex: `agent-main-abc123`), não o session key (ex: `agent:main:main`). O prompt vai via JetStream WorkQueue stream (`SESSION_PROMPTS`), os demais são plain NATS pub/sub.

### Inbound (canais → bot)

| Tópico | Payload |
|--------|---------|
| `ravi.inbound.reaction` | `{ targetMessageId, emoji, senderId }` |
| `ravi.inbound.reply` | `{ targetMessageId, text, senderId }` |
| `ravi.inbound.pollVote` | `{ pollMessageId, votes: [{ name, voters[] }] }` — o serviço de aprovação assina; hoje nenhum publisher do Ravi emite este subject |
| `ravi.inbound.thread.created` | `{ provider, eventType, channelId, threadTs, messageTs, userId, canonicalChatId, sessionKey, sessionName, agentId }` — thread nativa de canal criou uma nova sessao Ravi |

> As mensagens inbound do WhatsApp chegam pelo stream JetStream `CHANNEL_INBOUND`, publicadas pelo runner `ravi channels` em `ravi.channel.inbound.whatsapp.{message|reaction|connection}.{instanceId}` (envelope `WhatsAppInboundEvent`, `schemaVersion: 1`). Telegram/Discord chegam pela ponte legada Omni (`message.received.{channelType}.{instanceId}`). O daemon consome os dois com o `ChannelInboundPipeline` (`src/channels/inbound/pipeline.ts`) e traduz para prompts de sessão. Eventos do Omni com channel type da família WhatsApp são ignorados.
> Reações são normalizadas em `ravi.inbound.reaction` pelo pipeline (WhatsApp e ponte legada) e pelo Slack nativo (`reaction_added`). Aliases como `whatsapp.*.reaction` não são publicados.
> O payload de reaction e deliberadamente pequeno: use `targetMessageId` como chave de correlacao. Se uma rotina precisa recuperar chat, caption, produto, campanha ou outro estado de dominio, esse estado deve ter sido gravado pela rotina quando a mensagem-alvo foi enviada.

### Streams de transporte

| Tópico | Payload |
|--------|---------|
| `ravi.channel.inbound.whatsapp.message.{instanceId}` | `WhatsAppInboundEvent` `message.received`, stream `CHANNEL_INBOUND` (durable `ravi-whatsapp-messages`) |
| `ravi.channel.inbound.whatsapp.reaction.{instanceId}` | `WhatsAppInboundEvent` `reaction.received` (durable `ravi-whatsapp-reactions`) |
| `ravi.channel.inbound.whatsapp.connection.{instanceId}` | `WhatsAppInboundEvent` `connection.qr\|connected\|disconnected` (durable `ravi-whatsapp-connection`) |
| `_RAVI.channels.whatsapp.rpc.{instanceId}` | RPC request/reply do daemon/CLI para o runner (`connection.*`, `groups.*`, `messages.*`, `presence.set`) |
| `message.received.>` | ponte legada Omni (Telegram/Discord), stream `MESSAGE` |
| `reaction.received.>` | ponte legada Omni, stream `REACTION` |
| `presence.typing` / `chat.unread-updated` | ponte legada Omni |
| `instance.>` | lifecycle de instâncias da ponte legada Omni |

Esses subjects são `external-stream` (o RPC é `internal-control`). Eles não entram no stream `RAVI_EVENTS`; para replay histórico use `CHANNEL_INBOUND` (ou `MESSAGE`, `REACTION`, `SYSTEM` para a ponte legada) com `ravi events replay`. `ravi events stream` esconde `ravi.channel.inbound.*` e `_RAVI.channels.*`, a menos que você passe `-f` com esse subject.

### Delivery (bot → gateway → canal)

O gateway entrega pelo sender do canal: WhatsApp vai para o runner por RPC (`WhatsAppSender`), Slack pelo adapter nativo, Telegram/Discord pela ponte legada Omni.

| Tópico | Payload |
|--------|---------|
| `ravi.outbound.deliver` | `{ channel, accountId, to, text?, poll?, typingDelayMs?, pauseMs?, replyTopic? }` |
| `ravi.outbound.reaction` | `{ channel, accountId, chatId, messageId, emoji }` |
| `ravi.outbound.receipt` | `{ channel, accountId, chatId, senderId, messageIds[] }` — emitido por `ravi whatsapp dm ack`; hoje nenhum processo do Ravi assina este subject |

### Mídia

| Tópico | Payload |
|--------|---------|
| `ravi.media.send` | `{ channel, accountId, chatId, filePath, mimetype, type: "image"\|"video"\|"audio"\|"document", filename, caption? }` |
| `ravi.tts` | `{ text, agentId?, sessionName?, sessionKey?, target?, playback?, voice?, metadata? }` — solicita TTS ElevenLabs; o gateway publica `ravi.tts.started`, `ravi.tts.ready` ou `ravi.tts.failed` |
| `ravi.tts.started` | lifecycle TTS iniciado |
| `ravi.tts.ready` | lifecycle TTS pronto para playback |
| `ravi.tts.failed` | lifecycle TTS falhou |
| `ravi.stickers.send` | `{ channel: "whatsapp", accountId, chatId, stickerId, label, filePath, mimeType, filename }` — envia sticker WhatsApp pelo runner `ravi channels`; canais sem capability de sticker são rejeitados |

### Contatos e Aprovações

| Tópico | Payload |
|--------|---------|
| `ravi.contacts.pending` | `{ type: "account", channel, accountId, senderId, chatId, isGroup }` |
| `ravi.chats.pending` | `{ type: "account", reviewKind: "chat", channel, accountId, senderId, chatId, isGroup }` |
| `ravi.approval.request` | `{ type: "plan"\|"spec"\|"question", sessionName, agentId, delegated, channel, chatId, timestamp, questionCount? }` |
| `ravi.approval.response` | `{ type: "plan"\|"spec"\|"question", sessionName, agentId, approved, reason?, answers?, timestamp }` |

### Inbox, Watch, Tasks, Tags

| Tópico | Payload |
|--------|---------|
| `ravi.inbox.mail.received` | inbox local nativo para email acionável |
| `ravi.console.inbox.item` | mirror técnico de item entregue pelo Console |
| `ravi.watch.{connector}.{event}` | evento normalizado de watch |
| `ravi.task.{taskId}.event` | lifecycle de task |
| `ravi.tags.rule.applied` | regra de tag aplicada em contato/chat |
| `ravi.contacts.{contactId}.tags.rule.applied` | evento específico do contato |
| `ravi.chats.{chatId}.tags.rule.applied` | evento específico do chat |

### Artifacts e Meetings

| Tópico | Payload |
|--------|---------|
| `ravi.artifacts.created` | artifact criado |
| `ravi.artifacts.running` | artifact em execução |
| `ravi.artifacts.completed` | artifact concluído |
| `ravi.artifacts.failed` | artifact falhou |
| `ravi.artifacts.archived` | artifact arquivado |
| `ravi.meetings.ended` | reunião encerrada |
| `ravi.meetings.transcript_available` | transcrição de reunião disponível |
| `ravi.meetings.artifact_generated` | artifact de reunião gerado |

### Work Objects

| Tópico | Payload |
|--------|---------|
| `ravi.work_objects.resolve` | request para resolver objeto interativo |
| `ravi.work_objects.update` | request para atualizar objeto interativo |
| `ravi.work_objects.action` | request para executar ação em objeto interativo |
| `ravi.work_objects.suggest` | request de sugestões para campo de objeto interativo |
| `omni.work_objects.*` | subjects compatíveis do Omni; mapeados no registry, mas não entram no stream `RAVI_EVENTS` por padrão |

### Instâncias

| Tópico | Payload |
|--------|---------|
| `ravi.instances.unregistered` | `{ instanceId, channelType, subject, from, chatId, isGroup, contentType, timestamp }` — cooldown 5min por instanceId |
| `ravi.whatsapp.qr.{instanceId}` | `{ type: "qr", instanceId, qr, channelType }` — QR do WhatsApp repassado pelo daemon |
| `ravi.whatsapp.connected.{instanceId}` | `{ type: "connected", instanceId, channelType, profileName, ownerIdentifier }` |
| `ravi.bridge.qr.{instanceId}` / `ravi.bridge.connected.{instanceId}` | mesmos payloads, para instâncias da ponte legada (Telegram/Discord) |
| `ravi.whatsapp.group.{op}` | **Aposentado.** O grupo `ravi whatsapp group` usa o RPC do runner (`groups.*`); não introduza novos callers request-reply para este tópico. |

### Auditoria

| Tópico | Payload |
|--------|---------|
| `ravi.audit.denied` | `{ type: "env_spoofing"\|"executable"\|"session_scope"\|"tool"\|"scope", agentId, denied, reason, dedupeKey, command?, detail?, blockType?, missingPrincipals?, missingPrincipalDetails?, recommendedGrantSubjects?, denialId?, context? }` — `dedupeKey` é semântico e não inclui `denialId`; `detail` traz diagnóstico seguro quando disponível; `blockType` classifica o tipo de bloqueio; `missingPrincipals`/`recommendedGrantSubjects` ajudam automação de liberação; `missingPrincipalDetails` traz branch/principal/displayName para explicação humana; `context` é provenance segura (`contextId`, `kind`, sessão, `actorPrincipal`, `actorDisplayName`, `surfacePrincipal`, `surfaceDisplayName`, contadores de capabilities); nunca inclui `contextKey`. |

### Sistema e Config

| Tópico | Payload |
|--------|---------|
| `ravi.config.changed` | `{}` — configuração alterada via CLI |
| `ravi.runtime.session_pool.gauge` | snapshot de saúde do pool de sessões runtime |
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
