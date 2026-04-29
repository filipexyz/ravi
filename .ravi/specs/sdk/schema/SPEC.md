---
id: sdk/schema
title: "SDK schema contract"
kind: capability
domain: sdk
capabilities:
  - schema
tags:
  - sdk
  - registry
  - json-safe
  - binary-escape-hatch
applies_to:
  - src/cli/registry-snapshot.ts
  - src/sdk/gateway/dispatcher.ts
  - src/sdk/openapi/emit.ts
  - src/sdk/client-codegen
owners:
  - dev
status: draft
normative: true
---

# SDK schema contract

Status: draft
Owner: dev (task-478b2acf)
Last updated: 2026-04-28

## Goal

Document the JSON-safe contract that governs how registry commands marshal
inputs and outputs across the gateway and the generated `@ravi-os/sdk`
client, and register the **binary escape hatch** (`@Returns.binary()`) used
by commands that cannot be encoded as JSON (file blobs, raw streams).

## JSON-safe baseline

The registry projection (`src/cli/registry-snapshot.ts`) produces a flat,
serializable view consumed by:

- `src/sdk/gateway/dispatcher.ts` — request validation + invocation
- `src/sdk/openapi/emit.ts` — OpenAPI emit
- `src/sdk/client-codegen/*` — TypeScript SDK emit (types, schemas, client)

By default, every command is JSON-safe end-to-end:

1. Request body: flat object, validated by Zod schemas inferred from `@Arg`
   and `@Option` decorators (or explicit `schema` overrides).
2. Handler return: validated by the optional `@Returns(zod)` schema.
3. Wire: `application/json` charset utf-8.
4. SDK type: `Promise<DerivedType>` from `z.toJSONSchema(returns)`.

## Escape hatch — `@Returns.binary()`

### Use case

Endpoints that must yield raw bytes (e.g. inline image/audio/video blobs,
file downloads, attachment streams) cannot be encoded as JSON without:

- Base64/data-URI inflation (~33% size overhead) — blocks streaming.
- Out-of-band staging (URL temp + redirect) — adds round-trip latency.

For these, the registry exposes a marker decorator that bypasses JSON
serialization at the dispatcher and yields a raw `Response` end-to-end.

### Decorator

```ts
import { Command, Returns } from "../decorators.js";

@Command({ name: "blob", description: "Stream artifact bytes" })
@Returns.binary()
async blob(@Arg("id") id: string): Promise<Response> {
  const file = await loadArtifact(id);
  return new Response(file.stream(), {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "content-length": String(file.size),
    },
  });
}
```

`@Returns.binary()` is mutually exclusive with `@Returns(schema)`. If both
are present, the binary marker wins (the Zod schema is ignored).

### Registry projection

`CommandRegistryEntry.binary?: boolean` is `true` when the method carries
the `RETURNS_BINARY_KEY` reflect metadata. Consumers (codegen, dispatcher,
OpenAPI) branch on this field.

### Dispatcher behaviour

`src/sdk/gateway/dispatcher.ts`:

1. Skip `checkReturnShape()` (Zod return validation does not apply).
2. Validate the handler returned a `Response` instance. If not, emit
   `ReturnShapeError` (HTTP 500) with a message that names
   `@Returns.binary()` so the bug is obvious in logs.
3. Pass the handler's `Response` through unchanged. The `Content-Type`,
   `Content-Length`, body stream, and any custom headers ride to the
   client untouched.
4. The audit event is emitted exactly once, identical to JSON commands.

### Transport behaviour

`packages/ravi-os-sdk/src/transport/types.ts` carries an opt-in
`binary?: boolean` on `TransportCallInput`. Generated client methods set
it to `true` for every binary command.

- `createHttpTransport`: when `binary === true`, yields the `Response`
  directly for 2xx; for 4xx/5xx still parses the JSON error body via
  `buildErrorFromGateway` so error semantics stay consistent with JSON
  commands.
- `createInProcessTransport`: same branch — the dispatcher already
  returned a `Response`, the transport just forwards it.

### Generated SDK shape

`src/sdk/client-codegen/emit-files.ts`:

- `types.ts`: `export type ${CmdReturn} = Response;` (no JSON Schema is
  emitted into `schemas.ts` for binary commands).
- Client method signature: `Promise<Response>`.
- `transport.call({ groupSegments, command, body, binary: true })`.

Consumers read the response with the standard `Response` API:

```ts
const res = await client.artifacts.blob(id);
const blob = await res.blob();
const stream = res.body; // ReadableStream<Uint8Array> | null
```

### What is NOT supported by the escape hatch

- **Binary request bodies.** Inputs remain JSON. If a command needs to
  upload bytes, model it as a JSON body with a content-key reference and
  a separate upload command. (Out of scope for the migration that
  introduces this spec.)
- **Server-Sent Events / streaming JSON.** A binary command may stream
  raw bytes, but the SDK does not surface a typed stream parser. Use
  `Response.body` directly.
- **OpenAPI emit for binary returns.** Until the OpenAPI generator
  learns about `cmd.binary`, the spec lists the response as
  `application/octet-stream` with empty schema. Codegen ignores the
  OpenAPI return schema for binary commands anyway, so this is a
  documentation gap, not a runtime issue.

### Migration & rollout

1. The decorator + registry + dispatcher + transports + codegen all land
   in the same change as the first consumer (`artifacts blob` migrated
   from `bridge.ts:handleArtifactBlob`).
2. SDK consumers must be on a version that includes the `binary` field
   on `TransportCallInput`. Calling a binary command with an older
   transport falls through the JSON branch and corrupts the bytes —
   `REGISTRY_HASH` will not match, which surfaces the mismatch at
   runtime.
3. Future binary commands re-use the same decorator with no further
   plumbing.

## Cross-references

- Decorator: `src/cli/decorators.ts` (`Returns.binary`,
  `getReturnsBinaryMetadata`).
- Registry: `src/cli/registry-snapshot.ts` (`CommandRegistryEntry.binary`).
- Dispatcher: `src/sdk/gateway/dispatcher.ts` (binary branch before
  `checkReturnShape`).
- Transports: `packages/ravi-os-sdk/src/transport/{types,http,in-process}.ts`.
- Codegen: `src/sdk/client-codegen/emit-files.ts` (`emitTypes`,
  `renderMethod`).
- Tests: `src/sdk/gateway/dispatcher.test.ts` (`@Returns.binary()`
  describe block).
