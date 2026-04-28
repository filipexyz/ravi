# @ravi-os/sdk

Type-safe TypeScript client for the Ravi gateway. The `RaviClient` surface is
generated 1:1 from `getRegistry()`, so every CLI command becomes a typed method
on the client.

## Install

```bash
bun add @ravi-os/sdk
# or
npm install @ravi-os/sdk
```

## HTTP transport (browser- or node-compatible)

```ts
import { RaviClient } from "@ravi-os/sdk/client";
import { createHttpTransport } from "@ravi-os/sdk/transport/http";

const client = new RaviClient(
  createHttpTransport({
    baseUrl: "http://127.0.0.1:7777",
    contextKey: process.env.RAVI_CONTEXT_KEY!,
  }),
);

const result = await client.artifacts.show("art_xyz");
```

`createHttpTransport` only depends on the global `fetch`, so it runs in any
modern browser, Node 18+, Bun, Deno, or edge runtime.

## In-process transport (server-side only)

```ts
import { RaviClient } from "@ravi-os/sdk/client";
import { createInProcessTransport } from "@ravi-os/sdk/transport/in-process";
import { getRegistry } from "ravi.bot/cli/registry-snapshot";

const client = new RaviClient(
  createInProcessTransport({
    registry: getRegistry(),
    scopeContext: { agentId: "agent-orquestrador" },
  }),
);
```

The in-process transport reuses the same dispatcher pipeline that the HTTP
gateway runs (validation, scope checks, audit), without HTTP overhead. It only
runs in Node — the package exports map this entry as `null` for non-node
conditions.

## Generated artifacts

`client.ts`, `schemas.ts`, `types.ts`, and `version.ts` are produced by
`ravi sdk client generate` and committed as the canonical surface. Drift is
caught by `ravi sdk client check` (used in CI).

## Errors

Every transport throws strongly-typed errors:

- `RaviAuthError` — 401, missing/invalid context key
- `RaviPermissionError` — 403, scope denied
- `RaviValidationError` — 4xx body validation, exposes `issues[]`
- `RaviInternalError` — 5xx from the gateway
- `RaviTransportError` — network / timeout / unexpected shape

All inherit from `RaviError`, so `catch (e: unknown) { if (e instanceof RaviError) ... }` works.
