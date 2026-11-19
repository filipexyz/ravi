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

> Verbos: RELATAR. Compõe com: bases (rotina que grava ou lê linhas), pages (snapshot), apps (rotina que chama um app), sessions (thread que o run abre age pelo dono do job), whatsapp.
> Solução com mais de uma peça? `ravi skills show solucoes` primeiro.

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
ravi cron list                 # jobs do agent atual (default)
ravi cron list --all-agents    # jobs de todos os agents que você pode ver
ravi cron list --agent <id>    # jobs de um agent específico
```

Visibilidade cross-agent segue grants no agent dono: `view agent:<id>` deixa
listar/ver os jobs daquele agent; `modify agent:<id>` deixa
`enable/disable/set/run/rm`. Superadmin vê e altera tudo. Jobs criados sem
`--agent` pertencem ao agent default. Em `--json`, `filters.visibility`
indica `scoped` (jobs de agents que você não pode ver foram omitidos) ou
`full`. Sem autorização para alterar um job existente, o CLI responde
`PERMISSION_DENIED` (com `requiredCapability` e `denialId` quando o dono é
visível) — não `Job not found`; `Job not found` significa id errado ou job que
você não pode ler.

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
- `--env-file <path>` - Arquivo dotenv simples para shell jobs; tem que ser do usuário que roda o Ravi e sem escrita para grupo ou outros (`chmod 600`), senão a execução falha com o motivo
- `--on-error notify-session:<session>` - Notifica sessão só quando shell job falhar
- `--idempotency-key <key>` - Reutiliza duravelmente a mesma criação em retries; a mesma key não pode representar outro job

Quando `cron add` roda dentro de um turn de observer com source turn id, Ravi deriva a idempotência automaticamente de rule + source turn + ação normalizada. Isso impede que replay/retry crie follow-ups duplicados, inclusive depois que um one-shot `--delete-after` já foi removido. Fora desse contexto, produtores automatizados devem passar uma `--idempotency-key` estável.

Depois de criar job que deve responder em um chat/sessão específica, sempre rode `ravi cron show <id>` e confira `agent`, `account`, `session`/`reply-session` e `Runs as` antes de considerar pronto. Não confie no account herdado do contexto atual: se o cron entregar pelo account errado, o agent pode trabalhar e falhar no delivery com `chat not found`.

**Runs as (dono do job).** O turno que cria o job define o dono: terminal, DM do próprio operador ou o operador falando num grupo → `operator`; qualquer outra pessoa pedindo num chat → `contact:<id>` (um `cron set` vindo dela que muda o que o job roda ou onde responde, como mensagem, nome, agente ou reply-session, também passa o job para ela; descrição, agenda, timeout e `delete-after` não mudam o dono; para o operador é mais estreito: o job de outra pessoa só passa para ele quando ele escreve a mensagem ou o comando, para que um prompt que ele não escreveu nunca rode com a autoridade dele). O job roda com a autoridade do dono atual (quem o criou ou quem mudou por último o que ele roda), nunca com o `ravi login` do operador (o login só autentica a instalação). Job de um contato (`runsAsOperator: false` em `ravi cron show <id> --json`; um contato vinculado ao próprio operador conta como operador) age como essa pessoa: Bases e Pages share/invites/access vão no nome dela, pelo `ravi link` dela e com o papel dela na org. Sem link, recusam com `ACTOR_NOT_LINKED` e `linkFlow: routine` (o Ravi não manda DM num run agendado; reporte ao operador que a pessoa precisa vincular a conta mandando mensagem no privado). Conectores pessoais e Knowledge são do operador e recusam o job (`CONNECTOR_SPEAKER_NOT_OWNER`, `KNOWLEDGE_TURN_NOT_OPERATOR`). Job sem pessoa dona (`unknown`) recebe `ACTOR_UNKNOWN` com `refusalReason: routine_not_operator_owned`. `cron add`/`cron set` avisam quando o job não roda como o operador. Job que precisa dos conectores ou do Knowledge do operador só está pronto com `runsAsOperator: true`; qualquer job recorrente que usa Bases, Pages ou conectores só está pronto depois de um `ravi cron run <id> --execute` real que produziu o resultado esperado. Não rode antes da hora um job one-shot (`--at`, `--delete-after`): o run manual consome o job. Confira a configuração e confirme depois do run agendado. `lastStatus: ok` sozinho não prova nada, porque o turno completa mesmo com o comando recusado. Se o pedido veio de outra pessoa e o job precisa de conectores ou Knowledge do operador, diga a ela que o operador precisa criar o job e avise o operador.

Para trabalho determinístico (ETL, scraping, sync, scripts idempotentes), prefira `--shell` em vez de pedir para um agent usar Bash. Isso mantém tracking em `ravi cron list/show`, evita custo de tokens em runs bem-sucedidos e só envolve agent quando houver `--on-error`. Só o operador pode ser dono de um job `--shell`: o comando roda com o acesso da máquina e as credenciais do operador, então nada o prende às permissões de outra pessoa. Num turno de outra pessoa, `cron add --shell` (e um `cron set` que deixaria um shell com outro dono) é recusado com `CRON_SHELL_NOT_OPERATOR` (exit 3): não repita, use um job de agente (`--message`, que age como quem criou) ou peça ao operador. O runner não roda job shell de outro dono.

**Job shell desligado pelo runner.** Job `--shell` cujo dono não é o operador (um job antigo sem dono, ou de um contato) não roda: o runner o desliga em vez de executar, sem rodar o comando e sem próxima execução, e manda **um** aviso por mensagem direta **só ao operador**. O dono, que pode ser um contato, não recebe nada, porque não tem como agir. O texto nomeia o job, o código e o próximo passo, e nunca leva comando, env nem saída. O operador recria o job do próprio chat com o Ravi ou o converte em job de agente (`--message`); `cron enable` sem trocar o dono só desliga de novo na próxima execução e avisa outra vez.

A DM vai para o chat direto do **único** contato com a tag `permission-owner` (`ravi-system:contacts`, "Dono da instalação"). Sem contato marcado, com mais de um, ou com o marcado sem identidade de canal ligada a uma instância, nenhuma DM sai e o aviso cai como prompt na sessão principal do agent padrão: não se perde, mas só aparece lá. `ravi doctor --domain permissions` (`permissions.owner_contact`) acusa os dois primeiros casos antes de o primeiro aviso ser preciso.

**O que o `ravi` dentro de um shell job alcança.** O run injeta um `RAVI_CONTEXT_KEY` de curta duração (revogado ao fim do comando e no boot do daemon). Essa chave só alcança uma lista fechada, e de cada item só o que o agent do job também pode:

- Bases: `bases list/show`; `bases rows query/get/history/export/add/update/archive/restore`; `bases views list/show/query`
- Pages: `pages list/read/ship`. Publique com `--body` (ou stdin); `--html`, `--dir` e qualquer `--out` em arquivo pedem leitura/escrita de disco e recusam.
- `self whoami`

Fica fora: sessions, tasks, costs, media send e o resto da CLI. Para isso, use um job `--message` (o agent faz com as ferramentas dele) ou rode o comando fora do cron. Saída vai para stdout, não para `--out`.

**Execução em andamento.** O dono é fixado junto das instruções no momento do disparo. Transferir o job vale só na próxima execução. Desativar ou excluir o job impede futuros disparos agendados, mas não cancela o trabalho já admitido (incluindo one-shots excluídos automaticamente). Bloquear ou remover o contato dono original recusa as próximas chamadas de conectores, Bases, acesso a Pages e Knowledge; não desfaz ações concluídas nem mata um processo shell já iniciado. Runs antigos sem snapshot de admissão recusam essas chamadas: uma nova execução precisa ser admitida pelo runner.

Trabalho que o run repassa: uma thread que recebe trabalho de um turno de cron age pelo dono do job (não pelo requisitante anterior da thread), por até 72 h contadas daquele run. Tabela de quem age: `ravi skills show bases --file references/autoria.md`.

Job recusado ou falhando: não desative em silêncio (`ravi cron disable`). Reporte o job e a recusa ao operador e deixe a decisão com ele.

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
