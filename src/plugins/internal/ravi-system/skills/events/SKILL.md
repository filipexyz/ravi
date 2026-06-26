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

## Fonte De Verdade

Os subjects Ravi são classificados em `src/events/topic-registry.ts`.

Categorias:
- `public-trigger`: seguro para catálogo de triggers e automações de operador.
- `replay-only`: entra no replay/debug, mas não deve ser template público por padrão.
- `internal-control`: controle entre componentes; pode ser replayável, mas não é workflow de usuário.
- `workqueue`: stream de trabalho com semântica própria, como `SESSION_PROMPTS`.
- `external-stream`: assunto externo/omni, consumido por bridge.

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
| `ravi.inbound.pollVote` | `{ pollMessageId, votes: [{ name, voters[] }] }` — subscriber existe, publisher vem do omni |

> As mensagens inbound dos canais chegam via **omni JetStream** nos subjects `message.received.{channelType}.{instanceId}`, não via pub/sub ravi. O `OmniConsumer` consome esses streams e traduz para prompts de sessão.
> Reações são normalizadas em `ravi.inbound.reaction`. Aliases como `whatsapp.*.reaction` não são publicados.
> O payload de reaction e deliberadamente pequeno: use `targetMessageId` como chave de correlacao. Se uma rotina precisa recuperar chat, caption, produto, campanha ou outro estado de dominio, esse estado deve ter sido gravado pela rotina quando a mensagem-alvo foi enviada.

### Streams externos Omni

| Tópico | Payload |
|--------|---------|
| `message.received.>` | mensagens inbound do Omni, persistidas no stream `MESSAGE` |
| `reaction.received.>` | reactions inbound do Omni, persistidas no stream `REACTION` |
| `presence.typing` | presença/typing do canal |
| `chat.unread-updated` | atualização de unread por chat |
| `instance.>` | lifecycle/status de instâncias Omni |

Esses subjects são mapeados no registry como `external-stream`. Eles não entram no stream `RAVI_EVENTS`; para replay histórico use os streams nativos (`MESSAGE`, `REACTION`, `SYSTEM`) com `ravi events replay`.

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
| `ravi.tts` | `{ text, agentId?, sessionName?, sessionKey?, target?, playback?, voice?, metadata? }` — solicita TTS ElevenLabs; o gateway publica `ravi.tts.started`, `ravi.tts.ready` ou `ravi.tts.failed` |
| `ravi.tts.started` | lifecycle TTS iniciado |
| `ravi.tts.ready` | lifecycle TTS pronto para playback |
| `ravi.tts.failed` | lifecycle TTS falhou |
| `ravi.stickers.send` | `{ channel: "whatsapp", accountId, chatId, stickerId, label, filePath, mimeType, filename }` — envia sticker WhatsApp via omni; canais sem capability de sticker são rejeitados |

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
| `ravi.whatsapp.qr.{instanceId}` | `{ type: "qr", instanceId, qr, channelType }` |
| `ravi.whatsapp.connected.{instanceId}` | `{ type: "connected", instanceId, channelType, profileName, ownerIdentifier }` |
| `ravi.whatsapp.group.{op}` | **Aposentado para o CLI público.** O grupo `ravi whatsapp group` usa REST do Omni; não introduza novos callers request-reply para este tópico. |

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
