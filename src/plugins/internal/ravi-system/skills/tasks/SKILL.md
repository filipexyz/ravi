---
name: tasks
description: |
  Gerencia o task runtime profile-aware do Ravi. Use quando precisar:
  - Criar, listar ou inspecionar tasks
  - Escolher e operar profiles do catálogo
  - Despachar trabalho para um agent
  - Sincronizar progresso, blocker ou conclusão no runtime
  - Entender como funciona o fluxo task -> profile -> artifacts -> CLI -> DB/NATS
---

# Tasks

O `task runtime` é o control plane operacional do Ravi.

## Modelo Mental

- `task` = instância operacional rastreável
- `profile` = contrato do processo
- `catálogo` = lista de profiles disponíveis
- `artifact` = corpo real do trabalho
- `session` = contexto de execução
- sessões de trabalho de task são efêmeras por padrão, com retenção configurável

Em frase curta:

- catálogo responde `quais profiles posso usar?`
- profile responde `como esse processo funciona?`

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `TASK_NOT_FOUND`). O envelope traz `suggestions` com tasks reais parecidas — consulte antes de concluir "não existe".
- `2` erro de uso (flag/argumento inválido). O envelope traz `acceptedFlags`: corrija a chamada, não insista na mesma sintaxe.
- `3` freio de escrita — não é erro. Nada foi gravado; o envelope traz `dryRun:true` e `plan` com exatamente o que seria feito. Revise o plano e repita com `--execute`.

Onde o freio existe hoje: `tasks dispatch`, `tasks deps rm` e `tasks automations rm` são dry-run por default e exigem `--execute`. Todas as demais escritas gravam na hora, sem dry-run: `create`, `done`, `block`, `fail`, `comment`, `archive`, `unarchive`, `report`, `deps add`, `automations add|enable|disable`, `profiles init`. Nessas o freio é você: confira o alvo antes de rodar.

Compact mode: `tasks list` aceita `--fields a,b,c` (ex.: `--fields id,title,status`) — use em varredura para não arrastar o objeto inteiro de cada task.

Help por operação: `ravi tasks <op> --help` (idem nos grupos `deps`, `automations`, `profiles`) é enxuto; prefira-o ao help do domínio inteiro.

Checklist antes de responder sobre tasks:

- Tratei exit 3 como freio (revisei o `plan`) e não como falha?
- Consultei `suggestions` do envelope antes de declarar not-found?

## Separação Certa

- `task`: lifecycle, assignments, comments, archive, watch, notify
- `profile`: workspace bootstrap, artifacts, templates, inputs, state, runtime defaults, policies
- `agent`: `cwd`, provider, permissões, sessão
- `worktree`: contexto extra, nunca override de `cwd`
- `DB/NATS`: fonte autoritativa do estado

`TASK.md` não define task. É só um artifact possível.

## Invariantes

- profile inexistente falha cedo em `create|dispatch`
- template/artifact quebrado falha cedo antes de side effects
- `show/watch` são side-effect free
- task antiga não muda quando o catálogo evolui
- `cwd` vem do agent
- `worktree` é metadata/contexto
- `TASK.md` só deve existir quando o próprio contrato pede isso

## Catálogo

Sources:

- `system`
- `plugin`
- `workspace`
- `user`

Cada task nova pina:

- `profile_id`
- `profile_version`
- `profile_source`
- `profile_snapshot_json`
- `profile_state_json`
- `profile_input_json`

Resumo:

- catálogo vive em arquivo
- snapshot/state/input vivem no banco por task
- `runtimeDefaults` do profile fica pinado no snapshot

## Runtime de Modelo

Profiles podem declarar `runtimeDefaults: { model?, effort?, thinking? }`.

`effort` usa a escala canônica do Ravi: `low|medium|high|xhigh`. O default é `xhigh`; qualquer valor inválido cai para esse default.

`ravi tasks create` e `ravi tasks dispatch` aceitam overrides explícitos:

