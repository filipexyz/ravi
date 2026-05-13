# @ravi-os/sdk

Type-safe TypeScript SDK for controlling a Ravi runtime through the authenticated
SDK gateway.

Ravi is not just a model wrapper. It is a local-first runtime for long-lived
agents: sessions, tasks, contacts, artifacts, routes, events, permissions, and
audit all live behind one command registry. `@ravi-os/sdk` turns that registry
into a typed client you can use from apps, dashboards, browser extensions,
workers, tests, and internal tools.

```ts
import { RaviClient, createHttpTransport } from "@ravi-os/sdk";

const ravi = new RaviClient(
  createHttpTransport({
    baseUrl: "http://127.0.0.1:7777",
    contextKey: process.env.RAVI_CONTEXT_KEY!,
  }),
);

const sessions = await ravi.sessions.list({ live: true, limit: "20" });
const reply = await ravi.sessions.send("main", "Summarize the current work.", {
  wait: true,
});
```

## Why This Exists

Use the SDK when you need a programmatic control plane for Ravi:

- Build a dashboard that reads sessions, tasks, contacts, and runtime events.
- Let a browser extension talk to the local Ravi daemon without shelling out.
- Drive agents from tests or internal automation.
- Stream live task/session/event updates into another UI.
- Write a custom app while keeping auth, permissions, validation, and audit in
  Ravi instead of duplicating them.

The package is generated from Ravi's decorated CLI registry. If a command exists
in the registry, the SDK gets the same shape, names, args, options, and return
typing.

## Install

```bash
bun add @ravi-os/sdk
```

The package is ESM-only and works anywhere `fetch` is available: Bun, Node 18+,
modern browsers, Deno, and edge runtimes.

## Start The Ravi Gateway

The SDK talks to Ravi's HTTP gateway. Enable it on the daemon host:

```bash
RAVI_HTTP_PORT=7777
RAVI_HTTP_HOST=127.0.0.1
ravi daemon start
```

The gateway is mounted under:

```text
http://127.0.0.1:7777/api/v1/*
```

By default Ravi is local-only. If you bind the gateway to a non-loopback host,
Ravi requires:

```bash
RAVI_GATEWAY_NETWORK_AUTHORIZED=1
```

To keep the HTTP server available for webhooks while disabling SDK routes:

```bash
RAVI_SDK_GATEWAY_DISABLE=1
```

## Create A Context Key

Most SDK routes require a runtime context key (`rctx_*`) in the bearer auth
header. Bootstrap the first admin key on the daemon machine:

```bash
ravi daemon init-admin-key
```

For apps, issue a narrow child key instead of shipping the admin key:

```bash
ravi context issue dashboard \
  --ttl 2h \
  --allow view:system:events,view:system:tasks,access:session:main \
  --json
```

`createHttpTransport` sends the key as `Authorization: Bearer <rctx_key>`.

## Create A Client

```ts
import { RaviClient, createHttpTransport } from "@ravi-os/sdk";

export function createRaviClient() {
  return new RaviClient(
    createHttpTransport({
      baseUrl: process.env.RAVI_BASE_URL ?? "http://127.0.0.1:7777",
      contextKey: process.env.RAVI_CONTEXT_KEY!,
      timeoutMs: 10_000,
    }),
  );
}
```

Deep imports are available when you want smaller bundles:

```ts
import { RaviClient } from "@ravi-os/sdk/client";
import { createHttpTransport } from "@ravi-os/sdk/transport/http";
```

## Examples

### Read Runtime State

```ts
const ravi = createRaviClient();

const agents = await ravi.agents.list({ limit: "50" });
const sessions = await ravi.sessions.list({ live: true, limit: "25" });
const recentTasks = await ravi.tasks.list({
  status: "running",
  limit: "10",
});
```

### Send A Prompt To A Session

```ts
const result = await ravi.sessions.send("main", "What changed in the repo?", {
  wait: true,
});

console.log(result);
```

`wait: true` maps to the CLI's `--wait`. Without it, the command is
fire-and-forget.

### Stream Session Events

```ts
import { createStreamClient } from "@ravi-os/sdk/streaming";

const stream = createStreamClient({
  baseUrl: "http://127.0.0.1:7777",
  contextKey: process.env.RAVI_CONTEXT_KEY!,
});

for await (const event of stream.session("main", { timeout: 60 })) {
  console.log(event.event, event.data);
}
```

### Stream System Events

```ts
for await (const event of stream.events({
  subject: "ravi.session.>",
  noClaude: true,
  noHeartbeat: true,
})) {
  console.log(event.data.topic, event.data.type);
}
```

