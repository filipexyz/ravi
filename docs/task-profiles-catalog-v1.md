# Task Profiles Catalog v1

O runtime de tasks do Ravi ficou mais simples quando a separação passou a ser esta:

- `task` = instância operacional
- `profile` = contrato do processo
- `catálogo` = lista de profiles disponíveis no contexto atual
- `snapshot` = cópia congelada do profile que a task pinou na criação

Em frase curta:

- catálogo responde `quais profiles posso usar?`
- profile responde `como esse processo funciona?`

## O Que é Runtime e o Que é Catálogo

O runtime de tasks cuida só de:

- lifecycle
- assignment
- comments
- events
- archive
- show/watch

O catálogo cuida de:

- templates de dispatch/resume
- inputs obrigatórios
- workspace bootstrap
- artifacts
- state defaults
- políticas de progress/completion

O runtime não deveria adivinhar processo. Ele só resolve um contrato e o aplica.

## Shape do Profile

O contrato de um profile é declarativo. Os campos que realmente importam são:

- `id`, `version`, `label`, `description`
- `sessionNameTemplate`
- `workspaceBootstrap`
- `rendererHints`
- `defaultTags`
- `inputs`
- `completion`
- `progress`
- `artifacts`
- `state`
- `runtimeDefaults`
- `templates`

Na prática:

- `workspaceBootstrap` define onde o processo vive
- `artifacts` definem o corpo real do trabalho
- `templates` definem o protocolo de dispatch/resume
- `state` inicializa contexto persistido da task
- `runtimeDefaults` sugere `model`, `effort` e `thinking` para turnos dessa task
- `completion/progress` definem a política operacional

`TASK.md` não é conceito do sistema. É só um artifact possível.

## Sources e Precedência

O catálogo resolvido vem em cascata:

1. `system`
2. `plugin`
3. `workspace`
4. `user`

A última camada vence.

Na prática:

- `user` sobrescreve `workspace`
- `workspace` sobrescreve `plugin`
- `plugin` sobrescreve `system`

## Snapshot

Na criação, a task pina:

- `profile_id`
- `profile_version`
- `profile_source`
- `profile_snapshot_json`
- `profile_state_json`
- `profile_input_json`

Isso separa:

- definição viva do catálogo
- contrato congelado da task

Se o catálogo mudar depois, task antiga não muda por acidente.

`runtimeDefaults` fica dentro do snapshot. Assim, uma mudança posterior no profile não troca silenciosamente o modelo de tasks já criadas.

## Fluxo Canônico

### 1. Descoberta

```bash
ravi tasks profiles list
ravi tasks profiles show <profile-id>
ravi tasks profiles preview <profile-id> --title "..." [--input k=v]
ravi tasks profiles validate [profile-id]
```

Isso responde:

- quais profiles existem
- qual source venceu
- qual workspace/artifact vai nascer
- se templates e inputs estão válidos

### 2. Criação

```bash
ravi tasks create "..." --profile <id> [--input k=v] [--model <model>] [--effort <level>] [--thinking <mode>]
```

O runtime:

1. resolve o profile no catálogo
2. valida inputs, templates e artifacts
3. calcula `profile_state`
4. aplica `workspaceBootstrap`
5. persiste snapshot + state + input + override de runtime opcional

### 3. Dispatch

```bash
ravi tasks dispatch <task-id> --agent <agent> [--model <model>] [--effort <level>] [--thinking <mode>]
```

O runtime:

1. resolve `session cwd`
2. resolve `worktree` contextual
3. resolve artifacts
4. resolve runtime efetivo de model/effort/thinking
5. renderiza `dispatch`
6. publica prompt
7. registra assignment + event

### Runtime por Task

O modelo efetivo é resolvido por campo, sem mutar a sessão:

`effort` usa `low|medium|high|xhigh`. O default é `xhigh`; qualquer valor inválido cai para esse default.

1. `runtimeOverride` do dispatch ou launch plan
2. `runtimeOverride` da task
3. `profile.runtimeDefaults`
4. `session.modelOverride` / `session.thinkingLevel` de sessão humana existente
5. `agent.model`
6. modelo global do config
7. `effort` default do runtime: `xhigh`

O contexto da task vence a preferência da sessão porque dispatch/resume representam um contrato operacional explícito. A preferência da sessão continua valendo para turnos sem task e como fallback quando a task/profile não define aquele campo.

### 4. Execução

O agent:

1. lê o artifact primário surfaced pelo runtime
2. trabalha no workspace/artifacts do profile
3. sincroniza estado via `ravi tasks report|block|done|fail`

Bindings operacionais:

- `dispatch` e `resume` carregam `taskBarrierTaskId`, então o runtime consegue injetar `RAVI_TASK_ID` sem heurística
- turnos sem task explícita não recebem `RAVI_TASK_*`, mesmo que exista uma assignment ativa para a sessão
- `RAVI_TASK_WORKSPACE` segue a assignment real (`worktree`, `task_dir` ou cwd efetivo da sessão)

### 5. Leitura

```bash
ravi tasks show <task-id>
ravi tasks watch <task-id>
```

Leitura correta:

- `show/watch` são side-effect free
- eles surfam `profile + workspace + artifacts`
- eles nunca materializam `TASK.md`

## Profiles Atuais

O catálogo `system` deve expor apenas contratos universais de processo:

### `default`

Uso:

```bash
ravi tasks create "ajustar rota" --instructions "..." --profile default
```

Contrato:

- workspace = task workspace canônico
- artifact primário = `TASK.md`
- protocolo = editar `TASK.md` primeiro

### `devin`

Uso:

```bash
ravi tasks create "implementar fluxo X" --instructions "..." --profile devin
```

Contrato:

- workspace = task workspace canônico
- artifact primário = `TASK.md`
- protocolo = escrever briefing Devin-ready, criar sessão remota via `ravi devin sessions create`, monitorar com `show/messages/sync`, e sincronizar o estado da task no Ravi
- inputs padrão = `advancedMode=create`, `maxAcu=20`, `repo=github.com:filipexyz/ravi`
- boundary = Devin é executor externo; Ravi continua dono da task, provenance, artifacts e handoff

Profiles de domínio como brainstorm, research, content, vídeo e runtime-only não pertencem ao catálogo built-in. Eles devem ser instalados como `plugin`, `workspace` ou `user`, ou gerados por `ravi tasks profiles init` quando fizer sentido.

## Simplificação Arquitetural

O runtime não precisa de um conceito operacional de `driver`, e o manifesto de profile não aceita mais esse campo.

O que manda de verdade é:

- workspace
- artifacts
- templates
- inputs
- state
- policies

`preset` sobrevive só como helper de scaffold em `ravi tasks profiles init`.

Em outras palavras:

- runtime = declarativo
- scaffold = presetado

## Invariantes

- profile inexistente falha cedo
- template quebrado falha cedo
- artifact inválido falha cedo
- `show/watch` não escrevem arquivo
- `TASK.md` só existe quando o próprio contrato pede isso
- task antiga continua com o snapshot que pinou
