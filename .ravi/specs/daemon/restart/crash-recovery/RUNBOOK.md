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

The contract/ledger and boot-attempt instrumentation are implemented. A running daemon now owns a boot lease and records each provider delivery with safety/terminal evidence. It still does not run a startup sweep or resume sessions. Until the later inspect/apply CLI exists, do not mutate recovery rows manually to force a replay.

If the coordinator loses a boot, attempt, marker, or terminal fence, the host fails closed: active attempts are aborted, runtime sessions are closed, and the prompt consumer NAKs before ACK instead of accepting more work. The poisoned boot is not marked graceful. Treat this as a runtime/storage incident; do not bypass the coordinator or the write-ahead input-mutation fence to continue work.

A failure before provider handoff keeps the unconsumed prompt in the host stash and may use only the existing bounded event-loop restart path. If the coordinator itself no longer owns a live lease, no automatic retry is allowed, but the exact envelope remains available to the shutdown snapshot instead of being discarded during event-loop cleanup.

The existing graceful daemon-restart snapshot now consumes the same safety fence. It may continue a replay-safe current turn, resume only independently queued durable successors, or suppress the session (`continue`, `pending_only`, `skip`). `pending_only` never appends the generic “continue de onde parou” instruction, a provider-terminal turn is always considered consumed, and a caller restart epoch with no snapshot is `skip`. This is a guard on graceful restart compatibility, not the later abrupt-crash sweeper.

The former `RaviBot.start()` heuristic that resumed every fresh active task is disabled in this phase. Do not re-enable it from task recency/status: the later classifier must first prove attempt safety and record the recovery decision. A task can remain `in_progress` while its physical provider turn is unsafe to replay.

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
- `runtime_turn_attempts.started_tool` and `materialized_output` are write-ahead evidence only where the host owns the boundary. Claude's final catch-all `PreToolUse` denies execution when its marker cannot persist, including under `bypassPermissions`. Attempt metadata `toolEffectFence=provider_event_only` means asynchronous provider events cannot prove the absence of an earlier effect; Codex/Pi current turns are therefore suppressed while independent successors may remain eligible.
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
bun test src/runtime/crash-recovery.test.ts src/runtime/prompt-subscription.test.ts src/runtime/delivery-queue.test.ts src/runtime/control-host.test.ts
bun test src/approval/service.test.ts src/runtime/control-host.test.ts src/runtime/session-trace.test.ts src/runtime/session-dispatcher.test.ts src/runtime/daemon-restart-resume.test.ts src/bot.runtime-guards.test.ts
bun run typecheck
bun run build
```

The later feature phases add live queue persistence, classifier/claims execution, sweeps, CLI, and crash-harness validation. Do not report those as covered by the instrumentation child.
