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
Keys: name, message, topic, agent, session, cooldown

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

| Pattern | Descrição |
|---------|-----------|
| `ravi.*.cli.{group}.{command}` | Execuções de CLI tools (ex: `ravi.*.cli.contacts.add`) |
| `ravi.*.tool` | Execuções de SDK tools (Bash, Read, etc) |
| `ravi.*.response` | Respostas de agents |
| `whatsapp.*.inbound` | Mensagens WhatsApp recebidas |
| `matrix.*.inbound` | Mensagens Matrix recebidas |

**Nota:** Triggers em `.prompt`, `.response` e `.claude` são ignorados para evitar loops.

## Exemplos

Criar trigger para notificar quando lead é qualificado:
```bash
ravi triggers add "Lead Qualificado" --topic "ravi.*.cli.outbound.qualify" --message "Analise a qualificação e notifique o grupo"
```

Criar trigger para monitorar erros:
```bash
ravi triggers add "Agent Error" --topic "ravi.*.tool" --message "Analise o erro e sugira correção" --cooldown 1m
```

## Relação com notif.sh

Triggers reagem a eventos do **notif.sh** (o barramento de eventos do Ravi). Para explorar eventos manualmente, buscar histórico, ou emitir eventos, use a skill `notif` (`notif --help`).

- **notif** = barramento de eventos (emitir, buscar, monitorar)
- **triggers** = reações automáticas a eventos do notif

Comandos úteis do notif para debug de triggers:
```bash
# Ver eventos recentes que casam com um topic pattern
notif events list --topic "ravi.*.cli.outbound.qualify" --from 1h

# Monitorar eventos em tempo real
notif subscribe "ravi.*.tool"
```
