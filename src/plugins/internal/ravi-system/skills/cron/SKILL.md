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

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `CRON_JOB_NOT_FOUND`). O envelope traz `suggestions` com jobs reais parecidos — consulte antes de concluir "não existe".
- `2` erro de uso (flag/argumento inválido). O envelope traz `acceptedFlags`: corrija a chamada, não insista na mesma sintaxe.
- `3` freio de escrita — não é erro. Nada foi gravado nem disparado; o envelope traz `dryRun:true` e `plan` com exatamente o que seria feito. Revise o plano e repita com `--execute`.

Onde o freio existe hoje: `cron rm` (deletar é destrutivo) e `cron run` (dispara o job REAL agora, fora do agendamento — execução de agente ou shell de verdade) são dry-run por default e exigem `--execute`:

```bash
ravi cron run abc123 --json             # exit 3: plan mostra o job resolvido e a mensagem que seria enviada
ravi cron run abc123 --execute --json   # dispara de verdade
ravi cron rm abc123 --json              # exit 3: plan mostra o job que seria deletado
ravi cron rm abc123 --execute           # deleta de verdade
```

Sem freio (gravam na hora, declaradas): `add`, `set`, `enable`, `disable` — todas têm comando inverso. Nessas o freio é você: confira o alvo antes de rodar.

Compact mode: `cron list --fields id,name,enabled` devolve só esses campos por item — use em varredura para não arrastar o objeto inteiro de cada job.

Checklist antes de responder sobre cron:

- Tratei exit 3 como freio (revisei o `plan`) e não como falha?
- Consultei `suggestions` do envelope antes de declarar not-found?

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

Shell direto, sem invocar agent/LLM:
```bash
ravi cron add "ETL" --cron "*/15 * * * *" --shell "python3 /home/ravi/job.py"
```

Shell com agent apenas em erro:
```bash
ravi cron add "ETL" \
  --cron "*/15 * * * *" \
  --shell "python3 /home/ravi/job.py" \
  --on-error notify-session:admin-group
```

One-shot (executa uma vez):
```bash
ravi cron add "Lembrete" --at "2025-02-01T15:00" --message "Lembrar de X" --delete-after
```

Opções:
- `--agent <id>` - Agent que executa
- `--account <id>` - Conta/canal usado para entrega quando o job responde em chat
- `--tz <timezone>` - Fuso horário (ex: America/Sao_Paulo)
- `--isolated` - Roda em sessão isolada
- `--delete-after` - Deleta após primeira execução
- `--description <text>` - Descrição do job
- `--shell <cmd>` / `--exec <cmd>` - Executa comando shell direto sem prompt LLM
- `--timeout <seconds|duration>` - Timeout para shell jobs, ex: `60`, `30s`, `10m`
- `--env-file <path>` - Arquivo dotenv simples para shell jobs
- `--on-error notify-session:<session>` - Notifica sessão só quando shell job falhar
- `--idempotency-key <key>` - Reutiliza duravelmente a mesma criação em retries; a mesma key não pode representar outro job

Quando `cron add` roda dentro de um turn de observer com source turn id, Ravi deriva a idempotência automaticamente de rule + source turn + ação normalizada. Isso impede que replay/retry crie follow-ups duplicados, inclusive depois que um one-shot `--delete-after` já foi removido. Fora desse contexto, produtores automatizados devem passar uma `--idempotency-key` estável.

Depois de criar job que deve responder em um chat/sessão específica, sempre rode `ravi cron show <id>` e confira `agent`, `account`, `session`/`reply-session` antes de considerar pronto. Não confie no account herdado do contexto atual: se o cron entregar pelo account errado, o agent pode trabalhar e falhar no delivery com `chat not found`.

Para trabalho determinístico (ETL, scraping, sync, scripts idempotentes), prefira `--shell` em vez de pedir para um agent usar Bash. Isso mantém tracking em `ravi cron list/show`, evita custo de tokens em runs bem-sucedidos e só envolve agent quando houver `--on-error`.

Para jobs de monitoramento, faça o prompt comparar o estado atual com a última checagem e responder só quando houver mudança material. Não transforme o mesmo bloqueio em alerta a cada tick: se a causa, impacto e próximo passo continuam iguais, o job deve registrar localmente ou ficar silencioso. Se a repetição do bloqueio indicar risco novo, como retry infinito ou consumo inútil de tentativas, reporte esse risco como decisão operacional necessária em vez de recontar o mesmo erro.

### Ativar/Desativar
```bash
ravi cron enable <id>
ravi cron disable <id>
```

### Configurar propriedades
```bash
ravi cron set <id> <key> <value>
```

Keys: name, message, shell, exec, timeout, env-file, on-error, cron, every, tz, agent, account, description, session, reply-session, delete-after

### Executar manualmente

`cron run` dispara o job REAL agora, fora do agendamento. Sem `--execute` é dry-run (exit 3) e mostra o job resolvido e a mensagem que seria enviada:

```bash
ravi cron run <id>            # dry-run: mostra o plano, não dispara
ravi cron run <id> --execute  # dispara de verdade
```

### Deletar

Sem `--execute` é dry-run (exit 3); nada é deletado:

```bash
ravi cron rm <id> --execute
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