```bash
ravi tasks create "..." --profile <id> --model <model> --effort <level> --thinking <mode>
ravi tasks dispatch <task-id> --agent <agent> --model <model> --effort <level> --thinking <mode> --execute
```

`dispatch` sem `--execute` é dry-run (exit 3): mostra o `plan` e não despacha nada.

Precedência por campo:

1. override do dispatch ou launch plan
2. override da task
3. `profile.runtimeDefaults`
4. `session.modelOverride` / `session.thinkingLevel` de sessão humana existente
5. `agent.model`
6. config global
7. `effort` default do runtime: `xhigh`

Não use `ravi sessions set-model` como mecanismo interno de task. O runtime resolve model/effort/thinking no turno ligado à task por `taskBarrierTaskId`, sem mutar a sessão.

## Retenção de Sessões

Sessões de trabalho criadas ou retomadas por tasks recebem TTL efêmero automaticamente.
O default é `1d`; depois disso o runner de sessões efêmeras apaga a sessão se ela
não tiver sido mantida/estendida.

Configuração:

```bash
ravi settings get tasks.sessionTtl
ravi settings set tasks.sessionTtl 1d
ravi settings set tasks.sessionTtl 12h
ravi settings set tasks.sessionTtl off
ravi settings get tasks.sessionTtl.knowledgeEngineer
ravi settings set tasks.sessionTtl.knowledgeEngineer 5m
```

`off`, `false`, `disabled`, `none` ou `0` desativam o TTL automático para novas
materializações/retomadas de sessão de task. Para continuar uma task cuja sessão
foi apagada, despache/comente a task de novo para criar uma nova sessão.

Sessões de task de agents `knowledge-engineer-*` usam `tasks.sessionTtl.knowledgeEngineer`
e default `5m`, inclusive ao completar turnos em sessões `task-*-work`, para evitar acúmulo
de sessões runtime de pesquisa em lote.

## Built-ins Atuais

- `default`
  - workspace = task workspace
  - artifact primário = `TASK.md`
- `observed-task`
  - workspace = task workspace
  - artifact primário = `TASK.md`
  - protocolo = worker executa e deixa sinais claros; observer faz `report|block|done|fail`
  - use com uma observer rule `scope=profile --source-profile observed-task --profile tasks --mode report`
- `devin`
  - workspace = task workspace
  - artifact primário = `TASK.md`
  - protocolo = delegar via `ravi devin sessions create|show|messages|insights|send|sync` (`create` e `send` são dry-run por default — adicione `--execute` na execução real)
  - use `ravi devin sessions insights <session> --json` para enxergar status rico/contagens/análise remota quando a API disponibilizar
  - use `ravi devin sessions sync <session> --insights --artifacts --json` para registrar estado remoto com artifact
  - uso = externalizar investigação/implementação longa mantendo o Ravi como dono da task

Profiles de domínio (`brainstorm`, `content`, vídeo, runtime-only etc.) não são built-ins do sistema. Eles devem entrar como `plugin`, `workspace` ou `user`.

## Wrapper Canônico

Para mutações importantes, prefira o wrapper do repo fonte:

```bash
<ravi.bot repo>/bin/ravi
```

Se houver split entre wrapper e runtime vivo, trate como fronteira suspeita.

## Comandos de Catálogo

```bash
ravi tasks profiles list
ravi tasks profiles show <profile-id>
ravi tasks profiles preview <profile-id> --title "..." [--input k=v]
ravi tasks profiles validate [profile-id]
ravi tasks profiles init <profile-id> --preset <doc-first|brainstorm|runtime-only|content>
```

`--preset` serve para scaffold. O runtime real é declarativo.

## Inputs do Profile

Profiles podem declarar `inputs` estruturados no `profile.json`. Esses valores são
o contrato de briefing do profile e são passados no create com `--input key=value`:

