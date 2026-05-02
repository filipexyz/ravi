---
name: observers
description: |
  Gerencia o Observation Plane do Ravi. Use quando precisar:
  - Listar, explicar ou atualizar observer bindings
  - Criar regras de observer por global/agent/session/task/profile/tag
  - Criar, validar ou pré-visualizar observer profiles Markdown
  - Configurar task observers como `observed-task` + profile `tasks`
---

# Observers

Observers são sessões sidecar que recebem eventos canônicos de uma sessão fonte.
Eles são assíncronos e isolados: não contaminam o prompt, permissões ou runtime
da sessão observada.

## Modelo Mental

- `source session`: sessão observada.
- `observer session`: sessão Ravi comum que recebe o prompt de observação.
- `rule`: decide quando criar o observer.
- `binding`: relação durável entre source e observer.
- `profile`: decide como eventos viram Markdown para o observer.

Rules escolhem **quando** observar. Profiles escolhem **como** formatar.

## Comandos

```bash
ravi observers list
ravi observers show <binding-id>
ravi observers refresh <session>

ravi observers rules list
ravi observers rules show <rule-id>
ravi observers rules set <rule-id> <observer-agent> [--scope profile] [--source-profile observed-task] [--profile tasks]
ravi observers rules validate
ravi observers rules explain --session <session>

ravi observers profiles list
ravi observers profiles show <profile-id>
ravi observers profiles preview <profile-id> --event message.assistant
ravi observers profiles validate [profile-id]
ravi observers profiles init <profile-id>
```

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

- `default`: renderer genérico.
- `tasks`: renderer para observers que atualizam status de tasks.

## Observed Task

Use `observed-task` quando o worker deve executar sem carregar o protocolo de
status da task no prompt principal.

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
observer, não na sessão fonte.

Depois:

```bash
ravi tasks create "..." --profile observed-task
ravi tasks dispatch <task-id> --agent <worker-agent>
```

O worker faz o trabalho e deixa sinais claros. O observer recebe Markdown do
profile `tasks` e decide se chama `ravi tasks report|block|done|fail`.

## Invariantes

- Não crie rules por padrão em sistemas novos.
- Não injete conteúdo do observer na sessão fonte.
- Não use dumps JSON como formato primário para o observer.
- Não use modo `observe` com permissões mutáveis.
- Não reinicie daemon para validar profile; use `profiles preview|validate`.
