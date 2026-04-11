---
name: tasks
description: |
  Gerencia o task runtime do Ravi no modo TASK.md first. Use quando precisar:
  - Criar, listar ou inspecionar tasks
  - Despachar trabalho para um agent
  - Sincronizar progresso, blocker ou conclusão a partir do TASK.md
  - Entender como funciona o fluxo task -> TASK.md -> CLI -> DB/NATS
---

# Tasks Manager

O `task runtime` é o control plane operacional do Ravi para trabalho distribuído entre agents.

No modo **TASK.md first**:

- `DB/NATS` continuam sendo a fonte autoritativa do estado operacional
- `TASK.md` é o corpo rico da task
- o agent escreve primeiro no `TASK.md`
- o CLI (`ravi tasks ...`) reconhece o frontmatter do `TASK.md` e sincroniza o runtime

Uma task normalmente usa uma sessão dedicada para trabalhar, mas sessão não é task.

Não é um Jira. É a primitive mínima para:

- criar task
- despachar pra um agent/sessão
- trabalhar a partir do `TASK.md`
- sincronizar progresso e estado terminal com o runtime

## Fluxo canônico

```text
ravi tasks create
-> task nasce em draft/open com TASK.md
-> humano ou agent faz brainstorm/edicao no TASK.md
-> despacho so acontece com aprovacao explicita
-> ravi tasks dispatch
-> agent abre a skill + TASK.md
-> agent edita frontmatter/corpo no TASK.md
-> ravi tasks report | done | block | fail
-> CLI reconhece o TASK.md e sincroniza DB/NATS
```

Tudo fica rastreado em:

- `tasks`
- `task_assignments`
- `task_events`
- `task_comments`

## Processo recomendado

Use este fluxo por default quando a task ainda precisa ser refinada:

1. `ravi tasks create ...`
2. abrir o `TASK.md`
3. fazer brainstorm/edicao no proprio doc ate a task ficar boa
4. obter aprovacao explicita para subir
5. so entao rodar `ravi tasks dispatch ...`

Ou seja:

- o CLI cria a task
- o `TASK.md` amadurece a task
- o dispatch acontece depois da aprovacao

`--agent` no `create` continua existindo para caminho direto, mas o processo recomendado para trabalho que ainda precisa de shaping e:

- criar
- editar/brainstorm
- aprovar
- despachar

## TASK.md

Cada task tem uma pasta canônica com um `TASK.md`.

O frontmatter é **mínimo** e estruturado:

```yaml
---
id: "task-1234abcd"
title: "Exemplo"
status: "in_progress"
priority: "high"
progress: 60
summary: null
blocker_reason: null
---
```

Campos reconhecidos pelo CLI:

- `status`
- `priority`
- `progress`
- `summary`
- `blocker_reason`

O corpo é livre para contexto rico. Template sugerido:

- `## Objective`
- `## Workflow`
- `## Plan`
- `## Notes`
- `## Activity Log`
- `## Outcome`
- `## Blockers`

## Como um agent deve proceder quando recebe uma task

Fluxo esperado:

1. abrir a skill de tasks
2. abrir o `TASK.md` cujo path veio no prompt de dispatch
3. escrever primeiro no `TASK.md`
4. manter `frontmatter` e corpo coerentes
5. rodar `ravi tasks ...` para sincronizar o runtime

Não fazer:

- reportar progresso só no chat
- tratar o markdown como source of truth operacional
- editar só o corpo e esquecer o frontmatter quando houver mudança estrutural

## Comandos principais

### Criar

```bash
ravi tasks create "Fix routing" --instructions "..." [--priority high]
```

Cria a task, a pasta canônica e um `TASK.md` template.

### Inspecionar

```bash
ravi tasks show <task-id>
```

Mostra:

- estado estrutural no runtime
- path do `TASK.md`
- frontmatter reconhecido do `TASK.md`
- histórico de eventos
- comentários da task

### Despachar

```bash
ravi tasks dispatch <task-id> --agent dev [--session minha-sessao]
```

Sem `--session`, o Ravi cria/reutiliza:

```text
<task-id>-work
```

O prompt de dispatch deve instruir o agent a:

- carregar esta skill
- abrir o `TASK.md`
- escrever primeiro no markdown
- usar o CLI só para sincronizar o runtime

### Sincronizar progresso

Preferência:

```bash
ravi tasks report <task-id>
```

Nesse caso o CLI reconhece `frontmatter.progress` do `TASK.md`.

Retrocompatibilidade:

```bash
ravi tasks report <task-id> --progress 30 --message "investigando resolver"
```

### Comentar / steer

```bash
ravi tasks comment <task-id> "nova direção / observação"
```

Semântica:

- comentário é entidade própria, separada de `task_events`
- o comentário aparece em `ravi tasks show`
- o runtime também emite `task.comment`
- se a task estiver `dispatched`, `in_progress` ou `blocked`, o comentário faz steer da sessão responsável
- steer não substitui progresso/estado; o agent continua precisando usar `report|block|done|fail` quando houver mudança real

### Encerrar

Bloqueio:

```bash
ravi tasks block <task-id>
```

O CLI reconhece `frontmatter.blocker_reason`.
Se `frontmatter.progress` estiver presente, o `block` também sincroniza esse progresso.

Conclusão:

```bash
ravi tasks done <task-id>
```

O CLI reconhece `frontmatter.summary`.

Falha:

```bash
ravi tasks fail <task-id>
```

O CLI reconhece `frontmatter.summary` ou `frontmatter.blocker_reason`.

## Semântica de dispatch

O dispatch:

- cria/reutiliza a sessão da task
- injeta o path do `TASK.md`
- instrui o agent a carregar a skill de tasks
- manda o agent operar em modo `TASK.md first`

O agent não deveria inventar um fluxo paralelo fora do markdown.

## Regras operacionais

- `done` e `failed` são terminais
- `report` tardio não reabre task terminal
- `blocked` continua sendo task viva
- por padrão, pense em `1 task ativa -> 1 agent responsável`

## Relação com o v3

O task runtime também aparece no substrate novo via:

```bash
ravi stream --scope tasks
```

Leitura correta:

- `TASK.md` = corpo rico e humano da task
- `ravi tasks ...` = boundary operacional que reconhece e sincroniza
- `ravi stream --scope tasks` = boundary canônico de substrate
