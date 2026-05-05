---
id: sdk/client-codegen/swift
title: "Swift SDK Codegen Rationale"
kind: feature
domain: sdk
status: draft
normative: false
---

# Why Swift SDK Codegen

Ravi already has a generated TypeScript SDK. Native macOS apps need the same
command surface without embedding JavaScript, shelling out to the CLI, or
hand-writing endpoint wrappers.

The important architectural decision is to keep `RegistrySnapshot` as the
single source of truth. The Swift SDK should not be generated from OpenAPI
because the current TypeScript SDK and gateway already share a richer registry
projection:

- arg/option ordering;
- binary marker;
- CLI-only exclusion;
- scope;
- return schemas;
- method/group names;
- registry hash.

Generating Swift from the same projection keeps native app clients aligned with
the gateway and with `@ravi-os/sdk`.

## Why A Conservative Type Mapper

Swift's type system rewards precise models, but the Ravi command registry
contains many command returns that are still loose or intentionally generic.
A generator that tries to map every JSON Schema construct into elaborate Swift
enums will become fragile quickly.

The MVP should optimize for:

1. compiles every time;
2. preserves wire compatibility;
3. gives good types for common object/array/scalar shapes;
4. falls back to `RaviJSON` for complex or unknown shapes.

Better a slightly generic SDK that native apps can use today than a precise
generator that fails on one unusual schema.

## Why Manual Transport

Transport code is platform code, not command code. It needs to handle
`URLSession`, cancellation, headers, binary payloads, error decoding, and later
SSE. Keeping it hand-written makes it testable and avoids generator churn.

Generated code should only know how to call the transport with:

- group segments;
- command name;
- flat body;
- expected return type or binary response.

## Why No SwiftUI In The MVP

SwiftUI wrappers are useful, but they encode product opinions about state,
refresh cadence, and observation. The SDK should first be a stable low-level
client. App-specific layers can build on top once the transport and generated
command surface are stable.
