---
id: sdk/schema/returns-coverage
title: "SDK Return Schema Coverage - Why"
kind: why
domain: sdk
capability: schema
feature: returns-coverage
owners:
  - dev
status: draft
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
2. **Deterministic codegen.** If all public schemas are concrete, the
   generated client output is deterministic across runs — no surprise diffs.
3. **Contract enforcement.** The `WEAK_PUBLIC_RETURN_COMMANDS_BASELINE`
   locks existing debt and prevents regressions. Any new weak schema must
   pass review instead of silently accumulating.
4. **`@CliOnly()` integrity.** Hiding a command from SDK generation just to
   avoid typing its return schema defeats the purpose of the quality gate.
   `@CliOnly()` is reserved for genuinely local-only commands.

## Decision

Every SDK-facing (public) command MUST declare a concrete `@Returns(zod)`
schema or be explicitly marked `@CliOnly()` with justification. The weak
baseline must not grow without an explicit debt decision reviewed in the PR.
