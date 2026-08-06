---
id: cli/sync
title: "Sync agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - sync
tags:
  - cli
  - sync
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/sync.ts
  - src/sync/console-bridge.ts
  - src/sync/db.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Sync agent-first CLI contract

## Intent

Make `ravi sync` (local-first outbox/inbox and the Console bridge) reliable
for agent consumers under the agent-first contract defined by `cli`:
typed error envelopes, the 0/1/2/3 exit taxonomy, a write brake on the bulk
transfers, and a not-found envelope on row inspection. `push` and `pull` move
data in bulk between the local install and Console — the highest-blast-radius
ops of the domain — so both are braked.

## Invariants

1. With `--json`, every failure raised by the contract layer MUST return the
   envelope `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy (write brake).
3. `sync push` and `sync pull` MUST default to dry-run and require
   `--execute`; the dry-run MUST report `dryRun: true` and a plan built from
   the cheap local status summary (filters + `outboxPending`/`outboxFailed`
   for push, `inboxPending`/`inboxFailed` for pull), and MUST NOT create the
   Console bridge, enqueue trace batches, upload, download, or apply anything.
4. The brake fires BEFORE any side effect: with `--traces`, even the local
   `enqueueTraceExportBatch()` write MUST NOT happen on a dry-run.
5. `sync inspect <id>` on an unknown row MUST exit 1 with
   `SYNC_RECORD_NOT_FOUND`; row ids are opaque ULIDs, so the envelope carries
   a `suggestedAction` pointing at `ravi sync status --json` instead of noisy
   similarity suggestions.
6. `sync retry` is declared UNBRAKED: it only moves failed/dead rows back to
   `pending` locally (reversible bookkeeping); the actual upload still goes
   through the braked `push`.
7. `sync status` stays a plain read; unlinked installs report
   `linked: false` with exit 0.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| push | bulk upload of local events (+ optional local trace enqueue) to Console (high) | dry-run + `--execute` |
| pull | bulk download AND local apply of remote events (high) | dry-run + `--execute` |
| retry | local status flip failed/dead → pending (reversible) | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| sync row not found | `SYNC_RECORD_NOT_FOUND` + suggestedAction | 1 |
| braked push/pull without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

The daemon sync runner (`RAVI_SYNC_RUNNER_ENABLED`) pushes/pulls through the
service-layer bridge, not through the CLI, so the brake does not affect
automated sync ticks. `cli/console-scope` notes that `sync push --json` keeps
organization scope unless a project is explicitly supplied — unchanged by this
contract. There is no shipped `sync` skill — lacuna registrada; the CLI
`--help` plus this spec are the teaching surface.

## Validation

- `bun test src/cli/commands/sync.test.ts` green (contract describes
  included; runs on an isolated `RAVI_STATE_DIR`).
- `bun run typecheck` clean.

## Known Failure Modes

- Parser usage errors use the global exit-2 `USAGE_ERROR` envelope because the
  `sync` root is registered in `AGENT_CONTRACT_DOMAINS`.
- Before this contract, `sync inspect <unknown-id>` returned
  `{found:false, id}` with exit 0 — an agent scanning exit codes never saw the
  miss. The declared return schema keeps the `found:false` variant for SDK
  compatibility, but the CLI now emits the exit-1 envelope instead of
  returning it.
- Putting the brake AFTER `createConsoleSyncBridge()`/`enqueueTraceExportBatch()`
  would leak side effects into dry-runs (trace batches enqueued locally); the
  brake must stay the first statement after option parsing.
