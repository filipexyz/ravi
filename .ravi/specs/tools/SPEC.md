---
id: tools
title: "Tools"
kind: domain
domain: tools
capabilities:
  - registry-discovery
  - safe-test
  - explicit-execution
  - search
tags:
  - tools
  - cli
  - sdk
  - safety
applies_to:
  - src/cli/commands/tools.ts
  - src/cli/tool-definitions.ts
  - src/cli/tools-export.ts
  - src/cli/registry-snapshot.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Tools

## Intent

The tools domain exposes the CLI command registry for discovery, inspection, safe
planning, and explicit execution. Operators and agents must be able to find tools
by intent, understand their contract, and plan invocations without triggering side
effects.

## Invariants

- Discovery commands (`tools list`, `tools search`, `tools show`, `tools manifest`,
  `tools schema`) MUST be read-only and MUST NOT call `tool.handler`.
- `tools test` MUST be a dry-run/plan by default. It MUST NOT execute the tool
  handler.
- Real execution MUST require an explicit command (`tools invoke`).
- `tools invoke` MUST preserve existing runtime enforcement: command access, scope,
  skill gate, and runtime authorization. It MUST NOT be an authorization bypass.
- `tools invoke` MUST be annotated with mutating/high access metadata reflecting
  the fact that it can execute arbitrary tool handlers.
- Search MUST be local, deterministic, bounded, and JSON-parseable.
- SDK-facing tools commands MUST have concrete `@Returns(zod)` schemas.

## Sub-Specs

- `tools/registry`: contract for registry extraction, search, and discovery.
