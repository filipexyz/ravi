---
name: cron-manager
description: |
  Gerencia jobs agendados do sistema Ravi. Use quando o usuário quiser:
  - Criar, listar ou deletar tarefas agendadas
  - Configurar cron expressions, intervalos ou horários específicos
  - Ativar/desativar jobs existentes
  - Executar jobs manualmente
---

# Cron Manager

Você gerencia os jobs agendados do Ravi. Jobs são tarefas que rodam automaticamente em horários ou intervalos específicos.

## Tipos de Schedule

| Tipo | Exemplo | Descrição |
|------|---------|-----------|
| `--cron` | `"0 9 * * *"` | Cron expression (todo dia 9h) |
| `--every` | `30m`, `1h`, `2h30m` | Intervalo fixo |
| `--at` | `2025-02-01T15:00` | Horário único (one-shot) |

## Comandos Disponíveis

### Listar jobs
```bash
ravi cron list
```

### Ver detalhes
```bash
ravi cron show <id>
```

### Criar job

Com cron expression:
```bash
ravi cron add "Relatório Diário" --cron "0 9 * * *" --message "Gere o relatório diário"
```

Com intervalo:
```bash
ravi cron add "Check Emails" --every 30m --message "Verifique novos emails"
```

One-shot (executa uma vez):
```bash
ravi cron add "Lembrete" --at "2025-02-01T15:00" --message "Lembrar de X" --delete-after
```

Opções:
- `--agent <id>` - Agent que executa
- `--tz <timezone>` - Fuso horário (ex: America/Sao_Paulo)
- `--isolated` - Roda em sessão isolada
- `--delete-after` - Deleta após primeira execução
- `--description <text>` - Descrição do job

### Ativar/Desativar
```bash
ravi cron enable <id>
ravi cron disable <id>
```

### Configurar propriedades
```bash
ravi cron set <id> <key> <value>
```

Keys: name, message, cron, every, tz, agent, description, session, delete-after

### Executar manualmente
```bash
ravi cron run <id>
```

### Deletar
```bash
ravi cron rm <id>
```

## Cron Expression Reference

```
┌───────────── minuto (0-59)
│ ┌───────────── hora (0-23)
│ │ ┌───────────── dia do mês (1-31)
│ │ │ ┌───────────── mês (1-12)
│ │ │ │ ┌───────────── dia da semana (0-6, 0=domingo)
│ │ │ │ │
* * * * *
```

Exemplos:
- `0 9 * * *` - Todo dia às 9h
- `0 9 * * 1-5` - Dias úteis às 9h
- `*/15 * * * *` - A cada 15 minutos
- `0 0 1 * *` - Primeiro dia do mês à meia-noite
- `0 18 * * 5` - Toda sexta às 18h

## Exemplos

Relatório semanal toda segunda:
```bash
ravi cron add "Weekly Report" --cron "0 9 * * 1" --message "Gere relatório semanal" --tz "America/Sao_Paulo"
```

Verificação a cada 2 horas:
```bash
ravi cron add "Health Check" --every 2h --message "Verifique status dos sistemas"
```

Lembrete único:
```bash
ravi cron add "Reunião" --at "2025-01-30T14:00" --message "Lembrar: reunião em 15min" --delete-after
```
