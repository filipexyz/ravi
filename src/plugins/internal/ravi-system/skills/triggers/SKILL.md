---
name: trigger-manager
description: |
  Gerencia triggers de eventos do sistema Ravi. Use quando o usuário quiser:
  - Criar, listar, ver ou deletar triggers
  - Configurar reações automáticas a eventos CLI, watch, audit, TTS, artifacts e inbound normalizado
  - Ativar/desativar triggers existentes
  - Testar triggers manualmente
---

# Trigger Manager

Você gerencia os triggers de eventos do Ravi. Triggers são reações automáticas que disparam quando eventos específicos acontecem no sistema.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `TRIGGER_NOT_FOUND`). O envelope traz `suggestions` com triggers reais parecidos — consulte antes de concluir "não existe".
- `2` erro de uso (flag/argumento inválido). O envelope traz `acceptedFlags`: corrija a chamada, não insista na mesma sintaxe.
- `3` freio de escrita — não é erro. Nada foi gravado; o envelope traz `dryRun:true` e `plan` com exatamente o que seria feito. Revise o plano e repita com `--execute`.

Onde o freio existe hoje: `triggers rm` (deletar é destrutivo — a assinatura do tópico e a config somem sem undo) e `triggers test` (o evento sintético pode ativar agent ou shell) são dry-run por default e exigem `--execute`:

```bash
ravi triggers rm trg_1 --json      # exit 3: plan mostra id, name e topic do trigger que seria deletado
ravi triggers rm trg_1 --execute   # deleta de verdade
ravi triggers test trg_1 --json    # exit 3: nenhum evento emitido
ravi triggers test trg_1 --execute # emite o evento sintético
```

Sem freio (declaradas): `add`, `set`, `enable`, `disable` — todas têm comando inverso.

Compact mode: `triggers list --fields id,name,topic,enabled` devolve só esses campos por item — use em varredura para não arrastar o objeto inteiro de cada trigger.

Checklist antes de responder sobre triggers:

- Tratei exit 3 como freio (revisei o `plan`) e não como falha?
- Consultei `suggestions` do envelope antes de declarar not-found?

## Comandos Disponíveis

### Listar triggers
```bash
ravi triggers list
```

### Ver detalhes de um trigger
```bash
ravi triggers show <id>
```

### Criar trigger
```bash
ravi triggers add "<nome>" --topic "<pattern>" --message "<prompt>"
ravi triggers add "Novo email local" --topic "ravi.inbox.mail.received"
ravi triggers add "Ticket Slack" --topic "ravi.inbound.interaction" --filter 'data.provider == "slack" && data.blockId == "ticket"' --shell "bun scripts/slack-ticket-flow.ts"
```

Opções:
- `--agent <id>` - Agent que processa (default: agent padrão)
- `--cooldown <duration>` - Intervalo mínimo entre disparos (ex: 5s, 1m, 30s)
- `--session <main|isolated>` - Sessão (default: isolated)
- `--message <prompt>` - Prompt/template manual; opcional quando o tópico do catálogo tem `messageTemplate`
- `--shell <cmd>` / `--exec <cmd>` - Executa comando shell diretamente, sem acordar agent
- `--timeout <duration>` - Timeout de shell trigger, ex: `30`, `1m`, `5m`
- `--env-file <path>` - Env file carregado no processo shell
- `--on-error notify-session:<session>` - Notifica uma sessão somente em falha do shell

Triggers shell recebem:

- `RAVI_TRIGGER_EVENT_FILE` - JSON com `{ trigger, event, source }`
- `RAVI_TRIGGER_DATA_FILE` - JSON com `event.data`
- `RAVI_TRIGGER_ACTION_ID`, `RAVI_TRIGGER_BLOCK_ID`, `RAVI_TRIGGER_VALUE`
- `RAVI_TRIGGER_USER_ID`, `RAVI_TRIGGER_CHANNEL_ID`, `RAVI_TRIGGER_MESSAGE_TS`
- `RAVI_TRIGGER_SOURCE_CHAT_ID`, `RAVI_TRIGGER_SOURCE_ACCOUNT_ID`

Use trigger shell para automações determinísticas. Use trigger agent quando a
decisão exigir linguagem natural, investigação ou julgamento.

### Ativar/Desativar
```bash
ravi triggers enable <id>
ravi triggers disable <id>
```

