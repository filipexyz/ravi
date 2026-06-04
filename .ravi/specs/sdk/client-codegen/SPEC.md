---
id: sdk/client-codegen
title: "Client Codegen"
kind: capability
domain: sdk
capabilities:
  - client-codegen
tags:
  - sdk
  - codegen
  - registry
  - deterministic
applies_to:
  - src/sdk/client-codegen
  - src/cli/commands/sdk.ts
  - packages/ravi-os-sdk
owners:
  - dev
status: draft
normative: true
---

# Client Codegen

Status: draft
Owner: dev
Last updated: 2026-05-05

## Intent

Client codegen turns the Ravi `RegistrySnapshot` into language-native clients
that can call the SDK gateway without hand-maintained command bindings.

The existing TypeScript SDK is the first backend. Swift is a second backend
with the same contract and a platform-native API shape. Rust is a planned
third backend and a proof point that the registry can project to additional
languages without hand-maintained command bindings.

## Generator Inputs

- Generators MUST consume `RegistrySnapshot`.
- Generators MUST filter out `cmd.cliOnly`.
- Generators MUST project input schemas from args and options exactly as the
  gateway dispatcher expects: flat top-level fields.
- Generators MUST project return schemas from `@Returns(zod)` when available.
- Generators MUST mark `@Returns.binary()` commands as binary transport calls.
- Generators SHOULD share pure projection helpers where the helper is not
  language-specific.

## Generated API Shape

- Generated clients MUST expose nested namespaces from `groupSegments`.
- Generated method names MUST be deterministic and language-idiomatic.
- Positional args SHOULD remain positional method parameters.
- Options SHOULD collapse into one trailing options object or struct.
- Commands with no args and no options SHOULD generate zero-argument methods.
- Commands with no `@Returns` MUST return a generic JSON/unknown type in that
  language.
- A language backend MAY ship with generic JSON fallbacks, but the SDK
  experience is only considered typed for commands that declare `@Returns` or
  `@Returns.binary()`.
- Binary commands MUST return that language's raw/binary response abstraction,
  not base64 JSON.

## Generated Files

Each backend SHOULD split generated code by responsibility:

- client namespace/method bindings;
- input option types;
- return payload types;
- schema constants when useful for that language;
- version and registry hash constants.

Generated files MUST be safe to overwrite completely.

## Hand-Written Runtime

Each language SDK MUST keep transport and error handling hand-written unless
the generated runtime has a strong reason to own it.

The transport abstraction MUST be small:

- command group segments;
- command name;
- flat JSON body;
- binary flag;
- response decode strategy.

Client codegen MUST NOT be described as converting the Ravi core runtime to a
target language. It converts the public command/client surface. Core runtime,
daemon, SQLite, NATS, provider adapters, and host services remain separate
implementation concerns unless a dedicated runtime-port spec exists.

## Versioning

- Generated SDK version constants SHOULD come from the package manifest version
  or an explicit `--version` argument.
- The default generator version MUST NOT silently diverge from the published
  package version.
- Registry hash MUST change when the generated client surface changes.

## Checks

- Every backend MUST have unit tests for deterministic emit.
- Every backend SHOULD have a mock-registry snapshot test for method naming,
  options bags, variadic args, binary returns, and unknown returns.
- Every backend SHOULD have at least one gateway roundtrip test when the
  language toolchain is available in CI.
- `ravi sdk <language> check` MUST fail on generated-source drift.
- Every backend SHOULD report return-shape coverage so typed-client progress is
  visible. See `sdk/schema/returns-coverage`.
