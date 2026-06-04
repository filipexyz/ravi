---
id: sdk/client-codegen/rust
title: "Rust SDK Codegen"
kind: feature
domain: sdk
capability: client-codegen
feature: rust
capabilities:
  - client-codegen
  - rust
tags:
  - sdk
  - rust
  - generated-client
  - deterministic
applies_to:
  - src/sdk/rust-codegen
  - src/cli/commands/sdk.ts
  - packages/ravi-os-rust-sdk
owners:
  - dev
status: draft
normative: true
---

# Rust SDK Codegen

Status: draft
Owner: dev
Last updated: 2026-06-03

## Intent

Generate a Rust SDK from the Ravi `RegistrySnapshot` so Rust consumers can call
the SDK gateway with typed async methods, `serde` models, and a small
hand-written transport.

Rust SDK generation MUST be another backend over the same registry projection
used by TypeScript and Swift. It MUST NOT be hand-maintained command glue.

## Validated Hypothesis

The decorated CLI registry already contains enough information to generate a
large Rust client surface deterministically:

- group and command namespaces;
- positional args and options;
- flat request bodies;
- scope metadata;
- binary marker;
- return schema when `@Returns` is declared;
- CLI-only exclusion.

This proves the codegen architecture can project the public command/client
surface into another language quickly.

## Boundary

Rust client codegen MUST NOT be described as automatic conversion of the entire
Ravi codebase.

The decorators and registry describe the public command contract. They do not
describe the internal implementation of:

- daemon composition;
- SQLite stores;
- NATS and event loops;
- runtime providers;
- host services and permission hooks;
- channel adapters;
- business logic inside command handlers.

A Rust port of those internals would require separate specs and explicit
architecture decisions.

## Package Shape

The package SHOULD live at:

```text
packages/ravi-os-rust-sdk/
  Cargo.toml
  src/
    lib.rs
    client.generated.rs
    types.generated.rs
    schemas.generated.rs
    version.generated.rs
    transport.rs
    error.rs
    json.rs
```

Generated files MUST use `.generated.rs` suffixes. Hand-written files MUST NOT
be overwritten by the generator.

## CLI Surface

The Ravi CLI SHOULD expose:

```bash
ravi sdk rust generate --out packages/ravi-os-rust-sdk/src
ravi sdk rust check --out packages/ravi-os-rust-sdk/src
```

Optional flags:

- `--version <semver>` overrides the SDK version baked into
  `version.generated.rs`.
- `--json` prints machine-readable results.

## Rust API Shape

Generated usage SHOULD be idiomatic Rust:

```rust
let client = RaviClient::new(HttpTransport::new(
    "http://127.0.0.1:7777",
    "rctx_...",
));

let artifact = client.artifacts().show("art_123").await?;
let sessions = client.sessions().list(SessionsListOptions {
    live: Some(true),
    ..Default::default()
}).await?;
```

Rules:

- Namespaces MUST follow registry `groupSegments`.
- Method names SHOULD be snake_case.
- Positional args SHOULD remain method parameters.
- Options SHOULD collapse into a trailing options struct.
- Option structs SHOULD derive `Debug`, `Clone`, `Default`, `Serialize`, and
  `Deserialize` when possible.
- Return structs SHOULD derive `Debug`, `Clone`, `Serialize`, and
  `Deserialize` when possible.
- Request encoding MUST produce the same flat JSON body the gateway expects.

## Transport Contract

The hand-written transport MUST be trait-based and small:

```rust
#[async_trait::async_trait]
pub trait RaviTransport: Send + Sync {
    async fn call_json(
        &self,
        group_segments: &[&str],
        command: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, RaviError>;

    async fn call_binary(
        &self,
        group_segments: &[&str],
        command: &str,
        body: serde_json::Value,
    ) -> Result<RaviBinaryResponse, RaviError>;
}
```

`HttpTransport` SHOULD use `reqwest` and MUST:

- POST to `/api/v1/<segments>/<command>`;
- send `Authorization: Bearer <rctx>`;
- send `Content-Type: application/json`;
- send SDK version and registry hash headers;
- decode gateway error bodies into typed `RaviError` values.

## Type Mapping

The initial JSON Schema to Rust mapping MUST be conservative:

- `string` -> `String`
- `boolean` -> `bool`
- `integer` -> `i64`
- `number` -> `f64`
- `array<T>` -> `Vec<T>`
- `object` with known properties -> `struct`
- string enum -> Rust enum with serde rename attributes when safe
- `additionalProperties` object -> `BTreeMap<String, T>`
- unknown schema -> `serde_json::Value`
- unsupported `anyOf`/`oneOf`/complex unions -> `serde_json::Value` in MVP

The generator MUST prefer compiling Rust over perfect specificity. When a
schema cannot be represented safely, it MUST fall back to `serde_json::Value`.

## Binary Commands

Commands marked `@Returns.binary()` MUST generate methods returning
`RaviBinaryResponse`.

```rust
pub struct RaviBinaryResponse {
    pub bytes: bytes::Bytes,
    pub content_type: Option<String>,
    pub status_code: u16,
    pub headers: BTreeMap<String, String>,
}
```

The Rust SDK MUST NOT base64-wrap binary responses.

## Remote CLI Demo

A Rust remote CLI MAY be generated as a follow-up proof point. It MUST call the
gateway contract and MUST NOT execute Ravi command handlers locally.

If generated, it SHOULD use `clap` and the same registry projection to build
commands, args, options, descriptions, and flat JSON request bodies.

## Return Coverage Gate

The current bottleneck is return-shape coverage. A Rust backend can generate
all SDK-facing methods with `serde_json::Value` fallbacks, but a convincing
typed Rust demo SHOULD first improve `@Returns` coverage for priority command
groups. See `sdk/schema/returns-coverage`.

## Non-Goals

- No automatic Rust conversion of the Ravi core runtime.
- No OpenAPI-driven Rust generation as the primary path.
- No hand-maintained Rust command bindings.
- No local execution of Ravi command handlers in the Rust SDK.
- No binary request upload support in the first milestone.
