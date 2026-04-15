# Workflow Substrate

> O nome do arquivo ficou legado. O conteúdo abaixo documenta o contrato real do workflow implementado hoje no Ravi.

## Objetivo

Descrever o substrate atual de `workflow` do Ravi sem puxar mais abstração para dentro dele.

Separação preservada neste corte:

- `workflow` = coordenação
- `task` = execução
- `profile` = contrato local da task
- `launch plan` = continua na task
- `parentTaskId` = continua lineage/grouping/UI/callback
- `project/goal/ravimem` = fora deste corte

## O que existe hoje

O modelo real já não é mais o `v0` antigo de “membership de tasks com edges derivadas”.

O substrate atual é:

- `workflow_spec`
- `workflow_run`
- `workflow_node_run`
- `workflow_run_edge`
- `workflow_node_run_tasks` como histórico de attempts por node run

Em frase curta:

- `spec` descreve o processo
- `run` coordena uma instância viva
- `node_run` guarda o estado de coordenação por node
- `task` continua sendo a execução concreta de um node `kind=task`

## Entidades

### `workflow_specs`

Fonte de verdade do desenho do workflow.

Campos relevantes:

- `id`
- `title`
- `summary`
- `policy_json`
- `nodes_json`
- `edges_json`
- `created_by`
- `created_by_agent_id`
- `created_by_session_name`
- `archived_at`
- `created_at`
- `updated_at`

### `workflow_runs`

Instância viva de um `workflow_spec`.

Campos relevantes:

- `id`
- `workflow_spec_id`
- `title`
- `summary`
- `policy_json`
- `status`
- `created_by`
- `created_by_agent_id`
- `created_by_session_name`
- `archived_at`
- `created_at`
- `updated_at`
- `started_at`
- `completed_at`

### `workflow_node_runs`

Estado vivo de cada node dentro de um `workflow_run`.

Campos relevantes:

- `id`
- `workflow_run_id`
- `spec_node_key`
- `label`
- `node_kind`
- `requirement`
- `release_mode`
- `status`
- `waiting_on_node_keys_json`
- `current_task_id`
- `attempt_count`
- `released_at`
- `released_by`
- `released_by_agent_id`
- `released_by_session_name`
- `ready_at`
- `blocked_at`
- `completed_at`
- `skipped_at`
- `cancelled_at`
- `archived_at`
- `last_task_transition_at`
- `created_at`
- `updated_at`

### `workflow_run_edges`

Edge materializada no `run`, já resolvida em ids de `node_run`.

Campos:

- `workflow_run_id`
- `from_node_run_id`
- `to_node_run_id`
- `created_at`

### `workflow_node_run_tasks`

Histórico de attempts de task vinculadas a um `node_run`.

Campos:

- `workflow_node_run_id`
- `task_id`
- `attempt`
- `created_at`

## Nós

Tipos de node suportados hoje:

- `task`
- `gate`
- `approval`

### `task`

- pode receber task concreta
- pode criar nova task via CLI
- pode manter histórico de múltiplas attempts

### `gate`

- não vira task
- exige `release_mode=manual`
- normalmente representa checkpoint/gate operacional

### `approval`

- não vira task
- exige `release_mode=manual`
- normalmente representa aprovação humana explícita

## Requirement e Release

### `requirement`

Valores atuais:

- `required`
- `optional`

Impacto:

- `required` pesa no agregado final do run
- `optional` pode ser `skipped` ou `cancelled` sem impedir `done`

### `release_mode`

Valores atuais:

- `auto`
- `manual`

Regras:

- `task` defaulta para `auto`
- `gate` e `approval` são sempre `manual`
- `manual` só libera avanço com `release`

## Status

### `workflow_run.status`

Valores atuais:

- `draft`
- `waiting`
- `ready`
- `running`
- `blocked`
- `done`
- `failed`
- `cancelled`
- `archived`

Leitura agregada:

- `archived` se o run estiver arquivado
- `draft` se não houver node ativo suficiente para coordenar
- `failed` se algum node ativo falhar
- `cancelled` se algum node `required` for cancelado
- `running` se algum node estiver rodando
- `blocked` se algum node estiver blocked e nenhum estiver running
- `ready` se algum node estiver ready
- `waiting` se o trabalho restante estiver em `pending` ou `awaiting_release`
- `done` quando todos os nodes relevantes estiverem resolvidos

