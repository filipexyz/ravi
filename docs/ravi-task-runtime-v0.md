# Ravi Task Runtime v0

O `task runtime` é o control plane operacional do Ravi para trabalho distribuído entre agents.

A separação correta é:

- `task` = lifecycle rastreável
- `profile` = contrato do processo
- `artifact` = corpo real do trabalho
- `session` = contexto de execução

`TASK.md` não define task. Ele é só um artifact do caso `default`.

## Responsabilidades do Core

O core de tasks deveria cuidar só de:

- criar task
- despachar para agent/sessão
- registrar comments e events
- atualizar progresso/status
- concluir/bloquear/falhar
- arquivar
- mostrar/watch do estado

Ele não deveria inventar processo por fora.

## Camadas

### Runtime core

- DB
- NATS/events
- assignments
- lifecycle
- watch/show

### Catálogo de profiles

- templates de dispatch/resume
- artifacts
- workspace bootstrap
- state defaults
- inputs
- policies

### Agent/session

- `cwd` efetivo
- provider
- permissões
- sessão de execução

### Worktree

- contexto extra para o agent
- não sobrescreve `cwd`

## Fluxo End-to-End

### Create

```bash
ravi tasks create "..." --profile <id> [--input k=v]
```

Fluxo:

1. resolve profile no catálogo
2. valida inputs/templates/artifacts
3. calcula snapshot + state
4. aplica bootstrap do workspace
5. persiste task + event

### Dispatch

```bash
ravi tasks dispatch <task-id> --agent <agent>
```

Fluxo:

1. resolve `session cwd`
2. resolve `worktree` contextual
3. resolve artifact primário
4. renderiza prompt do profile
5. publica prompt
6. persiste assignment + event

### Execução

O agent deve:

1. ler o artifact primário
2. trabalhar no workspace do profile
3. sincronizar estado com `ravi tasks ...`

### Env da Sessão

Quando o turno nasce a partir de uma task despachada ou retomada, o runtime injeta no processo da sessão:

- `RAVI_TASK_ID` sempre que houver binding inequívoco entre prompt, assignment ativa e sessão
- `RAVI_TASK_PROFILE_ID` quando o profile estiver resolvido na task
- `RAVI_PARENT_TASK_ID` quando a task for filha
- `RAVI_TASK_SESSION` com o nome real da sessão atribuída
- `RAVI_TASK_WORKSPACE` com o workspace efetivo da assignment (`worktree`, `task_dir` ou cwd da sessão)

Se uma mesma sessão tiver múltiplas assignments ativas ao mesmo tempo, o runtime não adivinha a task corrente sem `taskBarrierTaskId`.

### Watch / Show

```bash
ravi tasks show <task-id>
ravi tasks watch <task-id>
```

Fluxo:

1. ler DB
2. resolver snapshot/profile
3. resolver artifacts
4. renderizar a surface

Sem side effects.

## Casos

### Caso 1: `default`

- workspace = task workspace
- artifact = `TASK.md`
- loop = editar doc, depois sincronizar runtime

Outros casos (`brainstorm`, `content`, `research`, vídeo, runtime-only) continuam possíveis como profiles declarativos, mas não são built-ins do sistema. Eles entram por `plugin`, `workspace` ou `user`.

## Invariantes

- profile inexistente falha cedo
- template/artifact inválido falha cedo
- `show/watch` não criam arquivo
- `TASK.md` só existe quando o contrato do profile pede isso
- snapshot pinado não muda quando o catálogo evolui
- `cwd` da sessão vem do agent
- `worktree` é só contexto adicional

## Simplificação

O sistema ficou confuso quando conviveu com duas ontologias:

- `task = markdown`
- `task = substrate`

A arquitetura correta escolhe só uma:

- `task = substrate`

Daí em diante:

- `TASK.md` vira só um artifact do `default`
- `brainstorm`, `content`, `research` e vídeo param de ser exceção e também param de ser system built-ins
- o runtime para de “proteger profile non-doc do TASK.md”
- e passa simplesmente a não expor `TASK.md` fora do contrato que realmente o usa

## Superfícies de CLI

Catálogo:

```bash
ravi tasks profiles list
ravi tasks profiles show <profile-id>
ravi tasks profiles preview <profile-id> --title "..." [--input k=v]
ravi tasks profiles validate [profile-id]
ravi tasks profiles init <profile-id> --preset <doc-first|brainstorm|runtime-only|content>
```

Runtime:

```bash
ravi tasks create "..." --instructions "..." --profile <id> [--input k=v]
ravi tasks dispatch <task-id> --agent <agent>
ravi tasks show <task-id>
ravi tasks watch <task-id>
ravi tasks report <task-id> --message "..."
ravi tasks done <task-id> --summary "..."
ravi tasks block <task-id> --reason "..."
ravi tasks fail <task-id> --reason "..."
```

## Linguagem da Surface

A linguagem certa para humanos é:

- qual profile
- qual workspace
- quais artifacts
- qual protocolo de sync