### Configurar propriedades
```bash
ravi triggers set <id> <key> <value>
```
Keys: name, message, shell, exec, timeout, env-file, on-error, topic, agent, session, cooldown, filter

### Testar trigger

Mostra o plano sem emitir; `--execute` dispara dados FAKE e pode ativar o agent ou shell:

```bash
ravi triggers test <id> --execute
```

### Deletar

Sem `--execute` é dry-run (exit 3); nada é deletado:

```bash
ravi triggers rm <id> --execute
```

## Banco de Tópicos

Use `ravi triggers topics` para ver templates built-in com schema de payload, template padrão de mensagem, exemplos, filtros comuns e notas operacionais. O catálogo é fonte de hints, não whitelist: topics externos/custom publicados no NATS são aceitos.

Use `ravi triggers topics --json` quando precisar configurar watchers por programa. Cada tópico catalogado expõe `schema.fields[]` com `path`, `type`, `required` e `description`. Quando existir `messageTemplate`, `ravi triggers add` pode omitir `--message` e salvar esse template como mensagem do trigger, preservando a origem como template de catálogo.

Quando um trigger usa `messageTemplate` padrão do catálogo, o prompt entregue ao agent é enxuto e padronizado:

```
[Trigger: <nome do trigger>]
Event: <topic que disparou>

<mensagem resolvida>
```

Esse modo não inclui o bloco bruto `Data: {...}`. Triggers manuais/custom continuam recebendo `Data` no prompt para debug e automações legadas.

### Inbound e Canais

| Pattern | Descrição |
|---------|-----------|
| `ravi.inbound.reaction` | Reações recebidas. Payload: `{ targetMessageId, emoji, senderId }` |
| `ravi.inbound.reply` | Replies a mensagens do bot. Payload: `{ targetMessageId, text, senderId }` |
| `ravi.inbound.pollVote` | Votos em enquetes. Payload: `{ pollMessageId, votes: [{ name, voters[] }] }` |

Aliases como `whatsapp.*.reaction`, `whatsapp.*.inbound` e `matrix.*.inbound` não são templates built-in e recebem aviso do CLI. Eles ainda são aceitos como subjects custom; para reações Ravi normais, use `ravi.inbound.reaction`.

**Importante para reactions:** `ravi.inbound.reaction` é um evento de correlação, não uma mensagem completa. O payload atual não garante `chatId`, caption, mídia ou estado de negócio. Se a automação precisa saber "qual item foi aprovado", grave antes um mapping durável `targetMessageId -> domain state` quando enviar a mensagem-alvo.

### Contatos e Aprovações

| Pattern | Descrição |
|---------|-----------|
| `ravi.contacts.pending` | Novo contato/grupo pendente de aprovação |
| `ravi.chats.pending` | Novo chat/grupo pendente de aprovação |
| `ravi.approval.request` | Pedido de aprovação cascading |
| `ravi.approval.response` | Resposta de aprovação |

### CLI, Watch e Tasks

| Pattern | Descrição |
|---------|-----------|
| `ravi.*.cli.*.*` | Auditoria de comandos CLI emitidos por sessão |
| `ravi._cli.cli.*.*` | Auditoria de comandos CLI standalone |
| `ravi.inbox.mail.received` | Novo email projetado no inbox nativo local. Tem template padrão: `[ravi mail] novo email no inbox: {{data.mail.messageId}}...` |
| `ravi.console.inbox.item` | Mirror técnico de item entregue pelo Console |
| `ravi.watch.*.*` | Evento normalizado de watch |
| `ravi.task.*.event` | Evento de ciclo de vida de task |

### TTS, Artifacts e Meetings

| Pattern | Descrição |
|---------|-----------|
| `ravi.tts` | Solicitação de TTS |
| `ravi.tts.*` | Lifecycle de TTS: `started`, `ready`, `failed` |
| `ravi.artifacts.*` | Lifecycle de artifacts: `created`, `running`, `completed`, `failed`, `archived` |
| `ravi.meetings.*` | Lifecycle de reuniões: `ended`, `transcript_available`, `artifact_generated` |

### Delivery / Receipts

| Pattern | Descrição |
|---------|-----------|
| `ravi.outbound.deliver` | Mensagens enviadas para canais |
| `ravi.outbound.receipt` | Read receipts enviados |

