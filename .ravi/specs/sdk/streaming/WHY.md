# Streaming / WHY

## Rationale

### Contexto Histórico

A migração SDK Wave 1 + Wave 2 (`sdk-audit-2026-04-29.md`) revelou que o
gateway tinha um bug latente: `buildRouteTable` carregava todos os 326
handlers sem filtro, e 9 deles eram streaming/process-level/interactive. Se
um cliente chamasse `/api/v1/events/stream` via gateway, a request ficava
pendurada infinitamente: handler nunca retorna, dispatcher nunca emite
audit, nunca libera o context-key.

Solução de curto prazo aplicada nos commits `dd74b72` e `ee24fdc`:
decorator `@CliOnly()` que exclui esses 9 handlers do route-table, OpenAPI
emit e codegen. Bug fechado, mas o decorator é apenas sinal "isto não cabe
no gateway atual"; ele não responde *como* expor stream remotamente quando
alguém precisar.

### Tradeoff: WebSocket vs SSE

WebSocket:

- Bidirecional, full-duplex.
- Requer connection state (heartbeat/ping-pong, close codes, reconnect
  manual).
- Auth na handshake é diferente do middleware HTTP atual.
- Cliente Node precisa de lib (não nativo).
- Proxy/load balancer/CDN tratam diferente de HTTP normal.

SSE:

- Unidirecional servidor → cliente. Bate exatamente com os 4 streams
  candidatos atuais (`events`, `tasks`, `sessions/debug`, `audit`).
- HTTP/1.1 nativo. Mesma cadeia Bearer + ContextRecord do gateway funciona
  sem código novo.
- Reconnect automático com `Last-Event-ID` no client.
- `EventSource` nativo no browser, fetch streaming no Node.
- Proxy transparente.

Decisão: SSE. Se um dia houver caso bidirecional (cliente manda comando no
meio do stream), abrir spec separada — não dobrar a função do endpoint.

### Tradeoff: Endpoint Único vs Por-Handler

Opção A — Endpoint único `/api/v1/_stream/<channel>` com registry de
channels: 1 contrato, 1 lugar de auth, 1 lugar de audit, codegen
consistente.

Opção B — Endpoint por handler (`/api/v1/events/stream/_sse`,
`/api/v1/tasks/watch/_sse`): cada handler vira ad-hoc, cada um inventa
formato.

Decisão: A. O custo de registrar um channel é baixo; o custo de manter
formatos divergentes é alto.

### Tradeoff: Construir Agora vs Esperar Consumidor

Construir spec + implementação agora teria custo zero pro overlay de hoje,
mas:

- Spec sem consumidor concreto vira fanfic — escolhas erradas só aparecem
  quando alguém usa de verdade.
- Endpoint sem cliente é dead code que precisa ser mantido.

Decisão: spec congela o contrato; implementação espera demanda real
(provavelmente WA-overlay timeline live ou tasks board live).

### Não-Decisão Pendente

Política de backpressure (server descarta vs cliente acomoda) fica como
"drop-tail no server" como default, mas a regra exata depende do primeiro
caso real (ex: timeline live aceita perder eventos antigos? task board
precisa de garantia?). Anotar quando materializar.

### Snippets de Conversa

- 2026-04-29 (Luís): "por que esses são cli only?" — apresentei 9 handlers
  agrupados por categoria (process/interactive/streaming/borderline).
- 2026-04-29 (Luís): "é nessa hora que faz sentido criar um endpoint em ws
  pra stream? seguindo um padrão único?"
- Resposta: sim, mas SSE em vez de WS.
- Luís: "quero" → criação desta spec.
