---
name: outbound-manager
description: |
  Gerencia filas de outbound do sistema Ravi. Use quando o usuário quiser:
  - Criar, configurar ou gerenciar filas de mensagens automatizadas
  - Adicionar contatos/leads a uma fila
  - Ver status, relatórios ou histórico de conversas
  - Qualificar leads ou atualizar contexto
  - Pausar/iniciar filas ou resetar entries
---

# Outbound Manager

Você gerencia as filas de outbound do Ravi. Outbound são campanhas de mensagens automatizadas para prospecção, follow-up, ou comunicação em massa.

## Comandos de Fila

### Listar filas
```bash
ravi outbound list
```

### Ver detalhes da fila
```bash
ravi outbound show <id>
```

### Criar fila
```bash
ravi outbound create "<nome>" --instructions "<prompt>" --every <interval>
```

Opções:
- `--agent <id>` - Agent que processa
- `--description <text>` - Descrição da fila
- `--active-start <HH:MM>` - Horário início (ex: 09:00)
- `--active-end <HH:MM>` - Horário fim (ex: 22:00)
- `--tz <timezone>` - Fuso horário
- `--follow-up <json>` - Delays por qualificação: `'{"cold":120,"warm":30}'`
- `--max-rounds <n>` - Máximo de rounds por entry

### Iniciar/Pausar fila
```bash
ravi outbound start <id>
ravi outbound pause <id>
```

### Configurar propriedades
```bash
ravi outbound set <id> <key> <value>
```
Keys: name, instructions, every, agent, description, active-start, active-end, tz, follow-up, max-rounds

### Deletar fila
```bash
ravi outbound rm <id>
```

### Executar manualmente
```bash
ravi outbound run <id>
```

## Comandos de Entries

### Adicionar entry
```bash
ravi outbound add <queueId> <phone> --name "Nome" --context '{"empresa":"Acme"}'
```

Ou adicionar por tag:
```bash
ravi outbound add <queueId> - --tag "leads"
```

### Listar entries
```bash
ravi outbound entries <queueId>
```

### Ver status de entry
```bash
ravi outbound status <entryId>
```

### Ver histórico de chat
```bash
ravi outbound chat <entryId>
```

### Atualizar contexto
```bash
ravi outbound context <entryId> '{"empresa":"Nova Info"}'
```

### Qualificar lead
```bash
ravi outbound qualify <entryId> <status>
```
Status: cold, warm, interested, qualified, rejected

### Marcar como concluído
```bash
ravi outbound done <entryId>
ravi outbound complete <entryId>
ravi outbound skip <entryId>
```

### Resetar entry
```bash
ravi outbound reset <entryId>
ravi outbound reset <entryId> --full  # Limpa contexto também
```

## Relatório Completo

```bash
ravi outbound report              # Todas as filas
ravi outbound report <queueId>    # Fila específica
```

## Enviar Mensagem Manual

```bash
ravi outbound send <entryId> "Mensagem"
```

Opções:
- `--account <id>` - Conta WhatsApp
- `--typing-delay <ms>` - Delay de digitação
- `--pause <ms>` - Pausa antes de digitar
