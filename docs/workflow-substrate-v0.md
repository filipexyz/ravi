# Workflow Substrate v0

## Objetivo

Materializar `workflow` como camada explícita de coordenação no Ravi sem quebrar o task runtime atual.

Separação que este corte preserva:

- `workflow` = coordenação
- `task` = execução
- `profile` = protocolo local da execução
- `project/goal/ravimem` = fora deste corte

## Tese

O Ravi já tem três primitives fortes para execução:

- `task`
- `dependencies/readiness`
- `launch plan`

O que falta no `v0` não é um novo scheduler. É um objeto canônico de coordenação.

Por isso, o `workflow v0` nasce como:

- objeto próprio
- membership explícita de tasks
- leitura agregada de status/readiness
- edges derivadas do grafo real de dependencies

E não como:

- `task umbrella`
- overload de `parentTaskId`
- novo lugar para guardar `profile`
- novo scheduler paralelo

## Não Objetivos do v0

O `v0` não deve:

- introduzir `project`
- introduzir `goal`
- puxar `ravimem` para dentro do substrate
- mover `launch plan` para fora da task
- duplicar `task_dependencies`
- inventar `workflow profile`
- instanciar tasks lazy a partir de templates
- usar `parentTaskId` como fonte de scheduling

## Modelo

### Workflow

Unidade de coordenação.

Responsável por:

- agrupar tasks relacionadas
- expor grafo operacional do trabalho
- calcular estado agregado
- responder `o que está ready`, `o que está rodando`, `o que está travado`

### Workflow Node

No `v0`, node é só uma task membro do workflow.

Ou seja:

- `node.kind = task`
- `node.task_id` aponta para uma task real já existente

No futuro, o conceito pode abrir para:

- `approval`
- `gate`
- `automation`

Mas não agora.

### Workflow Edge

No `v0`, edge é derivada, não autoritativa.

Uma edge existe quando:

- `task_b` depende de `task_a`
- e ambas pertencem ao mesmo workflow

Então:

- `task_a -> task_b`

é uma edge do workflow.

O substrate autoritativo continua sendo `task_dependencies`.

## Entidades do v0

### `workflows`

Campos mínimos:

- `id`
- `title`
- `summary`
- `status`
- `created_at`
- `updated_at`
- `archived_at`
- `created_by`
- `created_by_agent_id`
- `created_by_session_name`

`status` agregado sugerido:

- `draft`
- `ready`
- `running`
- `blocked`
- `done`
- `failed`
- `archived`

### `workflow_tasks`

Membership explícita entre workflow e task.

Campos mínimos:

- `workflow_id`
- `task_id`
- `node_key`
- `label`
- `created_at`

Restrições:

- `UNIQUE(workflow_id, task_id)`
- `UNIQUE(task_id)`
- `UNIQUE(workflow_id, node_key)` quando `node_key` existir

Observação:

- `node_key` é identidade estável de coordenação
- `task_id` é identidade de execução
- no `v0`, uma task pertence a no máximo um workflow

Isso permite evoluir depois para `workflow node spec` sem reusar `parentTaskId`.

## Read Model

O `workflow show/watch` deve resolver:

- membros
- membros não-arquivados que entram no agregado
- histórico de membros arquivados/removidos
- edges derivadas
- tasks ready/waiting
- tasks running
- tasks blocked/failed
- tasks done
- launch plans armados
- blockers externos

### Blocker Externo

Se uma task do workflow depende de task fora do workflow:

- a dependency continua válida
- o workflow não inventa edge interna
- a surface marca isso como `external prerequisite`

Isso evita impedir membership e evita duplicação de substrate.

## Invariantes

### Separação de Camadas

- `workflow` coordena
- `task` executa
- `profile` continua pinado na task
- `project`, `goal` e `ravimem` ficam fora do `v0`

### Cardinalidade

No `v0`, uma task pertence a no máximo um workflow.

Isso evita:

- coordenação duplicada
- leitura agregada ambígua
- múltiplos owners de scheduling para a mesma execução

### `parentTaskId`

`parentTaskId` continua servindo apenas para:

- lineage
- grouping
- UI
- callback de child terminal

Nunca para:

- readiness
- edge
- workflow scheduling

### `profile`

`workflow` não carrega `profile snapshot`.

Cada task continua pinando:

- `profile_id`
- `profile_version`
- `profile_snapshot_json`
- `profile_state_json`
- `profile_input_json`

O workflow, no máximo, pode sugerir qual profile um node costuma usar em fases futuras.

### `launch plan`

`launch plan` continua sendo contrato da task.

