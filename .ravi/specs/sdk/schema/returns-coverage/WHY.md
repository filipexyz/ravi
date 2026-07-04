---
id: sdk/schema/returns-coverage
title: "SDK Return Schema Coverage - Why"
kind: why
domain: sdk
capability: schema
feature: returns-coverage
owners:
  - dev
status: active
---

# Why

## Problem

Generated SDK clients (TypeScript, Swift, future Rust) need concrete return
types. When a public command uses a loose return schema — `unknown`, empty
objects, arrays of unknown, or passthrough objects — the generated client
lowers to an untyped `any`/`RaviJSON`/`serde_json::Value`, removing all
compile-time safety for callers.

## Motivation

1. **Type-safe clients.** Consumers of the SDK expect strongly typed method
   signatures. A concrete `@Returns(zod)` declaration lets codegen emit
   exact interfaces.
2. **Deterministic codegen.** When all public schemas are concrete, the
   generated client output is deterministic across runs — no surprise diffs.
3. **Contract enforcement.** Default validation now rejects any weak public
   return schema. Any new command must provide a concrete return contract.
4. **`@CliOnly()` integrity.** Hiding a command from SDK generation just to
   avoid typing its return schema defeats the purpose of the quality gate.
   `@CliOnly()` is reserved for genuinely local-only commands.

## Decision

Every SDK-facing (public) command MUST declare a concrete `@Returns(zod)`
schema or be explicitly marked `@CliOnly()` with justification. Weak public
return schemas are prohibited — the weak baseline is empty and default
validation rejects any weak schema.

For truly dynamic payloads where the exact shape cannot be known at compile
time, use `jsonValueSchema` (recursive `string | number | boolean | null |
JsonValue[] | Record<string, JsonValue>`) or `jsonObjectSchema`
(`Record<string, JsonValue>`) instead of `z.unknown()`. These are concrete
recursive JSON types that pass the quality analyzer.
