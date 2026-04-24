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
  - src/cli/commands/specs.ts
  - docs/ravi-specs-memory-prd.md
owners:
  - ravi-dev
status: active
normative: true
---

# Ravi Specs

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
- Project links MAY attach specs as context, but specs MUST remain reusable outside any single project.
- The new specs system MUST remain separate from the legacy `src/spec` planning flow until that legacy flow is intentionally removed.

## Validation

- `bun src/cli/index.ts specs list --json`
- `bun src/cli/index.ts specs get specs --mode full --json`
- `bun src/cli/index.ts specs sync --json`
- `bun test src/specs/service.test.ts src/cli/commands/specs.test.ts src/cli/commands/projects.test.ts src/cli/commands/json-coverage.test.ts`
- `bun run typecheck`
- `bun run build`

## Known Failure Modes

- A hand-maintained registry drifts from the Markdown files and agents follow stale rules.
- A feature rule is buried in a project note and never consulted by agents working outside that project.
- A spec id is renamed without updating project links or generated indexes.
- A command prints only human text and forces agents to scrape stdout.
- The new `src/specs` domain is confused with legacy `src/spec`, causing accidental coupling to the old planning runtime.
