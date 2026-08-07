---
name: observers
description: |
  Gerencia o Observation Plane do Ravi. Use quando precisar:
  - Listar, explicar ou atualizar observer bindings
  - Criar regras de observer por global/agent/session/task/profile/tag
  - Criar, validar ou pré-visualizar observer profiles Markdown
  - Configurar task observers como `observed-task` + profile `tasks`
---

# Observers

Observers são sessões sidecar que recebem eventos canônicos de uma sessão fonte.
Eles são assíncronos e isolados: não contaminam o prompt, permissões ou runtime
da sessão observada.

## Modelo Mental

- `source session`: sessão observada.
- `observer session`: sessão Ravi comum que recebe o prompt de observação.
- `rule`: decide quando criar o observer.
- `binding`: relação durável entre source e observer.
- `profile`: decide como eventos viram Markdown para o observer.

Rules escolhem **quando** observar. Profiles escolhem **como** formatar.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `OBSERVER_NOT_FOUND` para binding/rule/profile, `SESSION_NOT_FOUND` para sessão fonte). O envelope de `OBSERVER_NOT_FOUND` traz `suggestions` com ids reais parecidos — consulte antes de concluir "não existe". `SESSION_NOT_FOUND` NÃO traz `suggestions` de propósito: o isolamento de escopo mascara sessão não-autorizada como not-found, e sugerir nomes reais vazaria sessões de outros escopos.
- `2` erro de uso (flag/argumento inválido). Corrija a chamada, não insista na mesma sintaxe.
- `3` freio de escrita — não é erro. Nada foi gravado; o envelope traz `dryRun:true` e `plan` com exatamente o que seria feito. Revise o plano e repita com `--execute`.

Onde o freio existe hoje: só `observers rules rm` (deletar rule é destrutivo — o único reverso é recriar na mão) é dry-run por default e exige `--execute`:

```bash
ravi observers rules rm <rule-id> --json            # dry-run: mostra o plan e sai com exit 3
ravi observers rules rm <rule-id> --json --execute  # apaga de verdade
```

Todas as demais escritas gravam na hora, sem dry-run: `refresh`, `rules set`, `rules enable|disable`, `profiles init`. Nessas o freio é você: confira o alvo antes de rodar (`rules set` sobrescreve a rule inteira com o mesmo id; `disable` é o reverso barato de `enable`).

Compact mode: `observers list`, `observers rules list` e `observers profiles list` aceitam `--fields a,b,c` (ex.: `--fields id,enabled`) — use em varredura para não arrastar o objeto inteiro.

Checklist antes de responder sobre observers:

- Tratei exit 3 como freio (revisei o `plan`) e não como falha?
- Consultei `suggestions` do envelope antes de declarar not-found?
- Rodei o `rm` de novo com `--execute` só depois de confirmar que a rule certa está no plano?

## Inspeção Cruzada

Observers vivem em cima do resto do CRM. Antes de criar ou debugar, inspecione o ecossistema todo:

```bash
ravi observers rules list --json                 # quais regras observam o quê
ravi observers list --json                       # bindings ativos
ravi tag-rules list --json                       # quem produz as tags que observers consomem
ravi contacts list --json                        # base sob observação
ravi chats lists list --json                     # filas de leitura (se observers usam reading lists)
```

⚠️ **Observer rule sem source matching** = dorme pra sempre. Use `ravi observers rules explain --session <session>` pra ver porque uma rule específica não disparou.

⚠️ **Observer rule por tag de contato** depende de `session_participants` ter o contato linkado. Confirme via `ravi observers rules explain` que `source.contactIds` está preenchido.

## Comandos

```bash
ravi observers list
ravi observers show <binding-id>
ravi observers refresh <session>
ravi observers refresh <session> --reconcile full-reconcile

ravi observers rules list
ravi observers rules show <rule-id>
ravi observers rules set <rule-id> <observer-agent> [--scope profile] [--source-profile observed-task] [--profile tasks] [--selector <expression>]
ravi observers rules enable <rule-id>
ravi observers rules disable <rule-id>
ravi observers rules rm <rule-id> --execute   # sem --execute é dry-run (exit 3)
ravi observers rules validate
ravi observers rules explain --session <session>

ravi observers profiles list
ravi observers profiles show <profile-id>
ravi observers profiles preview <profile-id> --event message.assistant
ravi observers profiles validate [profile-id]
ravi observers profiles init <profile-id>
```