### Audit

| Pattern | Descrição |
|---------|-----------|
| `ravi.audit.denied` | Permissão negada |
| `ravi.instances.unregistered` | Evento de instância Omni não registrada |

**Avisos:** O CLI aceita topics fora do catálogo e apenas alerta. O runner ignora assinaturas em `ravi.session.*` para evitar loops internos.

## Filtros

Triggers suportam filtros opcionais que impedem o disparo quando o evento não casa com a expressão:

```bash
ravi triggers add "..." --filter 'data.cwd startsWith "/path/to/workspace"'
ravi triggers set <id> filter 'data.cwd != "/path/to/ignored-workspace"'
ravi triggers set <id> filter 'data.permission_mode == "bypassPermissions"'
ravi triggers set <id> filter 'data.senderId == "5511999999999" && (data.emoji == "👍" || data.emoji == "👍🏻")'
```

**Sintaxe:** `data.<path> <operador> "<valor>"`, com composicao opcional por `&&`, `||`, `!` e parenteses.

Operadores: `==`, `!=`, `startsWith`, `endsWith`, `includes`

Precedencia: `!` antes de `&&` antes de `||`.

Valores devem ser strings com aspas. O CLI rejeita filtros invalidos em `add` e `set` antes de salvar. Filtros legados invalidos ja persistidos continuam em fail open no runtime, com log de warning.

## Template Variables

Mensagens de triggers suportam `{{variável}}` resolvidos com os dados do evento:

```
data.cwd startsWith "/path/to/workspace"
```

| Variável | Descrição |
|----------|-----------|
| `{{topic}}` | Tópico NATS que disparou o trigger |
| `{{data.cwd}}` | Diretório de trabalho da sessão |
| `{{data.last_assistant_message}}` | Última mensagem do CC (truncada em 300 chars) |
| `{{data.prompt}}` | Prompt enviado pelo usuário (UserPromptSubmit) |
| `{{data.<campo>}}` | Qualquer campo do payload do evento |

Variáveis não resolvidas ficam como estão (`{{data.inexistente}}`).

**Exemplo de message com templates:**
```
CC parou em {{data.cwd}}. Última msg: "{{data.last_assistant_message}}". Informe o Luis se relevante, senão @@SILENT@@.
```

**Exemplo com template padrão do catálogo:**
```bash
ravi triggers add "Novo email local" --topic "ravi.inbox.mail.received"
```

Mensagem salva pelo catálogo:
```
[ravi mail] novo email no inbox: {{data.mail.messageId}}. De: {{data.mail.fromText}}. Para: {{data.mail.toText}}. Assunto: {{data.mail.subject}}. Use ravi mail messages read {{data.mail.messageId}} para ler.
```

Quando disparar, chega como:
```
[Trigger: Novo email local]
Event: ravi.inbox.mail.received

[ravi mail] novo email no inbox: mail_msg_123. De: Alice <alice@example.com>. Para: nx-luis@ravi.bot. Assunto: Contrato assinado. Use ravi mail messages read mail_msg_123 para ler.
```

## Exemplos

Criar trigger para notificar quando contatos forem modificados:
```bash
ravi triggers add "Contato alterado" --topic "ravi.*.cli.contacts.*" --message "Analise a mudança e notifique o grupo"
```

Criar trigger para monitorar erros:
```bash
ravi triggers add "Permission Alert" --topic "ravi.audit.denied" --message "Analise o erro e sugira correção" --cooldown 1m
```

Criar trigger para aprovação por reaction:
```bash
ravi triggers add "Approval Reaction" \
  --topic "ravi.inbound.reaction" \
  --filter 'data.emoji includes "👍"' \
  --message "Reaction {{data.emoji}} on {{data.targetMessageId}}. Load local approval state by targetMessageId. If there is no pending item or it was already processed, respond @@SILENT@@. Otherwise publish once and mark processed."
```

Para receitas completas com cron, trigger shell, state local e publicação idempotente, use a skill `automation-recipes`.

## Relação com NATS

Triggers reagem a eventos do **NATS** (o barramento de eventos do Ravi). Para entender os tópicos disponíveis, consulte a skill `events`.

- **NATS** = barramento de eventos (pub/sub direto)
- **triggers** = reações automáticas a eventos NATS
