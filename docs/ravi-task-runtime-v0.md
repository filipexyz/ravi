# Ravi Task Runtime v0

O `task runtime` e o primeiro control plane operacional do Ravi para trabalho distribuido entre agents.

O objetivo nao e virar um Jira. O objetivo e criar uma primitive unica para:

- criar task
- despachar para um agent/sessao
- acompanhar progresso ao vivo
- concluir, bloquear ou falhar com estado persistido

## Leitura operacional

Triangulo base:

- `sessions` = comunicacao e handoff entre sessoes
- `tasks` = execucao operacional rastreavel
- `eval` = medicao e regressao reproduzivel

Uma task normalmente usa uma sessao dedicada para trabalhar, mas sessao nao e task. A sessao e o contexto de conversa; a task e o item operacional com dono, progresso e estado terminal.

## Tese

O loop canônico fica:

1. `ravi tasks create`
2. `ravi tasks dispatch`
3. o agent trabalha numa sessao dedicada
4. o agent reporta via `ravi tasks report`
5. o fluxo termina via `ravi tasks done|block|fail`

Tudo fica rastreado por:

- `tasks`
- `task_assignments`
- `task_events`

## Modelo v0

### Task

- `id`
- `title`
- `instructions`
- `status`
- `priority`
- `progress`
- `created_by`
- `assignee_agent_id`
- `assignee_session_name`
- `summary`
- `blocker_reason`
- timestamps

### Assignment

Historico de despacho da task:

- `task_id`
- `agent_id`
- `session_name`
- `assigned_by`
- `status`
- `assigned_at`
- `accepted_at`
- `completed_at`

### Events

Timeline append-only:

- `task.created`
- `task.dispatched`
- `task.progress`
- `task.blocked`
- `task.done`
- `task.failed`

## Comandos

```bash
ravi tasks create "Fix routing" --instructions "..." [--priority high]
ravi tasks list [--status open] [--agent dev] [--mine]
ravi tasks show <task-id>
ravi tasks dispatch <task-id> --agent dev [--session task-...]
ravi tasks watch [task-id]
ravi tasks report <task-id> --progress 30 --message "..."
ravi tasks done <task-id> --summary "..."
ravi tasks block <task-id> --reason "..."
ravi tasks fail <task-id> --reason "..."
```

## Dispatch Semantics

Por default, o dispatch cria ou reutiliza uma sessao dedicada:

```text
<task-id>-work
```

O dispatch entrega um prompt estruturado para a sessao com o flow obrigatorio:

- reportar progresso pelo CLI
- bloquear via CLI
- concluir via CLI

Ou seja: o protocol do runtime fica embutido na task, nao escondido em docs externas.

Tambem nao substitui `sessions`: se o problema e so perguntar, informar ou coordenar algo rapido entre sessoes, `ravi sessions ...` continua sendo a primitive correta.

## Watch

`ravi tasks watch` consome eventos ao vivo via NATS:

- especifico por task: `ravi.task.<taskId>.event`
- global: `ravi.task.*.event`

Isso ja serve de base para:

- UI futura
- relay do `v3`
- observabilidade do trabalho dos agents

## Contrato v3

O runtime de task agora tambem aparece no barramento `v3` via:

```bash
ravi stream --scope tasks
```

### Scope

- scope: `tasks`
- topic preset: `ravi.task.>`
- capabilities:
  - `snapshot.open`
  - `ping`
  - `task.create`
  - `task.dispatch`
  - `task.report`
  - `task.done`
  - `task.block`
  - `task.fail`

### Snapshot

`snapshot.open` em `scope=tasks` emite `entities.tasks` com:

- `query`
  - `taskId`
  - `status`
  - `agentId`
  - `sessionName`
  - `eventsLimit`
- `items`
  - lista de tasks serializadas para o substrate
- `stats`
  - `total`, `open`, `dispatched`, `inProgress`, `blocked`, `done`, `failed`
- `selectedTask`
  - `task`
  - `activeAssignment`
  - `assignments`
  - `events`
- `artifacts`
  - placeholder canonico para o proximo slice
  - `status = "planned"`
  - `supportedKinds = ["file", "url", "text"]`
  - `items = []`

Exemplo de `snapshot.open` com foco numa task:

```json
{
  "body": {
    "name": "snapshot.open",
    "args": {
      "taskId": "task-a0450dae",
      "eventsLimit": 20
    }
  }
}
```

### Event

Cada mutacao continua publicando em:

- `ravi.task.<taskId>.event`

No substrate `v3`, isso chega como `event` JSONL contendo um body com:

- `kind = "task.event"`
- `taskId`
- `status`
- `priority`
- `progress`
- `assigneeAgentId`
- `assigneeSessionName`
- `task`
- `event`
- `artifacts`

Ou seja: o consumidor `v3` recebe tanto a timeline incremental quanto o estado serializado da task sem precisar recomputar regra de negocio.

### Commands

Os comandos canonicos do boundary `v3` sao:

- `task.create`
  - args: `title`, `instructions`, `priority?`, `createdBy?`, `actor?`
- `task.dispatch`
  - args: `taskId`, `agentId`, `sessionName?`, `assignedBy?`, `actor?`
- `task.report`
  - args: `taskId`, `message?`, `progress?`, `actor?`, `agentId?`, `sessionName?`
- `task.done`
  - args: `taskId`, `summary`, `actor?`, `agentId?`, `sessionName?`
- `task.block`
  - args: `taskId`, `reason`, `actor?`, `agentId?`, `sessionName?`
- `task.fail`
  - args: `taskId`, `reason`, `actor?`, `agentId?`, `sessionName?`

Todos retornam `ack` em sucesso e `error` estruturado em falha.

### Compatibilidade

- o CLI `ravi tasks ...` continua sendo o boundary humano
- o `ravi stream --scope tasks` vira o boundary canonico de substrate
- ambos reaproveitam o mesmo runtime persistido (`tasks`, `task_assignments`, `task_events`)
- nao existe uma segunda maquina de estados para task no `v3`

## Regras Operacionais do v0

- `done` e `failed` sao estados terminais
- `report` tardio nao reabre task terminal
- `blocked` continua sendo task viva; pode voltar para `in_progress`
- o fluxo privilegia uma task com um agente responsavel de cada vez

## O que este v0 ja resolve

- tirar trabalho do feeling
- associar task -> agent -> sessao
- acompanhar progresso vivo
- registrar conclusao/blocker de forma persistida

## O que ainda nao entra

- subtasks
- dependencias entre tasks
- SLA
- UI rica
- grading/eval acoplado diretamente

## Proximo passo recomendado

1. materializar artifacts (`file`, `url`, `text`) em cima do placeholder do substrate
2. adicionar `run-pack` de eval reaproveitando `tasks`
3. conectar consumidores de UI sem criar regra paralela
