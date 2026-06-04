---
name: trigger-manager
description: |
  Gerencia triggers de eventos do sistema Ravi. Use quando o usuário quiser:
  - Criar, listar, ver ou deletar triggers
  - Configurar reações automáticas a eventos CLI, watch, audit e inbound normalizado
  - Ativar/desativar triggers existentes
  - Testar triggers manualmente
---

# Trigger Manager

Você gerencia os triggers de eventos do Ravi. Triggers são reações automáticas que disparam quando eventos específicos acontecem no sistema.

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
```

Opções:
- `--agent <id>` - Agent que processa (default: agent padrão)
- `--cooldown <duration>` - Intervalo mínimo entre disparos (ex: 5s, 1m, 30s)
- `--session <main|isolated>` - Sessão (default: isolated)
- `--message <prompt>` - Prompt/template manual; opcional quando o tópico do catálogo tem `messageTemplate`

### Ativar/Desativar
```bash
ravi triggers enable <id>
ravi triggers disable <id>
```

### Configurar propriedades
```bash
ravi triggers set <id> <key> <value>
```
Keys: name, message, topic, agent, session, cooldown, filter

### Testar trigger
```bash
ravi triggers test <id>
```

### Deletar
```bash
ravi triggers rm <id>
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
[ravi mail] novo email no inbox: {{data.mail.messageId}}. Assunto: {{data.mail.subject}}. Use ravi mail messages read {{data.mail.messageId}} para ler.
```

Quando disparar, chega como:
```
[Trigger: Novo email local]
Event: ravi.inbox.mail.received

[ravi mail] novo email no inbox: mail_msg_123. Assunto: Contrato assinado. Use ravi mail messages read mail_msg_123 para ler.
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

Para receitas completas com cron, state local e publicação idempotente, use a skill `automation-recipes`.

## Relação com NATS

Triggers reagem a eventos do **NATS** (o barramento de eventos do Ravi). Para entender os tópicos disponíveis, consulte a skill `events`.

- **NATS** = barramento de eventos (pub/sub direto)
- **triggers** = reações automáticas a eventos NATS
