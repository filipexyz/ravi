---
id: cli/work-objects
title: "Work Objects agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - work-objects
tags:
  - cli
  - work-objects
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/work-objects.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Work Objects agent-first CLI contract

## Intent

Make `ravi work-objects` reliable for agent consumers under the agent-first
contract defined by `cli`: typed error envelopes, the 0/1/2/3 exit
taxonomy, and a write brake on `action` — the one op whose blast radius the
CLI cannot inspect, because the actionId is executed by a domain adapter with
provider-defined semantics. The domain contract for adapters themselves stays
in `work-objects/SPEC.md`; this spec covers only the CLI surface.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. `resolve`, `update`, `action` and `suggest` MUST exit 1 with
   `WORK_OBJECT_NOT_FOUND` when no domain adapter handles the reference
   (service returns `undefined`). The envelope carries a `suggestedAction`
   pointing to the adapter-backed listing (`ravi tasks list --json` today)
   instead of `suggestions` — there is no cheap local enumeration across
   adapters.
4. `work-objects action` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and the `plan` (ref + actionId + value)
   and MUST NOT call any adapter. Argument validation (`type`, `id`,
   `actionId` non-empty) happens BEFORE the brake.
5. `work-objects update` is declared UNBRAKED and keeps immediate-write
   behavior: it is a field-validated structured patch with an optimistic
   `--revision` guard, whose adapter returns `fieldErrors`/`formError`
   instead of blind writes.
6. There is no listing op in this domain, so there is no `--fields` surface
   (declared; compact mode does not apply).
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| action | executes an opaque provider actionId (may complete/archive/fail external work) | dry-run + `--execute` |
| update | field-validated patch, optimistic revision guard, adapter-owned validation | not braked (declared) |
| resolve / suggest | read | n/a |

## Official error cases

| case | code | exit |
|---|---|---|
| no adapter handles the reference | `WORK_OBJECT_NOT_FOUND` + suggestedAction | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| `action` without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

The CLI brake only covers the CLI surface: the daemon also executes
work-object actions over NATS (`ravi.work_objects.action`, see
`.ravi/specs/work-objects/RUNBOOK.md`) and that path is NOT braked — it is a
programmatic transport, not an agent typing a command. The examples in
`.ravi/specs/work-objects/RUNBOOK.md` and `CHECKS.md` teach `--execute` on
the braked op. No shipped skill teaches `ravi work-objects` today —
**skill gap registered**: a future skill MUST document the brake and the
not-found contract.

## Validation

- `bun test src/cli/commands/work-objects.test.ts` green (contract suite), no
  new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`):
  `work-objects action task <task-id> task.comment --value x --json` → exit 3
  + plan, comment NOT added; with `--execute` → added;
  `work-objects resolve --type ghost --id nope --json` →
  `WORK_OBJECT_NOT_FOUND`, exit 1.

## Known Failure Modes

- The service returns `undefined` (not an error) when no adapter claims a
  ref; failing only on thrown errors silently prints nothing — the CLI must
  branch on the `undefined` result.
- Adapter-level "not found" (e.g. the tasks adapter answering
  `formError: "Task not found"`) arrives as a SUCCESSFUL result envelope; the
  CLI must not re-classify it, or it would mask the adapter's structured
  field errors.
- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
