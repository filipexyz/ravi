---
id: cli
title: "CLI"
kind: domain
domain: cli
capabilities:
  - agent-first-ux
  - machine-json
  - listing-contracts
  - cloud-auth
  - watch
  - inbox
  - calendar
tags:
  - cli
  - agents
  - json
applies_to:
  - src/cli
  - src/cli/commands
owners:
  - ravi-dev
status: draft
normative: true
---

# CLI

## Intent

Ravi CLIs are operational tools for humans and agents.

They must be predictable under load, safe to call from runtime, and easy for an
agent to recover from when output is large.

## Invariants

- Machine-consumed commands MUST support `--json`.
- List commands MUST NOT return unbounded data by default.
- Human output SHOULD be compact and show the next useful command.
- JSON output SHOULD expose the same semantic fields across commands when the
  operation shape is the same.
- Commands that can grow with system history SHOULD support pagination,
  filtering, and sorting.
- Dangerous or expensive full-history scans MUST require explicit flags.
- Cloud authentication rules for linking local Ravi to a Console-compatible
  service live in `cli/cloud-auth`.
- Public CLI commands exposed through the SDK/OpenAPI surface MUST declare an
  explicit typed return contract with `@Returns(...)` or a binary contract with
  `@Returns.binary()`.
- Commands that cannot be represented as request/response SDK calls MUST be
  marked `@CliOnly()` instead of leaking loose shapes into OpenAPI.
- The known public return-schema debt MUST be tracked by the exact baseline in
  `src/sdk/client-codegen/return-schema-baseline.ts`. Adding a new public
  command without `@Returns(...)` MUST fail tests.
- Return-schema migration state MUST be tracked in the local
  `cli_return_schema_commands` table managed by `ravi sdk returns`. A command
  is not fully migrated until it reaches `reviewed` with a schema hash matching
  the live registry.
- OpenAPI emitters MUST preserve declared response types. `@Returns.binary()`
  MUST emit an `application/octet-stream` response with `format: binary`, not a
  loose JSON object.

## Return Schema Migration

The return-schema migration is intentionally stateful because the CLI surface is
large. The local state machine has these states:

- `discovered`: public command is known and still lacks `@Returns`.
- `in_progress`: a typed return contract is being authored.
- `blocked`: the command shape or command semantics need design work before it
  can be typed.
- `typed`: the command has `@Returns(...)` or `@Returns.binary()` in the live
  registry.
- `validated`: focused tests or command fixtures validate the schema.
- `reviewed`: final review accepted the schema. The stored schema hash must
  keep matching the live registry.
- `not_applicable`: true local-only command marked `@CliOnly()`. This is the
  exception of the exception: use it only for foreground processes, infinite
  streams/watchers, interactive terminal clients, or handlers that cannot be a
  request/response contract. Do not use `@CliOnly()` to avoid typing a
  structured return.
- `removed`: command no longer exists in the live registry.

Declaring any `@Returns(...)` is not enough. Public SDK/OpenAPI return schemas
MUST be concrete: no `z.unknown()`, `z.any()`, `z.array(z.unknown())`, empty
passthrough objects, records of unknown, or arbitrary `additionalProperties`
as the final contract. Temporary weak schemas MUST be tracked in
`return-schema-quality-baseline.ts`; adding a new weak public return schema is
a regression.

Operators SHOULD use:

- `ravi sdk returns status --json` to inspect coverage.
- `ravi sdk returns list --kind missing --json` to page through debt.
- `ravi sdk returns mark <command> --state in_progress --task <id>` to attach
  implementation work.
- `ravi sdk returns validate --json` before finishing a return-schema batch.
- `ravi sdk returns validate --strict --json` for final review. Strict mode MUST
  fail on weak-schema baseline debt, unreviewed typed public schemas, and any
  remaining `@CliOnly()` command so those exceptions cannot silently disappear
  from docs/SDK.
