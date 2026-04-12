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

Em frase curta:

- catálogo responde `quais profiles posso usar?`
- profile responde `como esse processo funciona?`

## Separação Certa

- `task`: lifecycle, assignments, comments, archive, watch, notify
- `profile`: workspace bootstrap, artifacts, templates, inputs, state, policies
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

## Built-ins Atuais

- `default`
  - workspace = task workspace
  - artifact primário = `TASK.md`
- `brainstorm`
  - workspace = `.genie/brainstorms/<slug>`
  - artifact primário = `DRAFT.md`
  - supporting = `DESIGN.md`, `JAR`
- `content`
  - workspace = `task_dir` cru
  - artifact primário inicial = `draft.md`
- `video-rapha`
  - worktree contextual = `~/ravi/videomaker`
  - projeto = `out/<video_id>/`
  - runner = `wf eb <video_id>`
  - artifact primário ativo = `.wf-eb-state.json`
  - artifact terminal = `render/video.mp4`
- `video-rapha-scene`
  - worktree contextual = `~/ravi/videomaker`
  - projeto = `out/<video_id>/`
  - escopo = uma cena só
  - artifacts = `sceneN-manifest`, `sceneN-props`, `sceneN.png`
  - não toca no `.wf-eb-state.json`
- `task-doc-optional`
  - `TASK.md` opcional
- `task-doc-none`
  - runtime-only, sem `TASK.md`

## Wrapper Canônico

Para mutações importantes, prefira o wrapper do repo fonte:

```bash
/Users/luis/dev/filipelabs/ravi.bot/bin/ravi
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

## Fluxo Canônico

```text
ravi tasks create --profile <id>
-> resolve profile no catálogo
-> valida inputs/templates/artifacts
-> task nasce com snapshot + state + input pinados
-> bootstrap do workspace
-> ravi tasks dispatch
-> prompt/resumo/evento vêm do profile
-> agent trabalha no artifact certo
-> ravi tasks report|block|done|fail
-> show/watch expõem profile + workspace + artifacts
```

## Como um Agent Deve Proceder

1. ler o `profile` efetivo
2. ler o `artifact` primário surfaced pelo runtime
3. seguir o protocolo do dispatch/resume
4. sincronizar estado via `ravi tasks ...`

### `default`

- trabalhar em `TASK.md`
- manter frontmatter/corpo coerentes
- sincronizar via `report|block|done|fail`

### `brainstorm`

- trabalhar em `DRAFT.md`
- tratar `DESIGN.md` e `JAR` como artifacts do processo

### `content`

- tratar `task_dir` como workspace canônico
- começar pelo artifact primário inicial
- materializar `notes.md`, `sources/`, `assets/`, `exports/` só quando precisar

### `video-rapha`

- usar o worktree contextual do `videomaker`
- tratar `out/<video_id>/` como projeto canônico
- rodar `wf eb <video_id>`
- ler `.wf-eb-state.json` como artifact primário ativo
- tratar checkpoints F2/F4/F5 como `in_progress`, não `blocked`

### `video-rapha-scene`

- tratar `out/<video_id>/` como projeto compartilhado
- trabalhar só na cena atribuída
- produzir `assets/sceneN-manifest.json`, `props/sceneN-props.json`, `stills/sceneN.png`
- não rodar `wf eb <video_id> --next`
- não tocar em `.wf-eb-state.json`

## Skill Certa

Use esta skill como surface canônica do runtime de tasks.

Não use `ravi-system-tasks-manager` para trabalho profile-aware. Aquela surface é o legado doc-first acoplado ao core.

## Linguagem da Surface

A linguagem certa para humanos é:

- qual profile
- qual workspace
- quais artifacts
- qual protocolo de sync
