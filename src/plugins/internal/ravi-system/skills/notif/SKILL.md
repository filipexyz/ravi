---
name: notif
description: |
  Gerencia o sistema de eventos notif.sh. Use quando precisar:
  - Buscar eventos históricos (mensagens, tool calls, prompts)
  - Emitir eventos manualmente
  - Ver estatísticas do stream
  - Agendar eventos futuros
  - Monitorar eventos em tempo real
  - Gerenciar webhooks e DLQ
---

# notif.sh — Event Hub

O notif.sh é o pub/sub central do Ravi. Todas as mensagens, prompts, tool calls e respostas passam por ele como eventos em tópicos.

## Conceitos

- **Topic**: Namespace hierárquico separado por `.` (ex: `ravi.session.main.prompt`)
- **Event**: Payload JSON emitido num tópico com timestamp e ID
- **Wildcards**: `*` casa com um nível (ex: `ravi.session.*.prompt`)
- **Consumer Groups**: Múltiplos subscribers compartilhando carga

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

## Comandos

### Buscar Eventos Históricos

```bash
# Últimos 10 eventos de qualquer tópico
notif events list --limit 10

# Eventos de uma sessão nos últimos 5 minutos
notif events list --topic "ravi.session.supervisor.tool" --from 5m

# Prompts de todas as sessões na última hora
notif events list --topic "ravi.session.*.prompt" --from 1h

# Respostas de um agent específico
notif events list --topic "ravi.session.doma.response" --from 24h

# Tool calls de uma sessão
notif events list --topic "ravi.session.main.tool" --from 10m --limit 20

# Eventos entre datas específicas
notif events list --topic "ravi.*" --from 2026-02-14T10:00:00Z --to 2026-02-14T12:00:00Z

# Output em JSON (para parsing programático)
notif events list --topic "ravi.session.*.prompt" --from 1h --json
```

### Emitir Eventos

```bash
# Emitir evento simples
notif emit ravi.test.ping '{"hello":"world"}'

# Via stdin (recomendado para caracteres especiais)
printf '{"text":"Hello!"}' | notif emit topic.name

# Agendar evento futuro
notif emit ravi.reminder '{"msg":"check status"}' --in 30m
notif emit ravi.reminder '{"msg":"daily check"}' --at "2026-02-15T09:00:00Z"

# Request-response (emite e espera resposta)
notif emit ravi.request '{"action":"status"}' \
  --reply-to 'ravi.response' \
  --filter '.id == $input.id' \
  --timeout 30s
```

### Monitorar em Tempo Real

```bash
# Subscribir a todos os prompts
notif subscribe "ravi.session.*.prompt"

# Múltiplos tópicos
notif subscribe "ravi.session.*.response" "ravi.session.*.tool"

# Com filtro jq
notif subscribe 'ravi.session.*.tool' --filter '.toolName == "Bash"'

# Sair após primeiro evento matching
notif subscribe 'ravi.session.*.response' --once --timeout 30s

# Custom format
notif subscribe 'ravi.session.*.tool' \
  --format '{{.data.toolName}} - {{.data.event}}'
```

### Estatísticas

```bash
# Ver stats do stream
notif events stats

# Health check do server
notif health
```

### Eventos Agendados (Schedules)

```bash
# Listar agendamentos
notif schedules list

# Ver detalhes
notif schedules get <id>

# Cancelar
notif schedules cancel <id>

# Executar imediatamente
notif schedules run <id>
```

### Webhooks

```bash
# Listar webhooks
notif webhooks list

# Criar webhook
notif webhooks create --topic "ravi.session.*.response" --url "https://example.com/hook"

# Ver entregas recentes
notif webhooks deliveries <id>

# Ativar/desativar
notif webhooks enable <id>
notif webhooks disable <id>
```

### Dead Letter Queue (DLQ)

```bash
# Listar mensagens que falharam
notif dlq list

# Reenviar uma mensagem
notif dlq replay <id>

# Reenviar todas
notif dlq replay-all

# Limpar DLQ
notif dlq purge
```

## Casos de Uso Comuns

### Debugar o que aconteceu nos últimos minutos
```bash
notif events list --topic "ravi.session.*.prompt" --from 5m
```

### Ver tool calls de uma sessão
```bash
notif events list --topic "ravi.session.supervisor.tool" --from 10m
```

### Ver todas as respostas enviadas para WhatsApp
```bash
notif events list --topic "ravi.outbound.deliver" --from 1h
```

### Agendar lembrete
```bash
notif emit ravi.session.main.prompt '{"prompt":"[System] Inform: Lembrete: verificar status do deploy"}' --in 1h
```

## Relação com Triggers

O Ravi tem um sistema de **triggers** (`ravi triggers`) que reagem automaticamente a eventos do notif. Enquanto o notif é o barramento de eventos, triggers são as reações automáticas.

- **notif** = observar, buscar, emitir eventos manualmente
- **triggers** = reagir automaticamente quando um evento matching acontece

Exemplo: criar um trigger que reage quando um lead é qualificado:
```bash
ravi triggers add "Lead Qualificado" --topic "ravi.*.cli.outbound.qualify" --message "Analise a qualificação"
```

Para gerenciar triggers, use a skill `triggers` (`ravi triggers --help`).

## Flags Globais

| Flag | Descrição |
|------|-----------|
| `--json` | Output em JSON |
| `--config <path>` | Config file (default: `~/.notif/config.json`) |
| `--server <url>` | Server URL override |