O workflow observa:

- se o node tem launch plan
- se o node ready auto-despachou

Mas não move esse dado de lugar no `v0`.

## Agregação de Status

No `v0`, o agregado é calculado só sobre tasks membro **não-arquivadas**.

Tasks arquivadas:

- saem do agregado
- continuam no histórico do workflow
- não contam para `ready`, `blocked`, `running`, `done` ou `failed`

Proposta simples e honesta:

- `failed` se qualquer task membro não-arquivada falhar
- `blocked` se nenhuma task membro não-arquivada estiver rodando e existir task membro não-arquivada blocked
- `running` se existir task membro não-arquivada em `dispatched` ou `in_progress`
- `ready` se existir task membro não-arquivada em `open` com `readiness=ready`
- `done` se todas as tasks membro não-arquivadas estiverem `done`
- `draft` se o workflow não tiver nenhum membro não-arquivado
- `archived` se o workflow estiver arquivado

Observação:

- `waiting` continua sendo semântica da task, não status persistido do workflow

## CLI Mínima

### Criação e leitura

```bash
ravi workflows create "..." [--summary "..."]
ravi workflows list
ravi workflows show <workflow-id>
ravi workflows watch <workflow-id>
```

### Membership

```bash
ravi workflows add-task <workflow-id> <task-id> [--key <node-key>] [--label "..."]
ravi workflows rm-task <workflow-id> <task-id>
```

Semântica explícita:

- `add-task` cria só membership
- `rm-task` remove só membership
- nenhum dos dois toca em:
  - `task_dependencies`
  - `launch plan`
  - `parentTaskId`

Se uma edge interna sumir porque um membro foi removido, ela passa a aparecer como `external prerequisite` para os membros restantes.

### Operação leve

```bash
ravi workflows archive <workflow-id>
ravi workflows unarchive <workflow-id>
```

Nada de `dispatch` de workflow no `v0`.

Dispatch continua no nível da task.

## Schema Inicial

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  created_by TEXT,
  created_by_agent_id TEXT,
  created_by_session_name TEXT
);

CREATE TABLE workflow_tasks (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  node_key TEXT,
  label TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, task_id)
);

CREATE UNIQUE INDEX idx_workflow_tasks_task_unique
  ON workflow_tasks(task_id);

CREATE UNIQUE INDEX idx_workflow_tasks_node_key
  ON workflow_tasks(workflow_id, node_key)
  WHERE node_key IS NOT NULL;
```

Importante:

- não criar `workflow_edges` no banco no `v0`
- edges são projeção derivada de `task_dependencies`

Isso mantém uma única fonte de verdade para gating.

## Show Surface

`ravi workflows show` deve responder:

- dados do workflow
- status agregado
- summary
- membros
- por membro:
  - `task.status`
  - `task.readiness`
  - `launch plan`
  - upstreams internas
  - upstreams externas
  - downstreams internas

Em frase curta:

- `workflow` lê o grafo
- `task` continua rodando o trabalho

## Migração

### Estado Atual

Hoje temos:

- tasks reais
- dependencies v1 reais
- readiness real
- launch plan real
- `parentTaskId` usado como lineage/grouping
- `umbrella` usada informalmente como capa

### Passo 1

Introduzir `workflow` como substrate separado.

Sem migrar nada automaticamente.

### Passo 2

Permitir importar tasks existentes:

```bash
ravi workflows add-task wf-1 task-a
ravi workflows add-task wf-1 task-b
```

### Passo 3

Surface nova passa a mostrar coordenação pelo workflow.

Umbrella continua existindo só como legado de lineage.

### Passo 4

Novos fluxos deixam de criar umbrella quando a intenção é coordenação.

## Primeiro Corte Implementável

O corte implementável sem conflito é:

1. adicionar `workflows` + `workflow_tasks`
2. criar serviço de leitura agregada do workflow
3. derivar edges internas a partir de `task_dependencies`
4. criar CLI `workflows create|list|show|watch|add-task|rm-task`
5. não mexer em:
   - lifecycle da task
   - profile
   - dispatch
   - launch plan
   - dependencies v1
   - parentTaskId

Esse corte já entrega:

- objeto canônico de coordenação
- leitura honesta do trabalho
- base limpa para `project` depois

Sem abrir duas ontologias de scheduling.

## Fase Seguinte

Depois do `v0`, a evolução natural é:

- `project` como alignment/contexto
- workflow workspace no overlay
- node specs/templating
- instanciação lazy de tasks
- launch rules mais ricas

Mas só depois do workflow existir como camada explícita e estreita.
