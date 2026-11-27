# Triggers: banco de tópicos

## Banco de Tópicos

`ravi triggers topics` (ou `--json`, com `schema.fields[]`) mostra templates built-in, payloads, exemplos e notas. O catálogo é fonte de hints, não whitelist: topics custom publicados no NATS são aceitos. Quando o tópico tem `messageTemplate`, `ravi triggers add` pode omitir `--message`; o prompt chega como `[Trigger: <nome>]`, `Event: <topic>` e a mensagem resolvida, sem o bloco `Data:` que triggers custom recebem.

### Inbound e Canais

| Pattern | Descrição |
|---------|-----------|
| `ravi.inbound.reaction` | Reações recebidas. Payload: `{ targetMessageId, emoji, senderId }` |
| `ravi.inbound.reply` | Replies a mensagens do bot. Payload: `{ targetMessageId, text, senderId }` |
| `ravi.inbound.pollVote` | Votos em enquetes. Payload: `{ pollMessageId, votes: [{ name, voters[] }] }` |
| `ravi.inbound.interaction` | Botões, selects e modais do Slack. Payload: `{ provider, interactionType, userId, channelId, messageTs, actionId, blockId, value }` |

Aliases como `whatsapp.*.reaction`, `whatsapp.*.inbound` e `matrix.*.inbound` não são templates built-in e recebem aviso do CLI. Eles ainda são aceitos como subjects custom; para reações Ravi normais, use `ravi.inbound.reaction`.

**Importante para reações:** `ravi.inbound.reaction` é um evento de correlação, não uma mensagem completa. O payload atual não garante `chatId`, caption, mídia ou estado do domínio. Se a automação precisa saber "qual item foi aprovado", grave antes um mapping durável `targetMessageId -> domain state` quando enviar a mensagem-alvo. `senderId` pode vir como LID e não como telefone: ancore no `targetMessageId`, não no `senderId`.

### Contatos e Aprovações

| Pattern | Descrição |
|---------|-----------|
| `ravi.contacts.pending` | Novo contato/grupo pendente de aprovação |
| `ravi.chats.pending` | Novo chat/grupo pendente de aprovação |
| `ravi.approval.request` | Pedido de aprovação cascading |
| `ravi.approval.response` | Resposta de aprovação |

### CLI, Watch, Bases e Tasks

| Pattern | Descrição |
|---------|-----------|
| `ravi.*.cli.*.*` | Auditoria de comandos CLI emitidos por sessão |
| `ravi._cli.cli.*.*` | Auditoria de comandos CLI standalone |
| `ravi.inbox.mail.received` | Novo email projetado no inbox nativo local. Tem template padrão: `[ravi mail] novo email no inbox: {{data.mail.messageId}}...` |
| `ravi.console.inbox.item` | Itens do Agent Inbox do Console: eventos de linha de Bases (`category: bases`) e outros. Para e-mail local, use `ravi.inbox.mail.received` |
| `ravi.watch.*.*` | Evento normalizado de watch |
| `ravi.task.*.event` | Evento de ciclo de vida de task |

### TTS, Artifacts e Meetings

| Pattern | Descrição |
|---------|-----------|
| `ravi.tts` | Solicitação de TTS |
| `ravi.tts.*` | Ciclo de vida de TTS: `started`, `ready`, `failed` |
| `ravi.artifacts.*` | Ciclo de vida de artifacts: `created`, `running`, `completed`, `failed`, `archived` |
| `ravi.meetings.*` | Ciclo de vida de reuniões: `ended`, `transcript_available`, `artifact_generated` |

### Entrega e recibos

| Pattern | Descrição |
|---------|-----------|
| `ravi.outbound.deliver` | Mensagens enviadas para canais |
| `ravi.outbound.receipt` | Read receipts enviados |

### Audit

| Pattern | Descrição |
|---------|-----------|
| `ravi.audit.denied` | Permissão negada |
| `ravi.instances.unregistered` | Evento de instância Omni não registrada |

**Avisos:** O CLI aceita topics fora do catálogo e apenas alerta. O runner ignora assinaturas em `ravi.session.*` para evitar loops internos, e um topic curinga (`ravi.>`) também não dispara com eventos de `ravi.session.*`, `ravi._reply.*` ou `ravi.worker.*`.
