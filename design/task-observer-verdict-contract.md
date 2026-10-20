# Task Observer Verdict Contract

Incidente de referência: 20/10/2026, task `task-1b0f5f7b` (PR #719). O worker
terminou, o observer respondeu `{"status":"done","progress":100,...}`, e o runtime
descartou **todos** os veredictos com:

```
Task observer reply has no valid verdict  reason=invalid
error=Too big: expected string to have <=200 characters
```

O campo que estourou era um `checklist[].item` (limite de 200), não a `message`
(limite de 2000). A task ficou em `in_progress` 0%, não emitiu report de conclusão
e, 30 min depois, virou `task.checkpoint.missed` + `task.stalled`.

## Fluxo end-to-end

1. **Binding**: `buildTaskObserverRule` em `src/tasks/observer-contract.ts` cria a
   regra sintética `builtin:task-observer` (`deliveryPolicy: end_of_turn`,
   `mode: report`, grant `none`, pulse de 5 min). `ensureObserverBindingsForSession`
   em `src/runtime/observation-plane.ts` materializa uma sessão observer por task
   observada.
2. **Delivery**: eventos do worker (`message.user`, `message.assistant`,
   `tool.start/end`, `turn.complete/failed/interrupt`) são entregues no fim do
   turno (ou por pulse em turno longo). O prompt é renderizado pelos templates
   `src/plugins/internal/ravi-system/observers/profiles/task-observer/delivery/*.md`.
3. **Output**: o observer responde texto puro (sem tools) com um bloco
   `<task-verdict>{...}</task-verdict>`.
4. **Coleta do texto**: `src/runtime/host-event-loop.ts` acumula os
   `assistant.message` do turno do observer em `observerTurnText` e, desde esta
   correção, também em `observerTurnFragments`; em `turn.complete` chama
   `applyTaskObserverTurn`.
5. **Parsing**: `parseTaskObserverVerdict` em `src/tasks/observer-contract.ts`
   extrai o **último** bloco completo (ou um bloco sem fechamento), remove fence,
   repara truncamento estrutural e normaliza campos.
6. **Schema**: `TaskObserverVerdictSchema` continua sendo a forma estrita do
   contrato; o parser normaliza antes de validar.
7. **Apply/idempotência**: `applyTaskObserverTurn` em `src/tasks/observer-apply.ts`
   escopa a delivery à task/assignee, reivindica `deliveryId` em
   `task_observer_deliveries` **depois** de um parse utilizável e chama
   `reportTaskProgress`/`blockTask`/`completeTask`/`failTask`/nudge/stall.
8. **Eventos/notificação**: `emitTaskEvent` publica no stream `ravi.task.<id>` e
   dispara automations/reports. `completeTask` grava `task.done` com progress 100.
9. **Render**: `buildTaskObserverSummary` alimenta `ravi tasks show` (modelo,
   último veredicto, nota, checklist, nudges/stall).

## Decisão de contrato

Regra nova, exigida pelo Luís: **nenhum campo não-crítico inválido derruba o
veredicto inteiro.** Apenas `status` é fatal. Especificamente:

- `status`: obrigatório e exato (após trim/lowercase) em
  `unchanged|progress|blocked|done|failed|stopped`. Ausente ou desconhecido →
  rejeição real, com caminho `status` e valor bounded.
- `checklist[].item`: truncado em 200 chars com `… [truncated]`; item vazio é
  descartado; item não-string é descartado; `done` aceita boolean e coerções
  conservadoras (`"true"/"yes"/1`, `"false"/"no"/0`), senão vira `false` com warning.
  Lista > 30 itens mantém os 30 primeiros e avisa.
- `message`/`missing`/`evidence`: truncados em 2000/1000/500 com elipse.
- `progress`: aceita número ou string numérica, arredonda e clampa em 0..100.
- Campos extras: ignorados com warning bounded.
- JSON truncado no meio de string/objeto/array: reparo estrutural conservador
  (fecha o que o stream deixou aberto; nunca inventa conteúdo).
- Bloco sem `</task-verdict>`: aceito como cauda do texto (stream cortado).
- Dois blocos: vence o último.
- Fragmentação entre utterances: o parser tenta o texto acumulado e também os
  fragmentos recombinados sem o separador `\n\n` que o acumulador de prosa insere,
  para não quebrar uma string JSON partida ao meio.

O limite de 200 continua existindo para o checklist, mas agora ele é explícito no
prompt dos três templates e o runtime normaliza em vez de descartar.

`done` com `progress < 100` continua concluindo (a task vai a 100). `done` com
`missing` ignora o `missing`. Progresso observado é monotônico: um veredicto stale
não faz o progresso regredir.

## Matriz adversarial coberta em `src/tasks/observer.test.ts`

| Cenário | Resultado esperado | Coberto |
| --- | --- | --- |
| item de checklist 201/2000/2001/5000 chars | aceita, item truncado ≤200 | sim |
| 31+ itens | aceita, mantém 30 | sim |
| item vazio | descarta só o item | sim |
| `done` não-boolean (`"yes"`) / ausente | coage true / false | sim |
| campos extras | ignora com warning | sim |
| `message` >2000, `missing` >1000, `evidence` >500 | aceita truncado | sim |
| status desconhecido/ausente | rejeita, path `status` | sim |
| payload não-objeto | rejeita, path `json` | sim |
| JSON truncado no meio | repara e aceita | sim |
| bloco sem fechamento | repara e aceita | sim |
| dois blocos | último vence | sim |
| fence ```json, BOM, CRLF, emoji | aceita | sim |
| veredicto fragmentado entre utterances | recombina fragmentos | sim |
| `<task-verdict>` vindo do worker (injection) | neutralizado no prompt; só output do observer é parseado | sim |
| `done` com progress <100 / com `missing` | conclui em 100, ignora `missing` | sim |
| progress regressivo/stale | não regride | sim |
| redelivery do mesmo turno | aplica no máximo uma vez | sim |
| fixture sanitizada do incidente | `done` aplicado exatamente uma vez | sim |

## Observabilidade

Todo veredicto rejeitado agora produz:

- log `warn` estruturado `Task observer verdict rejected` com `taskId`,
  `deliveryId`, `observerSessionName`, `reason`, caminho do campo (`status`,
  `json`, `checklist[i].item`...) e valor ofensor sanitizado/bounded;
- um evento `task.comment` visível na timeline/`ravi tasks show`, uma única vez
  por delivery (id `rejected:<deliveryId>`), com o caminho e a mensagem bounded.
  Um redelivery não duplica o evento.

Veredictos aceitos com reparo emitem `Task observer verdict normalized` com os
warnings (truncado, descartado, coergido, inesperado), para o reparo não ser
silencioso.

## Retry/reparo automático

Não foi adicionado retry de segunda chamada. Trade-off:

- **Custo/latência**: uma chamada extra do modelo por veredicto rejeitado;
- **Risco de duplicidade**: uma segunda resposta pode chegar depois de um apply
  parcial e disputar a mesma task;
- **Ganho baixo**: a maior parte do espaço de falha agora é normalizada no parse
  (checklist longo, campo opcional, JSON truncado). O que sobra é `status`
  ausente/desconhecido, que uma re-chamada pode repetir;
- Rejeição continua visível e a delivery não é queimada antes do parse, então um
  retry manual/operacional continua possível.

Se a taxa de rejeição real justificar, o próximo passo é um retry bounded (uma
tentativa) com prompt de reparo explícito e a mesma `deliveryId`, mas isso fica
fora deste PR.

## Fora de escopo

- Alterar permissões, agents, routes, crons, daemon ou banco.
- Mudar `deliveryPolicy`, pulse ou o modelo do observer.
- Reescrever o formato do veredicto (JSON dentro de `<task-verdict>` foi mantido).
- Retry automático e rerun de veredictos históricos perdidos.
