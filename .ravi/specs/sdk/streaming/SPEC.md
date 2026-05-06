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
  funciona sem novo middleware.
- Reconnect automático com `Last-Event-ID` é grátis no client.
- Não existe connection state machine (heartbeat, ping/pong, close codes) pra
  gerenciar.
- Proxy/CDN/load balancer suportam SSE como qualquer HTTP request.

## Invariantes

- Endpoints de stream MUST ficar sob `/api/v1/_stream/<channel>` e NUNCA sob
  `/api/v1/<group>/<command>` (esse prefixo é reservado pro dispatcher
  single-shot).
- Toda request SSE MUST exigir `Authorization: Bearer rctx_*` válida e MUST
  emitir audit `sdk.gateway.stream.opened` na abertura e
  `sdk.gateway.stream.closed` no fim (cliente desconecta ou server fecha).
- Server MUST emitir `event:` + `data:` em JSON. `data:` MUST ser uma única
  linha JSON (sem multi-line `data:`). Nada de raw text.
- Cada evento MUST incluir `id:` monotônico (UUIDv7 ou seq) pra suportar
  reconnect via `Last-Event-ID`.
- Server MUST mandar comentário keepalive (`: ping`) a cada 15s pra evitar
  proxy/idle timeout.
- Filtros de cliente MUST vir via query string (`?subject=...&since=...`),
  nunca via body.
- Backpressure: quando cliente é lento, server MUST descartar eventos antigos
  (drop-tail) em vez de bufferizar memória sem limite. Não bloquear o
  publisher upstream.
- Streams MUST terminar com `event: end` quando o stream tem janela natural
  (ex: `--timeout` em `sessions/debug`); streams infinitos terminam apenas
  quando cliente desconecta.

## Channels

Cada channel é uma view nomeada sobre um topic (ou conjunto de topics) NATS,
publicada como SSE. O channel é registrado em runtime; não usar discovery
mágico.

Channels ativos:

| Channel              | Endpoint                         | Topic NATS subjacente             | Escopo REBAC              |
|----------------------|----------------------------------|-----------------------------------|---------------------------|
| `events`             | `/api/v1/_stream/events`         | `>` com filtros                   | `view system:events`      |
| `tasks`              | `/api/v1/_stream/tasks`          | `ravi.task.*.event`               | `view system:tasks`       |
| `sessions/<name>`    | `/api/v1/_stream/sessions/<name>`| `ravi.session.<name>.*` + approval| `access session:<name>`   |
| `audit`              | `/api/v1/_stream/audit`          | `ravi.audit.>`                    | `view system:audit`       |

`tmux.watch`, `tmux.attach`, `daemon.run`, `daemon.dev`, `instances.connect`
permanecem permanentemente CLI-only — não fazem sentido remotos.

## Auth e Escopo

- Auth Bearer é a mesma do gateway: `resolveRuntimeContext(token)`.
- Cada channel declara um escopo REBAC (ex: `events` → relação `view` em
  `system:events`). O gateway recusa subscribe sem permissão e emite
  `ravi.audit.denied` antes de fechar a conexão.
- Streaming endpoint NUNCA aceita token de escopo `open`. Streams sempre
  exigem identidade.

## Não-Objetivos

- WS bidirecional pra controle remoto de agent. Se vier demanda, é spec
  separada (`sdk/control-channel` ou similar), não esta.
- Replay durável de histórico (ex: `events.replay`). Replay continua sendo
  request/response normal — bounded query, retorna payload.
- Substituir CLI: `ravi events stream`, `ravi tasks watch` etc. continuam
  rodando local com o mesmo handler. SSE é exposição adicional, não
  substituição.

## Materialização

Implementado em:

- `src/sdk/gateway/streaming/*` — registry de channels, encoder SSE,
  keepalive, fila bounded/drop-oldest, auth, escopo e audit.
- `src/sdk/gateway/server.ts` — branch `GET /api/v1/_stream/*` antes do
  dispatcher single-shot.
- `src/sdk/gateway/route-table.ts` — reserva `/api/v1/_stream/*` para SSE e
  mantém comandos `@CliOnly()` fora de rotas/meta remotas.
- `packages/ravi-os-sdk/src/streaming.ts` — client fetch streaming com parser
  SSE tipado por channel.

O SDK usa `fetch` streaming em vez de `EventSource` nativo porque o contrato
MUST exigir header `Authorization: Bearer rctx_*`, e `EventSource` de browser
não permite header customizado sem polyfill.

O channel `events` reaproveita o mesmo filtro glob do CLI (`*` dentro do
segmento, `**` atravessando segmentos) e suprime os eventos ruidosos que o CLI
já suprime por padrão.