```bash
ravi tasks create "Título" --profile <id> \
  --instructions "Resumo livre para o worker" \
  --input goal_statement="Outcome final" \
  --input acceptance_criteria="Como validar done"
```

Regras importantes:

- `--instructions` é texto livre da task; ele não popula `inputs`.
- `--input` pode ser repetido e fica pinado em `profile_input_json` da task.
- Templates acessam inputs com `{{input.key}}`.
- Inputs `required: true` bloqueiam `create|preview|dispatch` quando vazios.
- Inputs opcionais declarados existem como string vazia quando não enviados, então `{{input.optional_key}}` é seguro.
- Placeholder `{{input.algum_key}}` só deve apontar para um input declarado ou explicitamente passado; placeholders desconhecidos continuam falhando cedo.

## Templates do Profile

Profiles controlam as surfaces humanas da task via `templates`.

Templates atuais:

- `create`: renderiza o output de `ravi tasks create`
- `dispatch`: prompt enviado para a sessão trabalhadora
- `resume`: prompt de retomada após restart
- `dispatchSummary` e `dispatchEventMessage`: resumos de dispatch
- `reportDoneMessage`, `reportBlockedMessage`, `reportFailedMessage`: mensagens de sync terminal

Para profiles externos (`plugin`, `workspace`, `user`), templates podem ser inline ou arquivo:

```json
{
  "templates": {
    "create": { "path": "./create.md" },
    "dispatch": { "path": "./dispatch.md" }
  }
}
```

`create` deve ser uma surface única, normalmente `create.md`. Use esse template para forçar briefing eficiente antes do dispatch: objetivo, contexto, escopo dentro/fora, critérios de aceite, dependências/riscos, validação e handoff.

Scaffolds novos devem nascer em Markdown:

```text
create.md
dispatch.md
resume.md
dispatch-summary.md
dispatch-event.md
report-done.md
report-blocked.md
report-failed.md
```

O loader aceita paths legados como `.txt`, mas não crie scaffold novo em `.txt`.

## Fluxo Canônico

```text
ravi tasks create --profile <id>
-> resolve profile no catálogo
-> valida inputs/templates/artifacts
-> task nasce com snapshot + state + input pinados
-> bootstrap do workspace
-> renderiza templates.create para orientar briefing/readiness/next steps
-> ravi tasks dispatch
-> prompt/resumo/evento vêm do profile
-> runtime model/effort/thinking vem da task/profile/dispatch quando definido
-> agent trabalha no artifact certo
-> sync de status vem do contrato do profile:
   - `default`: worker chama `ravi tasks report|block|done|fail`
   - `observed-task`: observer chama `ravi tasks report|block|done|fail`
-> show/watch expõem profile + workspace + artifacts
```

## Como um Agent Deve Proceder

1. ler o `profile` efetivo
2. ler o `artifact` primário surfaced pelo runtime
3. seguir o protocolo do dispatch/resume
4. sincronizar estado via `ravi tasks ...` somente quando o profile mandar isso

Turnos sem `taskBarrierTaskId` não devem receber `RAVI_TASK_*`; isso evita vazar contexto de task para conversas fora da task.

### `default`

- trabalhar em `TASK.md`
- manter frontmatter/corpo coerentes
- sincronizar via `report|block|done|fail`

### `observed-task`

- trabalhar em `TASK.md`
- não chamar `ravi tasks report|block|done|fail` por padrão
- declarar progresso, blockers, conclusão e falhas claramente na resposta normal
- deixar o observer profile `tasks` transformar esses sinais em status durável

Para profiles customizados, siga o contrato pinado no snapshot da task. Não assuma que um preset de scaffold é built-in disponível no catálogo system.

## Skill Certa

Use esta skill como surface canônica do runtime de tasks.

Não use `ravi-system-tasks-manager` para trabalho profile-aware. Aquela surface é o legado doc-first acoplado ao core.

## Linguagem da Surface

A linguagem certa para humanos é:

- qual profile
- qual workspace
- quais artifacts
- qual protocolo de sync
