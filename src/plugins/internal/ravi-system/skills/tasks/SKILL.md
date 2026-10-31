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

> Verbos: AGIR (trabalho longo) · REAGIR (`ravi.task.*.event`). Compõe com: bases (fila).
> Solução com mais de uma peça? `ravi skills show solucoes` primeiro.

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

## Decisões

Use uma decisão para registrar uma pergunta pendente com chave e dono na task.
`blocked` registra um impedimento; a decisão guarda a pergunta e o histórico da resposta.

```bash
# Registrar a pergunta; --blocks marca espera por esta decisão
ravi tasks decide <task-id> --key janela --ask "Qual janela de execução?" --owner "human:<contact-id>" --blocks --json

# Consultar pendências (mais antigas primeiro) e o histórico de uma task
ravi tasks attention --owner human --json
ravi tasks attention --agent <agent-id> --task <task-id> --json
ravi tasks show <task-id> --json

# Após receber a decisão do dono, registrar pela sessão solicitante autorizada
ravi tasks answer <task-id> --key janela --text "Após 18h" --json
```

`decide` e `answer` gravam imediatamente, sem `--execute`. `attention` e `show` só leem.

- `--owner` aceita `human:<contact-id>`, `agent:<agent-id>` ou `unassigned` (default).
  Em `attention`, `--owner` filtra o **tipo**; `--agent` filtra o agent atribuído à task.
- `--key` é normalizada para minúsculas: até 64 caracteres de `a-z`, `0-9`, `.`, `_`, `-`,
  começando por letra ou número. Só existe uma decisão aberta por chave na mesma task.
- Repetir `decide` numa chave aberta atualiza pergunta, dono e `blocks`, preservando id,
  autor e data originais. Repasse `--owner` e `--blocks` para mantê-los; omiti-los usa os defaults.
  Após uma resposta, um novo `decide` com a mesma chave cria outro registro, sem alterar o anterior.
- `parked` é derivado: decisão `open` + `blocks` + dono `human`, em task não terminal
  e não arquivada. Não é um status nem uma pausa do worker. `attention` exclui tasks
  arquivadas; decisões abertas de tasks `done|failed` podem aparecer, mas sem `parked`.
- `waitingFor` prioriza `human`, depois `agent`, depois `unassigned` nas decisões abertas
  do recorte. `attention` não detecta stalls nem substitui a lista de tasks bloqueadas.
- Cada mutação emite `task.decision.open` ou `task.decision.answered`, aceitos por
  `tasks automations add --on`. Sem automação configurada, não há aviso ao dono nem retomada
  do worker. Status da task, threads, followups e checkpoints continuam independentes;
  o observer não abre nem responde decisões.

Armadilhas:

- O worker não responde a própria decisão: a sessão da assignment ativa recebe
  `TASK_DECISION_SELF_ANSWER` (exit 1). `--by` registra proveniência, não dá autoridade
  nem contorna essa proteção. Não invente uma resposta pelo dono.
- `answer` em chave já fechada falha com `TASK_DECISION_NOT_OPEN` (exit 1): a resposta
  é imutável. Chave nunca criada dá `TASK_DECISION_NOT_FOUND` (exit 1).
  Chave/dono inválidos ou pergunta/resposta vazia são erros de uso (exit 2).

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
  - `TASK.md` = briefing da task
  - protocolo = o worker só trabalha e diz claramente o que avançou, o que bloqueia e quando terminou; o observer embutido da task decide o status e o runtime aplica
- `observed-task`
  - alias de `default`, mantido para tasks e scripts que já usam esse id

## Observer Embutido

Toda task cujo profile tem `observer.enabled: true` (os dois built-ins, e os presets de `ravi tasks profiles init`) ganha uma sessão observer própria, sem regra cadastrada:

- lê o worker no fim de cada turno e a cada 5 min durante um turno longo: prompt, resposta inteira, uma linha por tool
- roda com o agent do worker num modelo leve (`haiku` no Claude, mini/spark no Codex), ou `observer.model` do profile
- não tem tools nem grants de task (grant `none`): responde um bloco `<task-verdict>` e o runtime aplica `progress|blocked|done|failed`
- monta um checklist a partir das instruções e mostra em `ravi tasks show <id>` (seção `Task observer`, campo `observer` no `--json`)
- quando o worker para sem terminar, manda **um** empurrão dizendo o que falta; se parar de novo, registra `task.stalled` e avisa quem pediu (filtro `blocked` do `--report-events`)
- o worker não recebe checkpoint overdue; 30 min sem nada visto vira `task.stalled` para quem pediu

`ravi tasks report|block|done|fail` continuam valendo para o operador corrigir o status à mão. Profiles customizados sem o campo `observer` mantêm o protocolo antigo (worker reporta, checkpoint lembra).
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
o contrato de briefing do profile e são passados no create com `--input key=value`.
Os nomes dependem do profile: leia `inputs` (com `required`) antes de criar.

```bash
ravi tasks profiles show <id> --json
ravi tasks create "Título" --profile <id> \
  --instructions "Resumo livre para o worker" \
  --input <key>="valor"
```

Regras importantes:

- `--instructions` é texto livre da task; ele não popula `inputs`.
- `--input` pode ser repetido e fica pinado em `profile_input_json` da task.
- Templates acessam inputs com `{{input.key}}`.
- Inputs `required: true` bloqueiam `create|preview|dispatch` quando vazios: o comando sai com código 2 (`USAGE_ERROR`) e a mensagem `Missing required input(s) for task profile <id>: ...` lista os que faltam.
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
   - `observer.enabled` (`default`, `observed-task`): o observer embutido lê o worker e o runtime aplica o veredito
   - profile sem `observer`: worker chama `ravi tasks report|block|done|fail`
-> show/watch expõem profile + workspace + artifacts
```

## Como um Agent Deve Proceder

1. ler o `profile` efetivo
2. ler o `artifact` primário surfaced pelo runtime
3. seguir o protocolo do dispatch/resume
4. sincronizar estado via `ravi tasks ...` somente quando o profile mandar isso

Turnos sem `taskBarrierTaskId` não devem receber `RAVI_TASK_*`; isso evita vazar contexto de task para conversas fora da task.

### `default` e `observed-task` (observer embutido)

- ler o briefing em `TASK.md`
- não chamar `ravi tasks report|block|done|fail`
- dizer claramente na resposta normal o que avançou, o que bloqueia e quando terminou, com como validou

### Profile sem `observer`

- trabalhar no artifact do profile
- sincronizar via `report|block|done|fail`

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
