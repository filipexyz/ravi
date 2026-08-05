---
id: daemon/restart/crash-recovery/runbook
title: Abrupt Crash Recovery Runbook
kind: runbook
domain: daemon
capability: restart
feature: crash-recovery
status: active
normative: false
---

# Abrupt Crash Recovery Runbook

## Current Phase

The contract-and-ledger child is storage-only. It does not run a startup sweep and does not resume sessions. Until the later inspect/apply CLI exists, do not mutate live recovery rows manually to force a replay.

## When A Crash Leaves Running Turns

1. Preserve the database and runtime trace; do not delete stale `session_turns` rows.
2. Determine whether shutdown was graceful. Graceful restart remains governed by `daemon/restart/active-session-resume`.
3. Treat a `running` trace row without an abandoned boot, expired attempt lease, durable request/checkpoint, and safe markers as inspection evidence only.
4. If a tool may have started, output may have materialized, ownership is ambiguous, or the producer is recurring, fail closed and wait for the later recovery classifier/manual-review surface.
5. Send any manually authorized continuation back through the session dispatcher. Never invoke a provider directly.

## Ledger Diagnosis

For development and hermetic tests, verify these relationships:

- `runtime_boot_epochs.boot_epoch` owns attempt and queue leases.
- `runtime_turn_attempts.attempt_id` identifies a delivery attempt; `turn_id` is not unique.
- `runtime_prompt_queue.queue_sequence` establishes durable FIFO order inside `session_key + lane_key`.
- `runtime_recovery_candidates` records each run's evaluation.
- `runtime_recovery_claims.candidate_key` is globally unique across apply runs.

An apply claim is valid only when:

- the recovery run is `running` and mode `apply`;
- the claiming boot is active and its lease remains live;
- the candidate belongs to that run;
- the underlying attempt or queue item is still unclaimed.

Once the claim is acquired, the source is fenced from normal heartbeat, safety, terminal, and queue-CAS mutations. Do not clear `recovery_claim_id` or mutate the source manually to let an old owner continue; finish or fail the durable claim instead.

Abandon a prior boot only with the heartbeat and lease values read during the same inspection decision. If either value changed, re-read and reclassify. Likewise, an owner-bound queue transition must carry the observed boot, lease owner token, and lease expiry; a lost CAS is a normal signal to stop, not a reason to force the update.

Queue delivery must advance through lease and starting ownership before `delivered`, and its target attempt must still be running, unexpired, and unclaimed. Never move a delivered row back to `leased`; a later attempt must be represented by the recovery ledger and the later dispatcher integration. Treat an immutable-fingerprint mismatch, an invalid persisted lifecycle value, or a partial claim projection as corruption requiring inspection, never as safe replay evidence.

Candidate keys are generated from durable source identity. Do not invent aliases or recycle a key across an attempt and queue item. A recovery run is terminal only after all apply candidates are `applied`, `failed`, or `not_applied`.

Inspect and dry-run must never create a claim.

## Development Validation

```bash
ravi specs sync --json
ravi specs get daemon/restart/crash-recovery --mode full --json
bun test src/runtime/crash-recovery-store.test.ts
bun run typecheck
bun run build
```

The later feature phases add dispatcher, session trace, CLI, and crash-harness validation. Do not report those as covered by the ledger-only child.
