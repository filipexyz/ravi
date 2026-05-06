# @ravi-os/sdk

Type-safe TypeScript client for the Ravi SDK gateway.

`RaviClient` is generated from Ravi's decorated CLI registry, so the SDK mirrors
the same command surface exposed by the gateway. The generated client stays thin:
it builds a flat request body and delegates auth, validation, scope checks, audit,
and HTTP details to a transport.

## Install

```bash
bun add @ravi-os/sdk
```

The package is ESM-only and expects a runtime with `fetch` available. That means
modern browsers, Node 18+, Bun, Deno, and edge runtimes work with the HTTP
transport.

## Enable the Gateway

The SDK talks to Ravi's HTTP server. The daemon only starts that server when an
HTTP port is configured:

```bash
RAVI_HTTP_PORT=7777
RAVI_HTTP_HOST=127.0.0.1
```

The SDK gateway is mounted under `/api/v1/*` on the same listener as webhooks.
Binding to a non-loopback host requires `RAVI_GATEWAY_NETWORK_AUTHORIZED=1`.
Set `RAVI_SDK_GATEWAY_DISABLE=1` to disable SDK routes while leaving the HTTP
server available for other webhook handlers.

## Auth

Non-open routes require a runtime context key (`rctx_*`) sent as:

```text
Authorization: Bearer <rctx_key>
```

Bootstrap the first admin key on the daemon host:

```bash
ravi daemon init-admin-key
```

For apps, issue scoped child keys instead of shipping the admin key:

```bash
ravi context issue dashboard \
  --ttl 2h \
  --allow view:system:events,view:system:tasks \
  --json
```

## Basic Client

```ts
import { RaviClient, createHttpTransport } from "@ravi-os/sdk";

const client = new RaviClient(
  createHttpTransport({
    baseUrl: "http://127.0.0.1:7777",
    contextKey: process.env.RAVI_CONTEXT_KEY!,
    timeoutMs: 10_000,
  }),
);

const agents = await client.agents.list();
const route = await client.instances.routes.add(
  "main",
  "group:120363428558776322",
  "ravi-web",
  { channel: "whatsapp", session: "ravi-web" },
);
```

Generated method names are camel-cased. For example:

- `ravi daemon init-admin-key` becomes `client.daemon.initAdminKey()`
- `ravi instances routes add` becomes `client.instances.routes.add(...)`
- `ravi sdk client check` becomes `client.sdk.client.check()`

## Request Shape

Every command call maps to:

```text
POST /api/v1/<group-segments>/<command>
```

The JSON body is flat. Positional arguments and options are merged at the top
level:

```json
{
  "name": "main",
  "pattern": "group:120363428558776322",
  "agent": "ravi-web",
  "channel": "whatsapp",
  "session": "ravi-web"
}
```

Do not wrap inputs as `{ "args": ..., "options": ... }`.

## Streaming

Use `createStreamClient` or `RaviStreamClient` for server-sent event streams:

```ts
import { createStreamClient } from "@ravi-os/sdk/streaming";

const stream = createStreamClient({
  baseUrl: "http://127.0.0.1:7777",
  contextKey: process.env.RAVI_CONTEXT_KEY!,
});

for await (const event of stream.events({ subject: "ravi.session.>", noClaude: true })) {
  console.log(event.event, event.data);
}
```

Available streams:

- `stream.events(...)` -> `GET /api/v1/_stream/events`
- `stream.tasks(...)` -> `GET /api/v1/_stream/tasks`
- `stream.session(name, ...)` -> `GET /api/v1/_stream/sessions/<name>`
- `stream.audit(...)` -> `GET /api/v1/_stream/audit`

Streaming routes always require a valid context key. They also check scoped
permissions such as `view:system:events`, `view:system:tasks`,
`access:session:<name>`, or `view:system:audit`.

## Binary Responses

Commands marked with `@Returns.binary()` return a raw `Response` for successful
2xx calls. Error responses are still parsed and mapped to `RaviError`
subclasses.

```ts
const response = await client.artifacts.blob("art_123");
const bytes = await response.arrayBuffer();
```

## Errors

Every transport throws the same typed error hierarchy:

- `RaviAuthError` - 401, missing/invalid/expired/revoked context key
- `RaviPermissionError` - 403, scope denied
- `RaviValidationError` - 4xx validation failure, exposes `issues[]`
- `RaviInternalError` - 5xx from the gateway or command handler
- `RaviTransportError` - network failure, timeout, or unexpected transport error

All inherit from `RaviError`:

```ts
import { RaviError, RaviValidationError } from "@ravi-os/sdk/errors";

try {
  await client.artifacts.show("missing");
} catch (error) {
  if (error instanceof RaviValidationError) {
    console.error(error.issues);
  } else if (error instanceof RaviError) {
    console.error(error.status, error.command, error.message);
  }
}
```

## Codegen and Drift

Generated files are committed as the canonical package surface:

- `src/client.ts`
- `src/schemas.ts`
- `src/types.ts`
- `src/version.ts`

Regenerate and check drift from the Ravi repo root:

```bash
bun run sdk:generate
bun run sdk:check
```

OpenAPI and Swift SDK snapshots are generated from the same registry:

```bash
bun src/cli/index.ts sdk openapi emit --out docs/openapi.json
bun src/cli/index.ts sdk swift generate
```

The source of truth is the `RegistrySnapshot` from
`src/cli/registry-snapshot.ts`, not the OpenAPI file.

## Published Exports

Published consumers can import:

- `@ravi-os/sdk`
- `@ravi-os/sdk/client`
- `@ravi-os/sdk/transport/http`
- `@ravi-os/sdk/streaming`
- `@ravi-os/sdk/errors`
- `@ravi-os/sdk/types`
- `@ravi-os/sdk/schemas`

`src/transport/in-process.ts` is monorepo-internal and is not exported by the
published package.
