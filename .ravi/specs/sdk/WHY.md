---
id: sdk
title: "Ravi SDK - Why"
kind: why
domain: sdk
owners:
  - dev
status: draft
---

# Why

## Problem

Ravi exposes 580+ CLI commands. Without a structured SDK layer, external
consumers and internal tooling must shell out to the CLI or reverse-engineer
HTTP endpoints — fragile, untyped, and impossible to version.

## Motivation

1. **Single source of truth.** Decorated CLI commands already carry request
   schemas, return schemas, and metadata. Projecting them into SDK clients
   avoids hand-maintained duplicates.
2. **Type-safe generated clients.** TypeScript, Swift, and future language
   SDKs are deterministic projections of the registry — consumers get
   compile-time safety for free.
3. **Concrete return contracts.** Every SDK-facing command declares a
   concrete `@Returns(zod)` schema. Weak schemas are prohibited.
4. **Binary escape hatch.** Commands that yield raw bytes use
   `@Returns.binary()` instead of forcing JSON encoding.

## Decision

The CLI registry is the canonical source. OpenAPI, TypeScript SDK, and Swift
SDK are generated projections. Commands not suitable for SDK exposure are
marked `@CliOnly()` with justification.
