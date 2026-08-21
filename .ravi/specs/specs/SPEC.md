---
id: specs
title: "Ravi Specs"
kind: domain
domain: specs
capabilities:
  - indexing
  - context
  - projects
tags:
  - memory
  - governance
applies_to:
  - .ravi/specs
  - src/specs
  - src/specs/facade.ts
  - src/cli/commands/specs.ts
  - docs/ravi-specs-memory-prd.md
owners:
  - ravi-dev
status: active
normative: true
---

## Ravi Specs

## Intent

Ravi Specs is the durable rules memory for the codebase. It protects business rules, feature invariants, operational decisions, and validation knowledge in Markdown that agents can read before changing code.

## Invariants

- Specs MUST be stored as Markdown files under `.ravi/specs`.
- `SPEC.md` MUST be the source of truth for each spec. Any generated index MUST be rebuildable from Markdown.
- Spec ids MUST use at most three semantic levels: `domain`, `domain/capability`, or `domain/capability/feature`.
- The spec `kind` MUST match id depth: one segment is `domain`, two segments are `capability`, three segments are `feature`.
- Specs MUST use normative language (`MUST`, `MUST NOT`, `SHOULD`, `MAY`) for rules that agents are expected to follow.
- Companion files SHOULD use Diataxis roles: `WHY.md` for rationale, `RUNBOOK.md` for operational steps, and `CHECKS.md` for validation.
- `ravi specs` commands MUST support `--json` so agents can consume them without parsing human output.
- `specs facade plan` MUST NOT create directories, files, index rows, or other durable state.
- A facade plan MUST bind canonical `cwd`, the `.ravi/specs` root, the Ravi database target, normalized input, intended effects, and current safety blockers into `planHash`.
- A blocked facade plan MUST become stale when its blocker set changes and MUST be planned again before apply.
- Mutation MUST use strict current-plan freshness. Observation of an originally executable `new` plan MUST still classify later target changes as divergent.
- Facade `new` MUST block when ancestor `SPEC.md` files are missing and MUST reject orphan targets or symbolic links without overwrite.
- Facade exact replay MUST reject unexpected files in the target and MUST expose them through the blocker and readback.
- A new spec quartet MUST become visible as one directory promotion; a failed write MUST NOT expose a partial target quartet.
- Reapplying an identical facade `new` plan to an exact target MUST return `noop`; legacy `new` MUST preserve both its existing collision error and its compatibility behavior for a pre-created directory without `SPEC.md`.
- `sync` MUST compare source and index before replacement and MUST report whether the index changed.
- Facade `sync` MUST replace the index from the exact captured plan snapshot, without rereading Markdown between validation and write.
- The facade database binding MUST be canonical and MUST reject observed symbolic-link components before writes.
- Public facade schemas MUST correlate each operation with only its valid input, target, effects, observation, state, readback, verification, and recovery shapes.
- Facade `readback`, `verify`, and `recover` MUST be read-only and MUST expose file targets, ancestors, and index state. Recovery MUST NOT replay an effect.
- Project links MAY attach specs as context, but specs MUST remain reusable outside any single project.
- The new specs system MUST remain separate from the legacy `src/spec` planning flow until that legacy flow is intentionally removed.

## Validation

- `bun src/cli/index.ts specs list --json`
- `bun src/cli/index.ts specs get specs --mode full --json`
- `bun src/cli/index.ts specs sync --json`
- `bun test src/specs/service.test.ts src/specs/facade.test.ts src/cli/commands/specs.test.ts src/cli/commands/projects.test.ts src/cli/commands/json-coverage.test.ts`
- `bun run typecheck`
- `bun run build`

## Known Failure Modes

- A hand-maintained registry drifts from the Markdown files and agents follow stale rules.
- A feature rule is buried in a project note and never consulted by agents working outside that project.
- A spec id is renamed without updating project links or generated indexes.
- A command prints only human text and forces agents to scrape stdout.
- The new `src/specs` domain is confused with legacy `src/spec`, causing accidental coupling to the old planning runtime.
- A plan is generated in one workspace or state directory and applied against another target.
- A broad catch converts a typed facade usage error into a generic execution error.
- A second source scan writes data that was never approved by the copied sync hash.
- Independent unions let a generated client combine a `new` operation with a `sync` target or result.
