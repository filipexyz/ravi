---
name: projects
description: |
  Opera Projects no Ravi como camada de alignment/contexto. Use quando precisar:
  - Criar, listar, mostrar ou atualizar projects
  - Iniciar/anexar workflow runs a um project
  - Criar/anexar/despachar tasks a partir de project + workflow node
  - Gerenciar resources/links baratos de project
  - Seedar fixtures canônicas de project -> workflow -> task
---

# Projects

`project` é a camada de alignment/contexto do Ravi.

Regra de fronteira:

- `project` organiza
- `workflow` coordena
- `task` executa
- `profile` define o protocolo local da task

Não use `project` como scheduler, task umbrella, PM tool genérica ou ownership direto de task.

## Invariantes

- O vínculo forte inicial é `workflow -> project`.
- Tasks aparecem no project por inferência via workflow/node run.
- Não grave nem espere `project_id` direto em `tasks`.
- `project` não calcula readiness e não dispara trabalho sozinho.
- `launch plan` continua na task.
- `parentTaskId` continua só lineage/grouping/UI/callback.
- Não puxe `goal` ou `ravimem` para esta surface.

## Wrapper Canônico

Para mutações importantes, prefira:

```bash
/Users/luis/dev/filipelabs/ravi.bot/bin/ravi
```

Se `bin/ravi` não expõe `projects`, o bundle `dist` provavelmente está stale. Confirme no source e rode build antes de concluir:

```bash
cd /Users/luis/dev/filipelabs/ravi.bot
bun run build
./bin/ravi projects --help
```

Não reinicie o daemon principal nem faça commit sem autorização do Luís.

## Project CRUD

Criar project simples:

```bash
ravi projects create "Ravi Projects System" \
  --slug ravi-projects-system \
  --summary "Camada de alignment/contexto para Projects" \
  --hypothesis "Project organiza workflows, resources e sessions sem virar scheduler" \
  --next-step "Validar golden path project -> workflow -> task" \
  --owner-agent dev \
  --session dev
```

Listar e ler:

```bash
ravi projects list
ravi projects show ravi-projects-system
ravi projects status ravi-projects-system
ravi projects next
```

Atualizar leitura humana:

```bash
ravi projects update ravi-projects-system \
  --summary "..." \
  --hypothesis "..." \
  --next-step "..." \
  --touch-signal
```

Campos humanos importantes:

- `summary`
- `hypothesis`
- `next_step`
- `last_signal_at`
- `owner_agent_id`
- `operator_session_name`

## Init / Bootstrap

Use `projects init` para nascer com contexto útil:

```bash
ravi projects init "Ravi Projects System" \
  --slug ravi-projects-system \
  --summary "..." \
  --hypothesis "..." \
  --next-step "..." \
  --owner-agent dev \
  --session dev \
  --resource worktree:/Users/luis/dev/filipelabs/ravi.bot \
  --workflow-template technical-change
```

`init` pode criar o project, linkar resources/sessions/agents e instanciar até 2 workflows canônicos.

## Workflows Ligados ao Project

Dia-2: iniciar um workflow run a partir do project:

```bash
ravi projects workflows start ravi-projects-system wf-spec-canonical-technical-change-v1 --role primary
```

Anexar run existente:

```bash
ravi projects workflows attach ravi-projects-system wf-run-abc123 --role support
```

Roles:

- `primary` = trilha/foco operacional principal
- `support` = trilha auxiliar

O project pode expor `focusedWorkflow*` para mostrar qual run está em foco, mas o workflow continua sendo quem coordena.

## Tasks a Partir de Project + Workflow Node

Criar task no node certo:

```bash
ravi projects tasks create ravi-projects-system review "Review do corte Projects" \
  --workflow wf-run-abc123 \
  --instructions "Revisar contrato project -> workflow -> task" \
  --dispatch
```

Anexar task existente ao node:

```bash
ravi projects tasks attach ravi-projects-system review task-abc123 --workflow wf-run-abc123 --dispatch
```

Despachar usando defaults do project:

```bash
ravi projects tasks dispatch ravi-projects-system task-abc123
```

O comando deve herdar `owner_agent_id` e `operator_session_name` do project quando não houver override.

## Resources

Adicionar um resource:

```bash
ravi projects resources add ravi-projects-system /Users/luis/dev/filipelabs/ravi.bot --type worktree --role source
```

Importar vários:

```bash
ravi projects resources import ravi-projects-system \
  --worktree /Users/luis/dev/filipelabs/ravi.bot \
  --url https://example.com/spec \
  --group 120363424772797713@g.us
```

Listar e mostrar:

```bash
ravi projects resources list ravi-projects-system
ravi projects resources show ravi-projects-system <resource-id-or-locator>
```

Tipos iniciais:

- `repo`
- `worktree`
- `file`
- `url`
- `group`
- `contact`
- `notion_page`
- `notion_database`

## Links Baratos

Link genérico:

```bash
ravi projects link workflow ravi-projects-system wf-run-abc123 --role primary
ravi projects link session ravi-projects-system dev --role operator
ravi projects link agent ravi-projects-system dev --role owner
ravi projects link resource ravi-projects-system /path/to/repo --resource-type worktree --role source
```

Links são baratos e polimórficos. Não duplique ownership em tabelas de task.

## Fixtures

Seedar fixtures canônicas:

```bash
ravi projects fixtures seed
ravi projects fixtures seed --owner-agent dev
```

Use fixtures para validar o caminho:

```text
project -> workflow run -> node run -> task
```

## Fluxo Recomendado

1. `projects init` para criar o namespace/contexto.
2. `projects resources import` para anexar substrato útil.
3. `projects workflows start` para iniciar a trilha coordenada.
4. `projects tasks create|attach --dispatch` para abrir trabalho concreto no node.
5. `projects status` ou `projects next` para decidir o próximo movimento.
6. `tasks show/list/watch` para acompanhar execução concreta.

## Sinais de Uso Errado

Pare e corrija se:

- estiver tentando colocar `project_id` direto em `tasks`
- o project estiver calculando readiness
- o project estiver criando task sem passar por workflow/node run
- `parentTaskId` estiver sendo usado como edge de scheduling
- `profile` estiver carregando dependência ou coordenação global
