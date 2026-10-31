---
id: sdk/streaming
title: "Streaming"
kind: capability
domain: sdk
capabilities:
  - streaming
tags:
  - sse
  - gateway
  - long-lived
applies_to:
  - src/sdk/gateway/**
  - src/webhooks/http-server.ts
  - src/cli/commands/**
owners:
  - sdk
status: active
normative: true
---

# Streaming

## Intent

Definir o padrão único pelo qual handlers de stream (NATS subscribe, polling
loops, event tails) são expostos via gateway sem violar o contrato single-shot
do dispatcher (`src/sdk/gateway/dispatcher.ts`).

Sem esse padrão, cada handler streaming vira ou:

1. CLI-only permanente (não reutilizável por overlay/SDK), ou
2. Bug latente no gateway (request fica pendurada eternamente, sem audit, sem
   liberar context-key), ou
3. Endpoint ad-hoc próprio sem auth/contrato consistente.

## Decisão Arquitetural

Streams remotos usam **Server-Sent Events (SSE)** sob o prefixo
`/api/v1/_stream/<channel>`. Não usar WebSocket para esses casos.

Justificativa:

- Streams atuais (`events`, `tasks`, `sessions/debug`, `tmux/prompts`) são
  **unidirecional servidor → cliente**. WS resolve bidirecional, que não é o
  problema aqui.
- SSE é HTTP/1.1 nativo: a mesma cadeia de auth Bearer (`rctx_*`) do gateway
  funciona sem novo middleware nos canais NATS. A visão privada `session-view`
  usa delegação Console; ver [exceção](#visão-privada-delegada-pelo-console).
- Reconnect automático com `Last-Event-ID` é grátis no client.
- Não existe connection state machine (heartbeat, ping/pong, close codes) pra
  gerenciar.
- Proxy/CDN/load balancer suportam SSE como qualquer HTTP request.

## Invariantes

- Endpoints de stream MUST ficar sob `/api/v1/_stream/<channel>` e NUNCA sob
  `/api/v1/<group>/<command>` (esse prefixo é reservado pro dispatcher
  single-shot).
- Toda request SSE MUST exigir identidade autenticada: `Authorization: Bearer
  rctx_*` nos canais NATS; delegação Console em `session-view`, conforme a
  [exceção](#visão-privada-delegada-pelo-console). Ambos MUST emitir audit
  `sdk.gateway.stream.opened` na abertura e `sdk.gateway.stream.closed` no fim,
  observada a limitação de shutdown do SQLite privado descrita na exceção.
- Server MUST emitir `event:` + `data:` em JSON. `data:` MUST ser uma única
  linha JSON (sem multi-line `data:`). Nada de raw text.
- Cada evento MUST incluir `id:` monotônico (UUIDv7 ou seq) pra suportar
  reconnect via `Last-Event-ID`, exceto o cursor HMAC opaco de
  [`session-view`](#visão-privada-delegada-pelo-console).
- Server MUST mandar comentário keepalive (`: ping`) a cada 15s pra evitar
  proxy/idle timeout nos canais NATS. `session-view` usa batches `journal`
  vazios em pull como [heartbeat](#visão-privada-delegada-pelo-console).
- O `Bun.serve` que escuta `/api/v1/_stream/*` MUST set `idleTimeout`
  (segundos) **acima** do keepalive. Default do Bun é 10s — isso mata SSE
  idle (incluindo `/_stream/sessions`) antes do primeiro ping. Default
  Ravi: `idleTimeout=30` (ping 15s + margem). Preferir subir o idleTimeout
  a abaixar o ping; ping <10s martelaria o canal sem necessidade.
- Filtros de cliente MUST vir via query string (`?subject=...&since=...`),
  nunca via body.
- Backpressure nos canais NATS: quando cliente é lento, server MUST descartar
  eventos antigos (drop-oldest) em vez de bufferizar memória sem limite. Não
  bloquear o publisher upstream. `session-view` preserva o journal durável e
  usa [pull sem descarte](#visão-privada-delegada-pelo-console).
- Streams MUST terminar com `event: end` quando o stream tem janela natural
  (ex: `--timeout` em `sessions/debug`); streams infinitos terminam apenas
  quando cliente desconecta ou a autoridade expira/é revogada. A visão privada
  [fecha sem `event: end`](#visão-privada-delegada-pelo-console).

## Channels

Cada channel é uma view nomeada publicada como SSE: os canais locais leem
topics NATS; `session-view` lê o journal privado durável na instalação Ravi.
O channel é registrado em runtime; não usar discovery mágico.

Channels ativos:

| Channel                  | Endpoint                              | Fonte de eventos                                                                | Autoridade exigida                |
|--------------------------|---------------------------------------|--------------------------------------------------------------------------------------|-----------------------------|
| `events`                 | `/api/v1/_stream/events`              | `>` com filtros                                                                      | `view system:events`        |
| `tasks`                  | `/api/v1/_stream/tasks`               | `ravi.task.*.event`                                                                  | `view system:tasks`         |
| `sessions/<name>`        | `/api/v1/_stream/sessions/<name>`     | `ravi.session.<name>.*` + approval                                                   | `access session:<name>`     |
| `chats/<chatId>`         | `/api/v1/_stream/chats/<chatId>`      | `message.received.>`, `reaction.received.>`, `presence.typing`, `chat.unread-updated`, filtrado por `chatId` | `view chat:<chatId>`        |
| `instances/<instanceId>` | `/api/v1/_stream/instances/<id>`      | `instance.>` filtrado por `instanceId`                                               | `view instance:<instanceId>`|
| `session-view` | `/api/v1/_stream/session-view` | Journal privado durável SQLite na instalação Ravi | Delegação Console + vínculo enrollment/owner/projeto/sessão; sem fallback local/admin |
| `audit`                  | `/api/v1/_stream/audit`               | `ravi.audit.>`                                                                       | `view system:audit`         |

`chats/<chatId>` é o canal alvo para clientes de UI (mobile, web) que renderizam um chat específico em tempo real. O servidor MUST descartar qualquer evento em que `data.payload.chatId` (ou `data.chatId` como fallback) não case com `<chatId>` para evitar leak entre chats. O channel propaga o topic original em `data.topic` e o payload bruto em `data.data`, sem reformatar — clientes ficam responsáveis pelo shape do payload upstream.

`instances/<instanceId>` resolve o `instanceId` em ordem: `data.payload.instanceId`, `data.metadata.instanceId`, `data.instanceId`, sufixo do subject `instance.{action}.{channelType}.{instanceId}`. Eventos sem identificador resolvido são descartados.

O channel `events` deliberadamente NÃO emite `message.*`, `reaction.*`, `instance.*`, `presence.typing` nem `chat.unread-updated` — esse channel mantém paridade com `ravi events stream` (debug firehose). Para esses topics use os channels dedicados acima.

`tmux.watch`, `tmux.attach`, `daemon.run`, `daemon.dev`, `instances.connect`
permanecem permanentemente CLI-only — não fazem sentido remotos.

## Auth e Escopo

- Nos canais NATS, auth Bearer é a mesma do gateway: `resolveRuntimeContext(token)`.
  `session-view` exige a [autoridade Console](#visão-privada-delegada-pelo-console).
- Cada channel NATS declara um escopo Permission Provider Runtime (ex: `events` → relação `view` em
  `system:events`). O gateway recusa subscribe sem permissão e emite
  `ravi.audit.denied` antes de fechar a conexão.
- Streaming endpoint NUNCA aceita token de escopo `open`. Streams sempre
  exigem identidade.

## Não-Objetivos

- WS bidirecional pra controle remoto de agent. Se vier demanda, é spec
  separada (`sdk/control-channel` ou similar), não esta.
- Replay durável de histórico nos canais NATS (ex: `events.replay`). Neles,
  replay continua sendo request/response normal — bounded query, retorna
  payload. `session-view` possui replay durável por cursor como exceção.
- Substituir CLI: `ravi events stream`, `ravi tasks watch` etc. continuam
  rodando local com o mesmo handler. SSE é exposição adicional, não
  substituição.

## Materialização

Implementado em:

- `src/sdk/gateway/streaming/*` — registry de channels, encoder SSE,
  keepalive, fila bounded/drop-oldest, auth, escopo e audit.
- `src/sdk/gateway/http-serve.ts` — `Bun.serve` options compartilhadas
  (`idleTimeout=30`) para o listener de produção e o gateway de teste.
- `src/webhooks/http-server.ts` — listener de produção em
  `RAVI_HTTP_PORT` (:7777) que monta o gateway.
- `src/sdk/gateway/server.ts` — branch `GET /api/v1/_stream/*` antes do
  dispatcher single-shot.
- `src/sdk/gateway/route-table.ts` — reserva `/api/v1/_stream/*` para SSE e
  mantém comandos `@CliOnly()` fora de rotas/meta remotas.
- `packages/ravi-os-sdk/src/streaming.ts` — client fetch streaming com parser
  SSE tipado por channel.
- `packages/ravi-os-dart-sdk/lib/src/ravi_streaming.generated.dart` — Dart
  stream client with the same official SSE parser (not `EventSource`).

O SDK usa `fetch` streaming em vez de `EventSource` nativo porque o contrato
MUST exigir header `Authorization` com o bearer da autoridade correspondente,
e `EventSource` de browser
não permite header customizado sem polyfill.

O channel `events` reaproveita o mesmo filtro glob do CLI (`*` dentro do
segmento, `**` atravessando segmentos) e suprime os eventos ruidosos que o CLI
já suprime por padrão.

## Visão privada delegada pelo Console

`session-view` é registrado em `defaultStreamChannels` e gera `sessionView` nos
SDKs. É uma exceção explícita à autenticação rctx dos canais locais: só aceita
a autoridade `sdk/console-authority`; contextos locais/admin são negados. O
handler pertence ao registro de streams, com schema de opções e payload. O
journal fica no SQLite privado da instalação Ravi; o Console não armazena o
histórico. Cada `id:` SSE é o cursor HMAC opaco vinculado a
owner/projeto/enrollment/epoch/conversa. O reconnect envia esse cursor na query
assinada; se houver `Last-Event-ID`, ele MUST coincidir com a query. Não se usa
UUIDv7/seq público como `id:`.

Pull/backpressure preserva a posição no journal sem drop-oldest. Enquanto há
consumo, cada pull após o primeiro espera 250ms e emite um batch `journal`,
mesmo vazio; esse batch faz o heartbeat, sem `: ping` separado. Reconnect não
renova o lease do turno. Expiração/revogação da delegação fecha o stream sem
`event: end`; falhas emitem `gateway.error` e fecham. Reconectar exige nova
delegação e nova validação de ownership/cursor.

Os eventos `sdk.gateway.stream.opened` e `sdk.gateway.stream.closed` são
inseridos diretamente na tabela `audit` do SQLite privado do Ravi, não no sink
NATS de auditoria comum. A admissão exige audit de abertura; o fechamento é
best-effort se desconexão/shutdown já fechou o banco. Falha no audit de
fechamento nunca prolonga a autoridade nem reabre o stream.