Available stream helpers:

- `stream.events(...)` -> `GET /api/v1/_stream/events`
- `stream.tasks(...)` -> `GET /api/v1/_stream/tasks`
- `stream.session(name, ...)` -> `GET /api/v1/_stream/sessions/<name>`
- `stream.audit(...)` -> `GET /api/v1/_stream/audit`

Streams always require a valid context key and the matching scope, such as
`view:system:events`, `view:system:tasks`, `access:session:<name>`, or
`view:system:audit`.

### Work With Contacts And CRM

```ts
const contacts = await ravi.contacts.list({ limit: "20" });
const crmCards = await ravi.crm.contacts({ limit: "20" });
const nextActions = await ravi.crm.next({ owner: "agent:main", limit: "10" });

await ravi.crm.contact.set("contact_123", "lifecycle", "active", {
  source: "dashboard",
});
```

### Create And Version Artifacts

```ts
const artifact = await ravi.artifacts.create({
  title: "Weekly summary",
  output: "# Summary\n\nDone.",
  mime: "text/markdown",
  session: "main",
  tags: "summary,weekly",
});

await ravi.artifacts.snapshot("art_123", {
  label: "v1",
  message: "First published summary",
});
```

Binary artifact commands return the raw `Response` on success:

```ts
const response = await ravi.artifacts.blob("art_123");
const bytes = await response.arrayBuffer();
```

### Use A Custom Transport In Tests

The generated client only depends on the `Transport` interface. You can mock it
without starting a daemon:

```ts
import { RaviClient, type Transport } from "@ravi-os/sdk";

const calls: unknown[] = [];

const mockTransport: Transport = {
  async call(input) {
    calls.push(input);
    return { ok: true };
  },
};

const ravi = new RaviClient(mockTransport);
await ravi.sessions.send("main", "hello");
```

## Method Naming

Generated method names mirror the CLI:

- `ravi daemon init-admin-key` -> `ravi.daemon.initAdminKey()`
- `ravi sessions send main "hello" --wait` -> `ravi.sessions.send("main", "hello", { wait: true })`
- `ravi crm contact set <contact> lifecycle active` -> `ravi.crm.contact.set(contact, "lifecycle", "active")`
- `ravi sdk client check` -> `ravi.sdk.client.check()`

Positional args become positional method parameters. CLI options become the final
`options` object. Most string-like CLI flags stay typed as strings because the
registry mirrors the CLI parser; boolean flags are booleans.

## Wire Contract

Every command call becomes:

```text
POST /api/v1/<group-segments>/<command>
```

The request body is flat JSON. Positional args and options are merged at the top
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

Do not wrap input as `{ "args": ..., "options": ... }`.

The HTTP transport adds:

- `Authorization: Bearer <rctx_key>`
- `x-ravi-sdk-version`
- `x-ravi-registry-hash`

## Errors

All transports throw the same error hierarchy:

- `RaviAuthError` - 401, missing/invalid/expired/revoked context key
- `RaviPermissionError` - 403, scope denied
- `RaviValidationError` - 4xx validation failure, exposes `issues[]`
- `RaviInternalError` - 5xx from the gateway or command handler
- `RaviTransportError` - network failure, timeout, or unexpected transport error

```ts
import { RaviError, RaviValidationError } from "@ravi-os/sdk/errors";

try {
  await ravi.artifacts.show("missing");
} catch (error) {
  if (error instanceof RaviValidationError) {
    console.error(error.issues);
  } else if (error instanceof RaviError) {
    console.error(error.status, error.command, error.message);
  }
}
```

## Codegen And Drift

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
bun run docs:openapi
bun src/cli/index.ts sdk swift generate
```

The source of truth is `src/cli/registry-snapshot.ts`, not the OpenAPI file.

## Published Exports

```ts
import { RaviClient } from "@ravi-os/sdk";
import { RaviClient as DeepClient } from "@ravi-os/sdk/client";
import { createHttpTransport } from "@ravi-os/sdk/transport/http";
import { createStreamClient } from "@ravi-os/sdk/streaming";
import { RaviError } from "@ravi-os/sdk/errors";
import type { SessionsListReturn } from "@ravi-os/sdk/types";
```

Published exports:

- `@ravi-os/sdk`
- `@ravi-os/sdk/client`
- `@ravi-os/sdk/transport/http`
- `@ravi-os/sdk/streaming`
- `@ravi-os/sdk/errors`
- `@ravi-os/sdk/types`
- `@ravi-os/sdk/schemas`

`packages/ravi-os-sdk/src/transport/in-process.ts` is monorepo-internal and is
not exported by the published package.
