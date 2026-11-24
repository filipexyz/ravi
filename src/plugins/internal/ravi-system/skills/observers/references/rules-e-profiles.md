# Observers: rules, profiles e tasks

Para quem precisa de mais que `ravi sessions observe`: observer dedicado, rule por agent/tag/profile, profile próprio, observer de task.

## Selectors Genéricos

`--selector` usa um predicado restrito, sem JavaScript/eval, sobre `source.*`, `turn.*` e `event.*`. Operadores: `==`, `!=`, `startsWith`, `endsWith`, `includes`, `!`, `&&`, `||` e parênteses.

Exemplo para observar somente turnos interativos, mesmo quando um cron executa dentro da sessão `main`:

```bash
ravi observers rules set proactive-followups proactive-followup-observer \
  --scope global \
  --selector 'turn.background == "false"'
```

Selectors de `source.*` são avaliados antes de criar o binding. Selectors com `turn.*` ou `event.*` são avaliados por evento e sobrevivem corretamente a debounce. Expressões inválidas falham fechadas. Use `--selector clear` para remover.

`metadata.sourceExclusions` continua sendo lido para compatibilidade com regras antigas, mas novas regras devem preferir `--selector`.

Reconciliação é explícita: `attach-missing` (padrão), `detach-disabled`, `refresh-profile` ou `full-reconcile`. Ela desativa bindings obsoletos sem apagar o histórico.

## Profiles

Observer profiles são bundles Markdown:

```text
.ravi/observers/profiles/<id>/
  PROFILE.md
  delivery/end-of-turn.md
  delivery/realtime.md
  delivery/debounce.md
  events/message-user.md
  events/message-assistant.md
  events/turn-complete.md
  events/turn-failed.md
  events/turn-interrupt.md
  events/default.md
```

Não use manifest JSON/YAML separado. O frontmatter fica no `PROFILE.md`.

System profiles atuais:

- `compact`: um bloco curto por turno da fonte (pessoa, mensagens do agente, tools em contagem, fim do turno); é o de `ravi sessions observe` e o indicado para observer barato.
- `default`: renderer genérico.
- `tasks`: renderer para observers que atualizam status de tasks via comandos.
- `task-observer`: renderer do observer embutido das tasks; precisa de uma sessão fonte com task ativa (usa `{{input.task.*}}`).

Profiles leem `{{event.detailText}}` (texto inteiro da resposta, ou o preview) e
`{{event.toolInput}}` (uma linha do input da tool). O texto inteiro só chega para
bindings com `metadata.observationDetail: true`; os demais veem o preview.

## Observer Embutido Das Tasks

Toda task cujo profile tem `observer.enabled: true` (os built-ins `default` e
`observed-task`) ganha um observer sem regra cadastrada: role `task-observer`,
rule id `builtin:task-observer`, profile `task-observer`, o agent do worker num
modelo leve, eventos de tool, pulso de 5 min e grant `none` (nenhuma tool). Ele
responde um bloco `<task-verdict>` e o runtime aplica o status. Ele aparece em
`ravi observers bindings` como qualquer binding.

Não crie rule para tasks desses profiles: já existe observer. Uma rule própria
em modo `report` na mesma sessão substitui o embutido (ele fica desligado), para
quem quer outro agent, outro prompt ou permissões de task.

Grant `none` em `--permissions` deixa o observer sem tools: o turno fica
restrito a uma capability que nada satisfaz. Lista vazia mantém o teto do agent.

## Rule Própria De Status

Use quando quiser um observer de status diferente do embutido (outro agent,
outro prompt, grants de task).

Setup típico:

```bash
ravi observers rules set observed-task-status <observer-agent> \
  --scope profile \
  --source-profile observed-task \
  --role task-status \
  --mode report \
  --profile tasks \
  --delivery end_of_turn \
  --permissions tasks.report,tasks.block,tasks.done,tasks.fail
```

`--permissions` aceita atalhos como `tasks.report` ou capability completa como
`use:tool:tasks_report`. Esses grants entram apenas no runtime context do
observer, não na sessão fonte. Para acesso recorrente de contato/agent fora do
contexto do observer, use `ravi permissions resolve <denial-id>` ou
`ravi permissions allow <profile> --to <subject> --agent <agent>
--capabilities <cap>`.

Depois:

```bash
ravi tasks create "..." --profile observed-task
ravi tasks dispatch <task-id> --agent <worker-agent> --execute
```

O worker faz o trabalho e deixa sinais claros. O observer recebe Markdown do
profile `tasks` e decide se chama `ravi tasks report|block|done|fail`. Um report
vindo do observer zera o checkpoint do worker.

## Tag-Driven Observers em Contatos

Rules com `--scope tag --tag-target contact --tag <slug>` agora veem tags ligadas a contatos vinculados à sessão fonte. A resolução acontece via `session_participants` (owner_type=`contact`).

Casos típicos:

- Instância configurada com `defaultContactTags` aplica tag em contatos novos. Rule observer com a mesma tag dispara automaticamente.
- Para mudar de observer, mude a tag do contato (`ravi contacts tag/untag`). Novas bindings serão criadas na próxima avaliação.
- DM-per-peer é o cenário ideal: 1 contato por sessão. Em sessões com vários contatos (group/main), todas as tags presentes são consideradas.

Detalhes operacionais e exemplos completos estão na skill `ravi-system:contacts` no playbook *Tag → Observer por Contato*.
