---
name: trigger-manager
description: |
  Gerencia triggers de eventos do sistema Ravi. Use quando o usuário quiser:
  - Criar, listar, ver ou deletar triggers
  - Configurar reações automáticas a eventos (CLI, SDK tools, mensagens)
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
```

Opções:
- `--agent <id>` - Agent que processa (default: agent padrão)
- `--cooldown <duration>` - Intervalo mínimo entre disparos (ex: 5s, 1m, 30s)
- `--session <main|isolated>` - Sessão (default: isolated)

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

## Tópicos Disponíveis

Patterns usam wildcards (`*`):

### Inbound e Canais

| Pattern | Descrição |
|---------|-----------|
| `whatsapp.*.inbound` | Mensagens WhatsApp recebidas |
| `matrix.*.inbound` | Mensagens Matrix recebidas |
| `ravi.inbound.reaction` | Reações recebidas (emoji) |
| `ravi.inbound.reply` | Replies a mensagens do bot |
| `ravi.inbound.pollVote` | Votos em enquetes |

### Contatos e Aprovações

| Pattern | Descrição |
|---------|-----------|
| `ravi.contacts.pending` | Novo contato/grupo pendente de aprovação |
| `ravi.approval.request` | Pedido de aprovação cascading |
| `ravi.approval.response` | Resposta de aprovação |

### Agent e Tools

| Pattern | Descrição |
|---------|-----------|
| `ravi.*.cli.{group}.{command}` | Execuções de CLI tools (ex: `ravi.*.cli.contacts.add`) |
| `ravi.*.tool` | Execuções de SDK tools (Bash, Read, etc) |

### Outbound

| Pattern | Descrição |
|---------|-----------|
| `ravi.outbound.deliver` | Mensagens enviadas para canais |
| `ravi.outbound.receipt` | Read receipts enviados |
| `ravi.outbound.refresh` | Refresh de filas outbound |

**Bloqueados (anti-loop):** Triggers em tópicos `ravi.session.*` são rejeitados para evitar loops internos.

## Filtros

Triggers suportam filtros opcionais que impedem o disparo quando o evento não casa com a expressão:

```bash
ravi triggers add "..." --filter 'data.cwd startsWith "/Users/luis/ravi"'
ravi triggers set <id> filter 'data.cwd != "/Users/luis/Dev/fm"'
ravi triggers set <id> filter 'data.permission_mode == "bypassPermissions"'
```

**Sintaxe:** `data.<path> <operador> "<valor>"`

Operadores: `==`, `!=`, `startsWith`, `endsWith`, `includes`

Filtro inválido = fail open (trigger dispara mesmo assim, log de warning).

## Template Variables

Mensagens de triggers suportam `{{variável}}` resolvidos com os dados do evento:

```
data.cwd startsWith "/Users/luis/ravi"
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

## Exemplos

Criar trigger para notificar quando lead é qualificado:
```bash
ravi triggers add "Lead Qualificado" --topic "ravi.*.cli.outbound.qualify" --message "Analise a qualificação e notifique o grupo"
```

Criar trigger para monitorar erros:
```bash
ravi triggers add "Agent Error" --topic "ravi.*.tool" --message "Analise o erro e sugira correção" --cooldown 1m
```

## Relação com NATS

Triggers reagem a eventos do **NATS** (o barramento de eventos do Ravi). Para entender os tópicos disponíveis, consulte a skill `events`.

- **NATS** = barramento de eventos (pub/sub direto)
- **triggers** = reações automáticas a eventos NATS
