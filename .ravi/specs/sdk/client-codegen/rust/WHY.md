---
id: sdk/client-codegen/rust
title: "Rust SDK Codegen - Why"
kind: why
domain: sdk
capability: client-codegen
feature: rust
owners:
  - dev
status: draft
---

# Why Rust SDK Codegen

## Decision

Use the existing `RegistrySnapshot` as the source of truth for a future Rust
SDK and optional Rust remote CLI.

## Rationale

The CLI decorators already create a structured command contract. TypeScript and
Swift codegen prove that the registry can drive multiple language backends with
deterministic output.

Rust is a strong next proof point because it stresses the generator in ways the
existing backends do not:

- stricter ownership and type constraints;
- explicit error types;
- async transport traits;
- `serde` serialization boundaries;
- compile-time drift visibility.

## What This Proves

Rust codegen proves Ravi can generate another language client quickly from the
same contract. It does not prove that the whole Ravi runtime has been ported.

That distinction matters. The command registry describes how to call Ravi, not
how Ravi internally executes work.

## Bottleneck

Return-shape coverage is the main blocker for a strong demo. Most SDK-facing
commands currently lack `@Returns`, so a Rust client would be correct but
would expose many `serde_json::Value` return types.

Before presenting Rust codegen as a powerful typed SDK story, prioritize
`@Returns` coverage for high-value command groups.
