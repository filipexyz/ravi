# Ravi Delivery Barriers v0

## Tese

O Ravi já tinha um comportamento implícito de fila:

- enfileira enquanto a sessão sobe
- não interrompe tool/compacting
- interrompe resposta em texto

Isso agora virou uma primitive explícita no prompt:

- `deliveryBarrier`

O runtime deixa de “adivinhar” a intenção e passa a decidir entrega por barreira operacional.

## Barreiras

### `p0` → `immediate_interrupt`

Entrega assim que for seguro.

Comportamento:

- interrompe resposta em texto
- interrompe tool **só** se ela estiver classificada como `safe`
- **não** interrompe `starting`, `compacting` nem tool `unsafe`

Use quando:

- a mensagem é urgente
- precisa furar a resposta atual

### `p1` → `after_tool`

Espera acabar `starting`, `tool` e `compacting`.
Se não houver tool em curso, pode preemptar a resposta em texto.

Esse é o comportamento **default** atual do Ravi.

Use quando:

- a mensagem pode cortar a resposta atual
- mas não deve furar uma tool em andamento

### `p2` → `after_response`

Espera o turno atual terminar inteiro.

Comportamento:

- não interrompe resposta
- não interrompe tool
- não interrompe compacting
- só entrega quando o turno cair para estado ocioso

Use quando:

- é follow-up normal
- não vale cortar o raciocínio atual

### `p3` → `after_task`

Espera a sessão não ter task ativa.

Comportamento:

- segura enquanto a sessão tiver task em `dispatched`, `in_progress` ou `blocked`
- libera quando a task terminaliza em `done` ou `failed`
- depois de liberada, ainda respeita o barrier de resposta: só entra quando o turno atual estiver livre
- em `cold start`, a sessão pode ficar só estacionada sem abrir runtime até a barreira liberar
- em dispatch de task, o Ravi ignora a **própria task despachada** para não entrar em self-deadlock

Use quando:

- a mensagem deve esperar o trabalho atual terminar

## Fonte de verdade do `p3`

`after_task` não é heurística de nome de sessão.
Ele olha o task runtime:

- tabela `tasks`
- `assignee_session_name`
- status ativo

Quando chega `task.done` ou `task.failed`, o bot acorda a sessão que estava com mensagens estacionadas em `after_task`.

## Ordem efetiva

Mais urgente → menos urgente:

1. `p0` `immediate_interrupt`
2. `p1` `after_tool`
3. `p2` `after_response`
4. `p3` `after_task`

Mensagens mais urgentes podem passar na frente de mensagens antigas bloqueadas por uma barreira mais baixa.

Exemplo:

- mensagem antiga `p3` fica estacionada
- mensagem nova `p0` chega
- `p0` entrega primeiro

## CLI v0

Os comandos de sessão aceitam `--barrier`:

- `ravi sessions send ... --barrier p0`
- `ravi sessions ask ... --barrier p2`
- `ravi sessions execute ... --barrier p3`
- `ravi sessions inform ... --barrier p1`
- `ravi sessions answer ... --barrier p0`

Aliases aceitos:

- `p0`, `interrupt`, `immediate`, `now`
- `p1`, `tool`, `after_tool`
- `p2`, `response`, `after_response`
- `p3`, `task`, `after_task`

Sem `--barrier`, o default é:

- `after_tool`

## Defaults semânticos

Sem `--barrier`, o Ravi agora usa defaults por classe de mensagem:

- `ravi sessions send`
  - `after_tool`
- `ravi sessions ask`
  - `after_response`
- `ravi sessions answer`
  - `immediate_interrupt`
- `ravi sessions execute`
  - `after_task`
- `ravi sessions inform`
  - `after_response`

Também existe inferência no ponto de publish:

- `_heartbeat` e `_trigger`
  - `after_task`
- prompt `[System] Execute: ...`
  - `after_task`
- prompt `[System] Answer: ...`
  - `immediate_interrupt`
- prompt `[System] Ask:` e `[System] Inform:`
  - `after_response`
- inbound humano explicitamente urgente (`!!`, `urgent:`, `urgente:`, `p0:`)
  - `immediate_interrupt`

## Garantias do v0

- backward-compatible: fluxo antigo continua como `p1`
- `p0/p1/p2` funcionam no runtime do bot
- `p3` está ligado ao task runtime real
- `ravi tasks dispatch` agora já publica com `p3` por default, com self-exemption da task despachada
- `unsafe tool` continua sendo hard stop para interrupção

## Limitações conhecidas

- `blocked` ainda conta como task ativa
- o restante do sistema ainda não expõe isso em UI

## Próximo passo natural

Fazer o próprio task runtime usar isso de forma explícita:

- dispatch normal
- follow-up interno
- mensagens de supervisão
- mensagens humanas urgentes
