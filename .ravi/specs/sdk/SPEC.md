---
id: sdk
title: "Ravi SDK"
kind: domain
domain: sdk
capabilities:
  - schema
  - streaming
  - client-codegen
tags:
  - sdk
  - gateway
  - registry
  - generated-clients
applies_to:
  - src/cli/decorators.ts
  - src/cli/registry-snapshot.ts
  - src/sdk
  - packages/ravi-os-sdk
owners:
  - dev
status: draft
normative: true
---

# Ravi SDK

Status: draft
Owner: dev
Last updated: 2026-05-05

## Intent

The Ravi SDK domain defines the contract between decorated Ravi CLI commands,
the SDK gateway, OpenAPI emitters, and generated native clients.

The source of truth is the decorated CLI registry, not OpenAPI and not a
hand-maintained SDK surface.

## Source Of Truth

- `RegistrySnapshot` from `src/cli/registry-snapshot.ts` MUST be the canonical
  source for request shape, return shape, command path, scope, binary marker,
  and CLI-only exclusion.
- OpenAPI, TypeScript SDK, Swift SDK, and future language SDKs MUST be
  deterministic projections of the same `RegistrySnapshot`.
- Generated clients MUST NOT parse OpenAPI as their primary input unless a
  later spec explicitly changes the source-of-truth model.
- `@CliOnly()` commands MUST be excluded from gateway route tables, OpenAPI,
  and generated SDK clients.
- `@Returns(zod)` SHOULD be present for any command intended for SDK consumers.
  Commands without `@Returns` MAY be exposed, but generated clients MUST treat
  their return payload as unknown or generic JSON.
- `@Returns.binary()` is the only supported marker for single-shot binary
  responses.

## Wire Contract

- Gateway request bodies MUST be flat JSON objects containing positional args
  and options as top-level keys.
- Generated clients MUST NOT send `{ args, options }` wrapper payloads.
- Gateway command routes MUST be `POST /api/v1/<group-segments>/<command>`.
- Generated HTTP transports MUST send `Authorization: Bearer <rctx>`.
- Generated HTTP transports SHOULD send SDK/version drift headers equivalent
  to `x-ravi-sdk-version` and `x-ravi-registry-hash`.
- Request validation MUST happen at the gateway dispatcher with the same Zod
  schemas projected into SDK types.
- Return validation MUST happen at the gateway dispatcher when `@Returns(zod)`
  is declared.

## Determinism And Drift

- SDK code generators MUST sort commands by `fullName`.
- Generated source files MUST be byte-stable for the same registry projection,
  generator version, and SDK version.
- Generated files MUST carry a clear "do not edit" header.
- Each generated SDK package MUST expose the registry hash it was generated
  from.
- Drift checks MUST compare on-disk generated files against a fresh emit.
- Informational fields such as source Git SHA MAY be masked during drift checks
  when they do not affect the generated API surface.

## Manual Versus Generated Code

- Generated files MUST contain command namespaces, input shapes, return shapes,
  schema constants when useful, and version/hash constants.
- Hand-written files MUST contain transports, error mapping, streaming helpers,
  package manifests, and platform integration utilities.
- Business logic MUST NOT live in generated clients.
- Generated clients MUST be thin callers into a transport abstraction.

## Non-Goals

- SDK generation does not replace the CLI.
- SDK generation does not grant permissions or bypass runtime context-key
  authorization.
- Language SDKs do not own command semantics; command handlers remain in Ravi.
- OpenAPI remains documentation and integration surface, not the generator's
  only source of truth.
