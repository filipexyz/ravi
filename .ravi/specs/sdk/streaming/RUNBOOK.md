# Streaming / RUNBOOK

## Como Adicionar um Stream Channel

Pré-requisito: existir consumidor concreto que precisa do stream remoto. Sem
consumidor, não criar channel — manter handler `@CliOnly()`.

Passos previstos (a confirmar quando a primeira implementação for feita):

1. **Registrar channel** em `src/sdk/gateway/streaming/channels.ts` com:
   - `name` (ex: `events`, `tasks`)
   - `scope` REBAC (ex: `view system:events`)
   - função `subscribe(ctx, filters) -> AsyncIterable<{ id, event, data }>`
2. **Branch SSE no gateway** (`src/sdk/gateway/server.ts`): roteia
   `GET /api/v1/_stream/<channel>` antes do dispatcher single-shot.
3. **Auth + audit** reutilizando `resolveRuntimeContext` e `runWithContext`
   do gateway atual; emitir `sdk.gateway.stream.opened` e
   `sdk.gateway.stream.closed`.
4. **Codegen do client SDK** (`src/sdk/client-codegen/`) emite método
   tipado por channel usando `EventSource` (browser) ou fetch streaming
   (Node).
5. **Smoke test** com curl:
   ```bash
   curl -N -H "Authorization: Bearer rctx_..." \
        -H "Accept: text/event-stream" \
        "http://127.0.0.1:4211/api/v1/_stream/events?subject=ravi.session.>"
   ```
6. **Atualizar SPEC.md** marcando o channel como implementado, removendo
   da tabela "previstos" e movendo pra "ativos".

## Como Diagnosticar Stream Pendurado

Se um cliente reporta que stream não recebe eventos:

1. Verificar audit:
   ```bash
   ravi events replay --subject "sdk.gateway.stream.>" --since 5m
   ```
   Espera-se ver `opened` e `closed` casados. `opened` sem `closed` = leak.
2. Confirmar que o publisher upstream (NATS topic) tá emitindo:
   ```bash
   ravi events stream --filter "<topic>" --no-claude
   ```
3. Confirmar permissão REBAC do contexto: stream com 0 eventos pode ser
   silently dropped por scope mismatch.
4. Inspecionar o keepalive: client que não recebe `: ping` a cada 15s
   sugere conexão morta (load balancer dropou).

## Como Confirmar que Channel é o Padrão Certo

Antes de criar um channel novo, perguntar:

- O caller é unidirecional servidor → cliente? Se não, parar — abrir spec
  bidirecional separada.
- O caller precisa do histórico replay (bounded query)? Se sim, usar
  request/response normal (`events.replay` pattern), não stream.
- O caller precisa de garantia at-least-once? Streams SSE são best-effort
  com drop-tail. Se precisar, usar JetStream consumer direto, não passar
  pelo gateway.

## Como Reverter

Channel é registry runtime. Pra desabilitar, remover entrada do registry e
restartar daemon. Cliente recebe 404 na próxima reconexão.
