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

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `PROJECT_NOT_FOUND`, `WORKFLOW_RUN_NOT_FOUND`, `WORKFLOW_NODE_NOT_FOUND`, `TASK_NOT_FOUND`, `RESOURCE_NOT_FOUND`). O envelope traz `suggestions` com slugs/títulos reais parecidos — consulte antes de concluir "não existe".
- `2` erro de uso (flag/argumento inválido). O envelope traz `acceptedFlags`: corrija a chamada, não insista na mesma sintaxe.
- `3` freio de escrita — não é erro. Nada foi gravado; o envelope traz `dryRun:true` e `plan` com exatamente o que seria feito. Revise o plano e repita com `--execute`.

Onde o freio existe hoje: `projects tasks dispatch` e `projects workflows start` (disparam execução real de agente/workflow) e `projects fixtures seed` (reseta e resemeia as fixtures — destrutivo) são dry-run por default e exigem `--execute`. As demais escritas, inclusive `projects resources import`, gravam na hora sem dry-run: `init`, `create`, `update`, `link`, `workflows attach`, `tasks create`, `tasks attach`, `resources add`, `resources import`. Nessas o freio é você: confira o alvo antes de rodar.

Compact mode: `projects list`, `projects next` e `projects resources list` aceitam `--fields a,b,c` (ex.: `--fields slug,status`) — use em varredura para não arrastar o objeto inteiro de cada project.

`projects next` retorna 20 entradas por padrão. Continue por
`pagination.nextCommand` ou ajuste `--limit` e `--offset`; não presuma que a
primeira página representa todos os projetos.

Leituras ambíguas falham com `AMBIGUOUS_PROJECT_REF` ou
`AMBIGUOUS_RESOURCE_REF`. Use o id canônico indicado nos candidatos; nunca
escolha o primeiro resultado por conta própria.

Help por operação: `ravi projects <op> --help` (idem nos grupos `workflows`, `tasks`, `resources`, `fixtures`) é enxuto; prefira-o ao help do domínio inteiro.

Checklist antes de responder sobre projects:

- Tratei exit 3 como freio (revisei o `plan`) e não como falha?
- Consultei `suggestions` do envelope antes de declarar not-found?

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
<ravi.bot repo>/bin/ravi
```

Se `bin/ravi` não expõe `projects`, o bundle `dist` provavelmente está stale. Confirme no source e rode build antes de concluir:

```bash
cd <ravi.bot repo>
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
  --resource worktree:<ravi.bot repo> \
  --workflow-template technical-change
```

`init` pode criar o project, linkar resources/sessions/agents e instanciar até 2 workflows canônicos.

## Workflows Ligados ao Project

Dia-2: iniciar um workflow run a partir do project (freado: sem `--execute` é dry-run, exit 3):

```bash
ravi projects workflows start ravi-projects-system wf-spec-canonical-technical-change-v1 --role primary --execute
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

Despachar usando defaults do project (freado: sem `--execute` é dry-run, exit 3):

```bash
ravi projects tasks dispatch ravi-projects-system task-abc123 --execute
```

O comando deve herdar `owner_agent_id` e `operator_session_name` do project quando não houver override.

## Resources

Adicionar um resource:

```bash
ravi projects resources add ravi-projects-system <ravi.bot repo> --type worktree --role source
```

Importar vários (escrita imediata; revise todos os locators antes de executar):

```bash
ravi projects resources import ravi-projects-system \
  --worktree <ravi.bot repo> \
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

Seedar fixtures canônicas (freado e destrutivo: reseta as fixtures; sem `--execute` é dry-run, exit 3):

```bash
ravi projects fixtures seed --execute
ravi projects fixtures seed --owner-agent dev --execute
```

Use fixtures para validar o caminho:

```text
project -> workflow run -> node run -> task
```

## Fluxo Recomendado

1. `projects init` para criar o namespace/contexto.
2. `projects resources import` para anexar substrato útil; a gravação é imediata.
3. `projects workflows start --execute` para iniciar a trilha coordenada (sem `--execute` só mostra o plano).
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
