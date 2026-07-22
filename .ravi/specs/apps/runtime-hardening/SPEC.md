---
id: apps/runtime-hardening
title: "Ravi App Runtime Hardening"
kind: capability
domain: apps
capabilities:
  - runtime-hardening
tags:
  - apps
  - runtime
  - safety
  - reliability
applies_to:
  - src/apps/types.ts
  - src/apps/service.ts
  - src/apps/router.ts
  - src/cli/commands/apps.ts
owners:
  - ravi-dev
status: active
normative: true
lifecycle: active
implementation_status: in_progress
implemented_by:
implemented_at:
implementation_notes:
open_items:
decision_makers:
  - ravi-dev
consulted:
  - apps/manifest
  - apps/router
informed:
  - Ravi App authors
---

# Ravi App Runtime Hardening

## Intent

Make every Ravi App operation predictable for agents: mutations fail closed,
failures remain machine-actionable, readiness is observable, and transient
retries cannot duplicate writes.

## Context / Decision Drivers

The app router is shared by independently shipped Apps. A weak default in this
layer is multiplied across every current and future App. The contract therefore
belongs to the router and manifest, with adapter-specific details kept inside
each App.

## Invariants

- **R1** — Every executable operation MUST explicitly classify `mutating`.
  Missing classification fails before process launch. A mutating operation MUST
  declare a top-level safety contract and MUST NOT run unless either `--dry-run`
  is supported or explicit confirmation is present. The router MUST consume its
  own control flags instead of forwarding them to the child command; flags after
  `--` belong to the child.
- **R2** — A mutating operation with live execution disabled MUST remain blocked
  even when confirmation is present. No write receives automatic retry.
- **R3** — Operation failures MUST expose `ravi.app.failure/v1` with stable
  `code`, `category`, `message`, `retryable` and `exitCode`. Public details are
  allowlisted to source, HTTP status and retry delay; raw child output and
  upstream bodies MUST NOT be copied into a failure. The legacy error string
  remains for compatibility.
- **R4** — CLI-backed operations MUST have a bounded timeout. Retry MAY occur
  only for non-mutating operations declared idempotent in the top-level safety
  contract, up to three attempts, and only for timeout or HTTP
  `429/502/503/504`. Help metadata and arbitrary child `retryable=true` MUST NOT
  authorize a retry. `Retry-After` is honored with a bounded 30 second wait.
- **R5** — Discovery, list, show, help and manifest check MUST remain side-effect
  free. Executable health belongs to an explicit `readiness` operation. A check
  executes only when it declares an id, `required`, `sideEffectFree=true` and a
  supported builtin/CLI contract. Aggregation MUST distinguish `ready`,
  `degraded`, `not_ready` and `unknown`.
- **R6** — Machine output MUST be deterministic: `--json` rejects malformed
  child JSON, reports attempts, and MAY project up to 50 requested dotted fields
  across object or array-of-object results without changing the default payload.
  The router MUST emit one complete JSON document and a failure MUST use its
  declared non-zero exit code.
- **R7** — App and operation help MUST be bounded and useful without executing
  the App. Full manifest detail remains available through `show --json`.
- **R8** — List operations MUST be bounded by default. Auto-pagination is
  adapter-owned unless the manifest declares a complete pagination contract;
  generic router retry MUST NOT be mistaken for pagination.
- **R9** — A declared `outputSchema` MUST resolve and compile during manifest
  checking. At runtime it validates the canonical adapter result before
  publication. `--fields` is an explicit partial view applied after that
  validation and does not claim to satisfy the complete adapter schema.

## Boundaries

In scope: manifest validation, router preflight/execution, CLI result schemas,
readiness and representative App contracts. Out of scope: enabling currently
disabled live writes, changing NATS events, changing database schema, or
rewriting existing App CLIs.

## Acceptance Criteria

Every invariant MUST have a row. Without this table the spec MUST NOT be `normative: true`.

| Invariant | Verification Method | Check Ref | Pass Condition |
|-----------|---------------------|-----------|----------------|
| R1 | Test | CHECKS.md#C1 | Missing mutation classification, confirmation or safety blocks before process launch; supported preview runs and child passthrough remains available after `--`. |
| R2 | Test | CHECKS.md#C2 | Live-disabled and all write retry cases remain blocked. |
| R3 | Test | CHECKS.md#C3 | Typed child/core failures publish the versioned allowlisted contract and retain the legacy string. |
| R4 | Test | CHECKS.md#C4 | Timeout is bounded; only allowlisted transient failures on top-level idempotent reads retry; write/help/arbitrary child hints never retry. |
| R5 | Test | CHECKS.md#C5 | Check/help do not execute; readiness executes only explicit safe checks and aggregates four statuses. |
| R6 | Test | CHECKS.md#C6 | Invalid JSON fails and object/array field projection is deterministic while absent `--fields` preserves the original result. |
| R7 | Test | CHECKS.md#C7 | App/operation help is compact, stable and execution-free. |
| R8 | Inspection | CHECKS.md#C8 | Every growing list is bounded or carries an explicit pagination contract. |
| R9 | Test | CHECKS.md#C9 | Missing/invalid schemas fail manifest checks; valid, invalid and projected results respect the canonical-result boundary. |

Verification Method is one of: `Test` | `Demonstration` | `Inspection` | `Analysis`.

## Adaptation

No open adaptation decisions. Any decision this spec cannot resolve up-front MUST take
one of these paths (never a bare TBD):

- (a) become a spike sub-task with its own acceptance criteria before implementation dispatch; or
- (b) declare `resolution_deadline: <date>` + `blocking_for: [Rk, ...]`; or
- (c) be reported back as an explicit update to this spec before `done`.

## Known Failure Modes

- Treating `mutating` as documentation instead of an execution gate.
- Retrying a write after a timeout and duplicating an external mutation.
- Reporting an App ready because its manifest parses while its dependency is unavailable.
- Returning exit zero after a child promised JSON but printed prose or a stack trace.
- Accepting an unavailable output schema until the first production execution.
- Killing only a shell parent while a timed-out descendant continues running.
- Executing health or App code during discovery.

## Governance

- Safety semantics are additive in `ravi.app/v1`; older Apps remain discoverable
  but undeclared mutating operations fail closed at execution.
- Enabling live execution for a previously preview-only App remains a separate
  human-approved cutover.

## Changelog

- 2026-07-21: initial cross-App runtime hardening contract.
