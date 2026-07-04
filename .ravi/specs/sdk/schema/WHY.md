---
id: sdk/schema
title: "SDK schema contract - Why"
kind: why
domain: sdk
capability: schema
owners:
  - dev
status: draft
---

# Why

## Problem

Generated SDK clients need typed request and return shapes. Without a
schema contract, each command's wire format is ad-hoc — generated clients
fall back to `any` types and consumers lose compile-time safety.

## Motivation

1. **JSON-safe baseline.** Every command's request and return payloads are
   validated against Zod schemas at the gateway, ensuring wire-format
   correctness.
2. **Concrete returns.** Public commands MUST declare `@Returns(zod)` with
   concrete schemas. Weak schemas (unknown, passthrough, empty objects)
   are prohibited.
3. **Binary escape hatch.** Commands yielding raw bytes use
   `@Returns.binary()` — a clean opt-out from JSON encoding without
   weakening the schema contract.
4. **Deterministic codegen.** The same registry projection always produces
   the same generated client output.

## Decision

The SDK schema contract defines JSON-safe as the default wire format, with
`@Returns.binary()` as the only supported escape hatch. Return-shape
coverage is enforced by the quality analyzer — see
`sdk/schema/returns-coverage`.
