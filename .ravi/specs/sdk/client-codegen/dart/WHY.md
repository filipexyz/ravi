---
id: sdk/client-codegen/dart
title: "Dart SDK Codegen Rationale"
kind: feature
domain: sdk
status: draft
normative: false
---

# Why Dart SDK Codegen

Ravi already has generated TypeScript and Swift SDKs. Dart consumers need the
same command surface without embedding JavaScript, shelling out to the CLI, or
hand-writing endpoint wrappers. The intended published package is `ravi_sdk`
on pub.dev; this tree is the monorepo source for that package.

The important architectural decision is to keep `RegistrySnapshot` as the
single source of truth. The Dart SDK should not be generated from OpenAPI
because the current TypeScript SDK, Swift SDK, and gateway already share a
richer registry projection:

- arg/option ordering;
- binary marker;
- CLI-only exclusion;
- scope;
- return schemas;
- method/group names;
- registry hash.

Generating Dart from the same projection keeps Dart clients aligned with the
gateway and with `@ravi-os/sdk` / RaviSDK.

Dart is a fourth backend. TypeScript owns the shared `RegistrySnapshot` and
the first generated client. Swift is the closer implementation template
(generated client/types/schemas/version/streaming plus hand-written
transport/errors/JSON). Rust remains the planned third backend and is
spec-only; Dart does not wait on a Rust implementation.

## Why A Conservative Type Mapper

Dart's type system rewards precise models, but the Ravi command registry
contains many command returns that are still loose or intentionally generic.
A generator that tries to map every JSON Schema construct into elaborate Dart
sealed unions will become fragile quickly.

The MVP should optimize for:

1. analyzes cleanly every time;
2. preserves wire compatibility;
3. gives good types for common object/array/scalar shapes;
4. falls back to `RaviJson` for complex or unknown shapes.

Better a slightly generic SDK that Dart apps can use today than a precise
generator that fails on one unusual schema.

## Why Manual Transport

Transport code is platform code, not command code. It needs to handle
`package:http`, cancellation, headers, binary payloads, error decoding, and
SSE. Keeping it hand-written makes it testable and avoids generator churn.

Generated code should only know how to call the transport with:

- group segments;
- command name;
- flat body;
- expected decode function or binary response.

## Why HTTP-Only

A PATH `ravi` spawn / hybrid client is a desk-app workaround for old daemons.
The official SDK is a generated HTTP client over the gateway. Mixing process
spawning into the package would hide registry drift, skip gateway auth, and
create a second unofficial surface.

## Why No Flutter In The Package

Flutter widgets, Riverpod, go_router, and SharedPreferences encode product
opinions about state, navigation, and persistence. The SDK should first be a
stable low-level client that runs in any Dart runtime. App-specific layers can
depend on `ravi_sdk` once the transport and generated command surface are
stable.

## Why Not To Paper Over `{}`

`sessions.read` and `sessions.send` declare `@Returns`. The current gateway
treats an HTTP `{}` body as a contract/return-shape error when it does not
match that schema. A client that rewrites `{}` into an empty transcript hides
a real gateway bug and teaches callers the wrong success shape. Unknown JSON
fallback is only for commands without `@Returns`.
