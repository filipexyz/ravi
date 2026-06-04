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
status: draft
normative: true
---

# SDK Return Schema Coverage

Status: draft
Owner: dev
Last updated: 2026-06-03

## Intent

Increase `@Returns(zod)` coverage for SDK-facing commands so generated clients
can expose typed return payloads instead of generic JSON.

This is the priority bottleneck before using Rust codegen as a strong typed
SDK demonstration.

## Baseline

Measured on 2026-06-03:

```json
{
  "groups": 96,
  "commands": 517,
  "exposed": 472,
  "cliOnly": 45,
  "withReturns": 3,
  "withoutReturns": 469,
  "binary": 1
}
```

This means a new language backend can generate the command surface today, but
most methods would return `unknown`, `RaviJSON`, or `serde_json::Value`.

## Rules

- New SDK-facing commands SHOULD declare `@Returns(zod)` unless their return is
  intentionally generic.
- Existing SDK-facing commands SHOULD be migrated toward `@Returns(zod)` in
  priority order.
- Commands with no stable remote semantics SHOULD be marked `@CliOnly()`
  instead of being exposed with an unknown return type.
- Binary commands MUST use `@Returns.binary()`.
- `@Returns` schemas MUST describe sanitized, JSON-safe return payloads.
- A command MUST NOT add an overly broad fake return schema just to improve the
  metric. If the shape is not stable, keep the generic fallback and document why.
- CLI rendering flags such as `--json`, `--pretty`, `--quiet`, and `--verbose`
  MUST remain rendering concerns and MUST NOT be modeled as SDK contract fields.

## Priority Order

Prioritize schemas where typed clients unlock the most value:

1. SDK and registry commands used to demonstrate codegen itself.
2. Read/list/show commands for agents, sessions, contacts, chats, routes,
   permissions, apps, artifacts, tasks, workflows, and sync.
3. Small mutating commands with stable acknowledgement payloads.
4. Long-tail admin/debug commands.

The first milestone SHOULD focus on high-value read/list/show commands before
mutating or process-level commands.

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

- A coverage audit command or test reports SDK-facing command counts,
  `@Returns` count, binary count, and unknown fallback count.
- Adding `@Returns` to a command is covered by dispatcher or codegen tests when
  the shape is non-trivial.
- TypeScript, Swift, and future Rust generators continue to emit deterministic
  clients.
- Rust codegen demos MUST report the return-shape coverage at the time of the
  demo.
