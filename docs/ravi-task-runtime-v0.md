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
- runtime defaults
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
ravi tasks create "..." --profile <id> [--input k=v] [--model <model>] [--effort <level>] [--thinking <mode>]
```

Fluxo:

1. resolve profile no catálogo
2. valida inputs/templates/artifacts
3. calcula snapshot + state
4. aplica bootstrap do workspace
5. persiste task + event

### Dispatch

```bash
ravi tasks dispatch <task-id> --agent <agent> [--model <model>] [--effort <level>] [--thinking <mode>]
```

Fluxo:

1. resolve `session cwd`
2. resolve `worktree` contextual
3. resolve artifact primário
4. resolve runtime efetivo de model/effort/thinking
5. renderiza prompt do profile
6. publica prompt
7. persiste assignment + event

### Runtime Efetivo

Profiles podem declarar `runtimeDefaults: { model?, effort?, thinking? }`. Esse contrato é validado no manifesto e pinado em `profile_snapshot_json`, então uma task antiga continua com os defaults que tinha no momento da criação.

`effort` usa a escala canônica do Ravi: `low|medium|high|xhigh`. O default é `xhigh`; qualquer valor inválido cai para esse default.

Tasks e dispatches podem gravar `runtimeOverride` explícito via `--model`, `--effort` e `--thinking`. O override fica na task, na assignment ou no launch plan, e não usa `sessions set-model`.

A precedência por campo é:

1. override do dispatch ou launch plan
2. override da task
3. `profile.runtimeDefaults`
4. `session.modelOverride` / `session.thinkingLevel` de sessão humana existente
5. `agent.model`
6. modelo global do config
7. `effort` default do runtime: `xhigh`

O contexto explícito da task vence `session.modelOverride` porque a task é o contrato operacional do turno. A preferência da sessão permanece como fallback para turnos sem task ou para tasks sem default/override.

### Execução

O agent deve:

1. ler o artifact primário
2. trabalhar no workspace do profile
3. sincronizar estado com `ravi tasks ...`

### Env da Sessão

Quando o turno nasce a partir de uma task despachada ou retomada, o runtime injeta no processo da sessão:

- `RAVI_TASK_ID` quando o prompt carregar `taskBarrierTaskId` e houver binding ativo entre task, assignment e sessão
- `RAVI_TASK_PROFILE_ID` quando o profile estiver resolvido na task
- `RAVI_PARENT_TASK_ID` quando a task for filha
- `RAVI_TASK_SESSION` com o nome real da sessão atribuída
- `RAVI_TASK_WORKSPACE` com o workspace efetivo da assignment (`worktree`, `task_dir` ou cwd da sessão)

Turnos sem `taskBarrierTaskId` não recebem `RAVI_TASK_*`, mesmo que o processo pai tenha essas variáveis no ambiente. Isso evita vazamento de contexto entre uma task e uma conversa humana posterior.

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
ravi tasks create "..." --instructions "..." --profile <id> [--input k=v] [--model <model>] [--effort <level>] [--thinking <mode>]
ravi tasks dispatch <task-id> --agent <agent> [--model <model>] [--effort <level>] [--thinking <mode>]
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
