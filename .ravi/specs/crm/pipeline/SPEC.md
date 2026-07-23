---
id: crm/pipeline
title: "CRM Pipeline Canonical Metadata Schema"
kind: capability
domain: crm
capabilities:
  - pipeline
tags:
  - crm
  - pipeline
  - metadata-schema
  - declarative
applies_to:
  - src/crm/pipeline-metadata.ts
  - src/cli/commands/crm.ts (CrmPipelineCommands group)
owners:
  - ravi-dev
status: active
normative: true
---

# CRM Pipeline Canonical Metadata Schema

## Intent

`pipeline.metadata` is the declarative contract that drives engine consumers (dispatcher gates, precondition engine, TTL sweep, VIP guard, send-window validator, régua tag engine). Before this spec, `metadata` was free-form `Record<string, unknown>` and each agent invented its own keys — drift, no validation, no help.

This spec defines:
1. The canonical TypeScript schema (`src/crm/pipeline-metadata.ts`).
2. The JSON Schema export (Draft-07) for documentation/CI.
3. The introspection model used by `ravi crm pipeline review/validate/show --explain`.

**See:** PR body in `feat/crm-pipeline-schema` branch + `/home/ravi/ravi/main/meetings/CRM-KISS-MVP-V2-HIBRIDO-2026-06-16.md`.

## Invariants

- **I1 Backward compat:** `pipeline.metadata` without any of these fields MUST keep working identically to legacy behavior. Validator returns `ok: true` for `{}`.
- **I2 Passthrough preservation:** unknown top-level keys MUST be preserved (not stripped). Schema uses `.passthrough()` at root; stage-level uses `.passthrough()` so per-stage extensions are also preserved.
- **I3 Optional everything:** every documented field is optional. Required fields exist only INSIDE structured sub-objects when their parent is declared (e.g. `send_window.hours` is required IF `send_window` is declared).
- **I4 Fail-open per type:** the precondition engine (consumer of `stages[X].preconditions[]`) MUST fail-open when a `type` is unknown — log warning, treat as PASSED, never block outbound.
- **I5 Fail-open per missing data:** consumer engines (frequency_anomaly, seasonality) MUST treat missing derivations data (null/undefined) as PASSED.
- **I6 Stage key consistency:** validator MUST warn (not error) when `stages[X].key` does not match a runtime stage; warnings DO NOT block the metadata write.
- **I7 Schema additions are non-breaking:** new optional fields can be added in a minor version. Removing or renaming fields requires a major version + migration plan.
- **I8 Engine consumers MUST tolerate absence:** every engine that reads metadata MUST gracefully handle the missing-field case (no exceptions).

## Validation

- `bun test src/crm/pipeline-metadata.test.ts` — 14+ tests covering empty/partial/full/invalid metadata, passthrough, stage key drift, warnings.
- `ravi crm pipeline validate <id>` — runtime validation against any pipeline (FAIL exit 1 if schema errors).
- `ravi crm pipeline review <id>` — structured 12-field report (✓/✗/⚠ + suggestions).
- `ravi crm pipeline show <id> --explain` — render metadata with field-by-field impact narrative.

## Known Failure Modes

- **FM-01:** Stage key drift between metadata declaration and runtime stage records. Mitigation: `validate` warns (does not block); `review` flags as `partial`. Long-term: CI step that fails if drift detected.
- **FM-02:** Free-form metadata accumulated before this spec — old pipelines with unstructured keys remain valid (passthrough). Migration to canonical keys is optional and incremental.
- **FM-03:** Precondition engine evaluates types unknown to it. Mitigated by I4 fail-open + log warning.
- **FM-04:** `derivations.delta_freq_pct` returns null for contacts without baseline. Mitigated by I5 fail-open.
- **FM-05:** New precondition type added without engine handler. Mitigated by I4 — engine treats unknown as PASSED, surfaces in logs for backfill.

## Adoption Path

1. Pipelines without `metadata` keys: zero change. Engine consumers see no fields → no-op.
2. Pipelines that opt in: add fields incrementally; rollback at any time by removing the field.
3. Migration scripts may bulk-add defaults (see `scripts/migrate-pipeline-metadata.ts`).

## References

- Source: `src/crm/pipeline-metadata.ts`
- Tests: `src/crm/pipeline-metadata.test.ts`
- CLI: `src/cli/commands/crm.ts` (`CrmPipelineCommands` group)
- Engine consumers: see PRD `/home/ravi/ravi/main/meetings/CRM-KISS-MVP-V2-HIBRIDO-2026-06-16.md`