### `workflow_node_run.status`

Valores atuais:

- `pending`
- `awaiting_release`
- `ready`
- `running`
- `blocked`
- `done`
- `failed`
- `skipped`
- `cancelled`
- `archived`

Semântica:

- `pending` = aguardando predecessor satisfazer edge
- `awaiting_release` = predecessor já liberou, mas falta release manual
- `ready` = pode receber task ou avançar
- `running` = task atual entrou em execução
- `blocked` = task atual bloqueou
- `done` = node resolvido com sucesso
- `failed` = task atual falhou
- `skipped` = optional omitido
- `cancelled` = node cancelado
- `archived` = saiu do agregado, mas continua no histórico

## Cardinalidade

### `task -> workflow_node_run`

Hoje a cardinalidade é:

- uma `task` pertence a **no máximo um** `workflow_node_run`

Isso é garantido por:

- `UNIQUE(task_id)` em `workflow_node_run_tasks`

### `workflow_node_run -> task attempts`

Hoje a cardinalidade é:

- um `workflow_node_run` pode ter **várias tasks ao longo do tempo**
- apenas uma delas é a `current_task_id`

Ou seja:

- `current_task_id` aponta para a attempt atual
- `workflow_node_run_tasks` guarda o histórico de attempts
- `attempt_count` é o contador acumulado do node

Isto é importante:

- o node run **não** fica colado em “uma task pra sempre”
- retry/recreate/reassign cabem na modelagem atual

## Scheduling

### O que governa readiness

O grafo de readiness do workflow hoje vem de:

- `workflow_run_edges`
- `waiting_on_node_keys_json`
- `release_mode`
- estado do `current_task_id` quando o node é `kind=task`

### O que NÃO governa readiness

Estas coisas não entram no scheduling do workflow:

- `parentTaskId`
- `project`
- `goal`
- `ravimem`
- `profile`
- `launch plan`

### Relação com `launch plan`

`launch plan` continua sendo da task.

O workflow:

- sabe qual task está no node agora
- reage ao lifecycle dessa task
- não move `launch plan` para dentro do próprio substrate

## Sincronização com tasks

O vínculo real hoje é:

- `task` ligada a `workflow_node_run`
- lifecycle da task sincroniza o `node_run`

Mapeamento principal:

- `task.open + readiness ready` -> `node_run.ready`
- `task.open + readiness waiting` -> `node_run.pending`
- `task.dispatched|in_progress` -> `node_run.running`
- `task.blocked` -> `node_run.blocked`
- `task.done` -> `node_run.done`
- `task.failed` -> `node_run.failed`

Para nodes não-task:

- `release` pode levar `awaiting_release -> done`
- ou `awaiting_release -> ready`, dependendo do tipo do node

## Invariantes

- `profile` continua local da task
- `workflow` não carrega snapshot de `profile`
- `parentTaskId` nunca vira scheduling
- `launch plan` continua na task
- `project/goal/ravimem` ficam fora deste corte
- `task` não pode pertencer a dois node runs
- `node_run` pode ter várias attempts ao longo do tempo

## CLI atual

### Specs

```bash
ravi workflows.specs create <spec-id> --definition '<json>'
ravi workflows.specs create <spec-id> --file <path>
ravi workflows.specs list
ravi workflows.specs show <spec-id>
```

### Runs

```bash
ravi workflows.runs start <spec-id> [--run-id <id>]
ravi workflows.runs list
ravi workflows.runs show <run-id>
ravi workflows.runs release <run-id> <node-key>
ravi workflows.runs skip <run-id> <node-key>
ravi workflows.runs cancel <run-id> <node-key>
ravi workflows.runs archive-node <run-id> <node-key>
ravi workflows.runs task-attach <run-id> <node-key> <task-id>
ravi workflows.runs task-create <run-id> <node-key> --title "..." --instructions "..."
```

## Não objetivos deste corte

Este substrate atual não faz:

- `project`
- `goal`
- `ravimem`
- scheduler genérico novo
- template/context bucket fora de `spec`
- profile orchestration
- qualquer uso de `parentTaskId` para coordenação

## Leitura certa do estado atual

O workflow atual já é útil para:

- fluxo técnico simples
- fluxo com gate/approval
- fluxo operacional enxuto

Mas a responsabilidade continua estreita:

- `spec` descreve processo
- `run` coordena instância viva
- `task` executa trabalho concreto
