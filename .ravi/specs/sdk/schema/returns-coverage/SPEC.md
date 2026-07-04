---
id: sdk/schema/returns-coverage
title: "SDK Return Schema Coverage"
kind: feature
domain: sdk
capability: schema
feature: returns-coverage
capabilities:
  - schema
  - client-codegen
tags:
  - sdk
  - returns
  - typed-clients
  - codegen
applies_to:
  - src/cli/commands
  - src/cli/decorators.ts
  - src/cli/registry-snapshot.ts
  - src/sdk/client-codegen
  - src/sdk/swift-codegen
owners:
  - dev
status: active
normative: true
---

# SDK Return Schema Coverage

Status: active
Owner: dev
Last updated: 2026-07-02

## Intent

Every SDK-facing public command MUST expose a concrete, JSON-safe return
schema via `@Returns(zod)` or `@Returns.binary()`. Weak public return
schemas are prohibited.

## Rules

- Public commands MUST expose a concrete JSON-safe return schema or
  `@Returns.binary()`.
- Public return schemas MUST NOT be weak. A weak schema includes:
  - `z.unknown()` or fields lowering to unknown
  - `z.array(z.unknown())` (arrays of unknown items)
  - `.passthrough()` or open-object schemas (`additionalProperties` not
    `false` or not a concrete schema)
  - Empty objects used as a final public contract
  - `z.record(z.string(), z.unknown())` (unknown additional properties)
  - Generic command envelopes (e.g. `looseObjectSchema`,
    `commandEnvelopeReturnSchema`) as the sole return contract
- `@CliOnly()` MUST be semantically justified and MUST NOT be used as a
  shortcut to avoid schema work. Valid reasons include: interactive/TUI
  commands, daemon/process lifecycle, streaming/watch, and commands with
  no stable request/response contract.
- Binary commands MUST use `@Returns.binary()`.
- `@Returns` schemas MUST describe sanitized, JSON-safe return payloads.
- CLI rendering flags such as `--json`, `--pretty`, `--quiet`, and `--verbose`
  MUST remain rendering concerns and MUST NOT be modeled as SDK contract fields.
- For truly dynamic/opaque payloads, use `jsonObjectSchema` or
  `jsonValueSchema` (concrete recursive JSON types) rather than `z.unknown()`.
- Default validation (`ravi sdk returns validate`) MUST reject any weak
  public return schema.
- The weak baseline (`WEAK_PUBLIC_RETURN_COMMANDS_BASELINE`) MUST remain
  empty. It is retained only for migration tooling compatibility and MUST
  NOT be used as a permanent allowlist.
- Generated SDK/OpenAPI/Swift artifacts MUST stay deterministic and in sync.

## Shape Guidelines

- Prefer explicit object schemas with stable field names.
- Include pagination metadata for paginated lists.
- Use discriminated unions only when generated language backends can represent
  them safely; otherwise use conservative JSON fallbacks.
- Preserve error handling in the gateway error contract, not in command return
  schemas.
- Avoid exposing raw provider payloads, secrets, tokens, prompts, or tool output
  as typed returns.

## Acceptance Criteria

- `ravi sdk returns status --json` reports `weakPublic: 0`,
  `baselineWeakPublic: 0`, and `newlyWeak: []`.
- `ravi sdk returns validate --json` succeeds when all returns are concrete
  and fails by default if any weak public return schema remains.
- Weak baseline file is empty and cannot make weak public schemas pass.
- All public command return schemas are concrete enough for SDK/OpenAPI.
- Any `@CliOnly()` has semantic justification and is covered by tests/docs.
- TypeScript, Swift, and future Rust generators continue to emit deterministic
  clients.