## Selectors Genéricos

`--selector` usa um predicado restrito, sem JavaScript/eval, sobre `source.*`, `turn.*` e `event.*`. Operadores: `==`, `!=`, `startsWith`, `endsWith`, `includes`, `!`, `&&`, `||` e parênteses.

Exemplo para observar somente turnos interativos, mesmo quando um cron executa dentro da sessão `main`:

```bash
ravi observers rules set proactive-followups proactive-followup-observer \
  --scope global \
  --selector 'turn.background == "false"'
```

Selectors de `source.*` são avaliados antes de criar o binding. Selectors com `turn.*` ou `event.*` são avaliados por evento e sobrevivem corretamente a debounce. Expressões inválidas falham fechadas. Use `--selector clear` para remover.

`metadata.sourceExclusions` continua sendo lido para compatibilidade com regras antigas, mas novas regras devem preferir `--selector`.

Reconciliação é explícita: `attach-missing` (padrão), `detach-disabled`, `refresh-profile` ou `full-reconcile`. Ela desativa bindings obsoletos sem apagar o histórico.

## Profiles

Observer profiles são bundles Markdown:

```text
.ravi/observers/profiles/<id>/
  PROFILE.md
  delivery/end-of-turn.md
  delivery/realtime.md
  delivery/debounce.md
  events/message-user.md
  events/message-assistant.md
  events/turn-complete.md
  events/turn-failed.md
  events/turn-interrupt.md
  events/default.md
```

Não use manifest JSON/YAML separado. O frontmatter fica no `PROFILE.md`.

System profiles atuais:

- `default`: renderer genérico.
- `tasks`: renderer para observers que atualizam status de tasks.

## Observed Task

Use `observed-task` quando o worker deve executar sem carregar o protocolo de
status da task no prompt principal.

Setup típico:

```bash
ravi observers rules set observed-task-status <observer-agent> \
  --scope profile \
  --source-profile observed-task \
  --role task-status \
  --mode report \
  --profile tasks \
  --delivery end_of_turn \
  --permissions tasks.report,tasks.block,tasks.done,tasks.fail
```

`--permissions` aceita atalhos como `tasks.report` ou capability completa como
`use:tool:tasks_report`. Esses grants entram apenas no runtime context do
observer, não na sessão fonte. Para acesso recorrente de contato/agent fora do
contexto do observer, use `ravi permissions resolve <denial-id>` ou
`ravi permissions allow <profile> --to <subject> --agent <agent>
--capabilities <cap>`.

Depois:

```bash
ravi tasks create "..." --profile observed-task
ravi tasks dispatch <task-id> --agent <worker-agent> --execute
```

O worker faz o trabalho e deixa sinais claros. O observer recebe Markdown do
profile `tasks` e decide se chama `ravi tasks report|block|done|fail`.

## Tag-Driven Observers em Contatos

Rules com `--scope tag --tag-target contact --tag <slug>` agora veem tags ligadas a contatos vinculados à sessão fonte. A resolução acontece via `session_participants` (owner_type=`contact`).

Casos típicos:

- Instância configurada com `defaultContactTags` aplica tag em contatos novos. Rule observer com a mesma tag dispara automaticamente.
- Para mudar de observer, mude a tag do contato (`ravi contacts tag/untag`). Novas bindings serão criadas na próxima avaliação.
- DM-per-peer é o cenário ideal: 1 contato por sessão. Em sessões com vários contatos (group/main), todas as tags presentes são consideradas.

Detalhes operacionais e exemplos completos estão na skill `ravi-system:contacts` no playbook *Tag → Observer por Contato*.

## Invariantes

- Não crie rules por padrão em sistemas novos.
- Não injete conteúdo do observer na sessão fonte.
- Não use dumps JSON como formato primário para o observer.
- Não use modo `observe` com permissões mutáveis.
- Não reinicie daemon para validar profile; use `profiles preview|validate`.
- Não confie em remoção automática de bindings quando a tag de contato muda. Faça housekeeping manual quando preciso (`ravi observers ...`).
