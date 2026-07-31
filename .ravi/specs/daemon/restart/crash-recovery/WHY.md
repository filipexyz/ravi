---
id: daemon/restart/crash-recovery/why
title: Why Abrupt Crash Recovery Uses A Separate Ledger
kind: why
domain: daemon
capability: restart
feature: crash-recovery
status: active
normative: false
---

# Why Abrupt Crash Recovery Uses A Separate Ledger

## Problem

An intentional restart can snapshot the dispatcher's in-memory state. An abrupt process or machine crash cannot. After reboot, Ravi may still have a `running` trace row even though ownership, pending prompt atoms, tool state, and external effects are unknown.

Replaying that row is unsafe. It may duplicate a tool call or response, resume recurring work that should wait for its next schedule, or race another live boot.

## Decision

Use an append-oriented ledger separate from `session_turns`:

- boot epochs prove process ownership and whether shutdown was graceful;
- per-delivery attempts carry leases and monotonic safety markers;
- prompt atoms retain their original ordering and barriers;
- recovery runs and candidates retain decisions and results;
- a global transactional claim prevents duplicate apply across sweeps.

`session_turns` remains valuable evidence, but evidence is not replay authority.

## Why Attempts Are Not Turns

A logical turn may be delivered more than once across provider or process recovery. Making `turn_id` the attempt primary key would collapse distinct ownership and safety histories. The ledger therefore assigns an `attempt_id` to each delivery while retaining `turn_id` as a reference.

## Why Instrumentation Lives In The Host

The shared prompt generator is the last boundary before Claude, Codex, or Pi consumes input. Persisting the attempt there gives every adapter the same ordering without teaching adapters about recovery policy. The host owns event projection, restart, shutdown, and some tool authorization boundaries; where an adapter executes tools before an acknowledged host callback, the attempt must record that weaker fence and fail closed instead of inferring safety from a missing event.

## Why Native Steer Is Temporarily Disabled

Steer and follow-up controls add physical provider input after the immutable attempt request was recorded. Calling them without an append-only input journal would make a crashed attempt look replayable while omitting part of what the provider actually received. Routing normal inbound prompts through the host queue preserves a complete handoff until durable queue/input journaling lands.

## Why Queue Order Is Explicit

Timestamps can collide and do not encode a stable SQLite insertion order. A durable monotonic sequence lets the runtime preserve FIFO within a lane after reboot while still allowing the dispatcher to apply its documented cross-lane barrier policy.

## Why Claims Are Separate

Candidate audit is per recovery run, so the same candidate can appear in inspect, dry-run, and later apply histories. Claim ownership must span those runs. A separate claim keyed by logical candidate makes apply idempotent without erasing prior evaluations.

The key is derived from the durable source identity. Letting a caller choose aliases would turn an accidental collision into lost work or let one source acquire multiple claims under different names.

## Why Lease Fencing Is Explicit

Checking only `status=active` cannot distinguish a current owner from a stale process after renewal or takeover. Boot abandonment compares the exact observed heartbeat and lease, and owner-bound queue transitions compare the boot, owner token, and lease expiry. This makes stale observations lose safely under SQLite's transactional write boundary.

A recovery claim is also a fence: once recovery owns a source, the original attempt or queue owner cannot keep heartbeating, terminalize it, or advance delivery concurrently. The normal mutation SQL repeats the unclaimed predicate so a check/update race also loses safely.

## Why Prompt Fingerprints Are Revalidated

Comparing a retry only with the fingerprint column would trust the digest and payload columns to remain synchronized. Recomputing the fingerprint from each persisted prompt atom detects valid JSON that changed independently and prevents a corrupt payload from being treated as the original deduplicated work.

## Alternatives Rejected

- **Replay every recent running turn:** cannot distinguish live, stale, unsafe, or already materialized work.
- **Reuse graceful restart snapshots only:** those snapshots do not exist after an abrupt crash.
- **Delete stale trace rows:** destroys evidence and does not make replay safe.
- **Let providers resume themselves:** leaks Ravi queue, task, and delivery policy into adapters.
- **Exactly-once promise:** impossible for arbitrary external effects without producer-owned idempotency.

## Sequencing

The ledger lands first. Host boot/attempt instrumentation lands second, before queue persistence, classifier, sweeper, CLI, and crash harness. The second cut produces trustworthy live ownership evidence but deliberately does not interpret or replay expired evidence.

The instrumentation must fence the earliest real authorization boundary, not assume a later provider event is write-ahead. Claude uses `bypassPermissions`, so `canUseTool` alone is insufficient; a final catch-all `PreToolUse` persists `started_tool` and denies the tool if the marker or ownership recheck fails. Codex currently runs normal tools with `approvalPolicy=never`, and Pi can execute before Ravi consumes its start event, so both persist `toolEffectFence=provider_event_only` at handoff and their current physical turns are conservatively non-replayable even with both markers false. Provider and dispatcher terminal paths still share one first-terminal status and timestamp so concurrent abort cannot contradict an already durable physical attempt.

Provider-native raw events are also an external boundary when they contain assistant text or tool activity. Normalized safety events therefore precede any matching raw projection; assistant content discarded by response policy is not leaked through the raw stream. External approval and user-input polls are fenced immediately before each real publication for the same reason.

The existing graceful restart path cannot blindly append “continue de onde parou” once the host has durable unsafe or terminal evidence. Explicit `continue`, `pending_only`, and `skip` modes preserve independent successors without semantically replaying the consumed physical turn. Missing caller snapshots also resolve to `skip`, because an earlier snapshot write may have failed after the restart epoch was created. This consumes instrumentation evidence but does not perform abrupt-crash classification or recovery.

For the same reason, task status and a recent assignment cannot independently authorize a new provider turn at bot startup. The legacy task-resume producer is disabled until the classifier can correlate the task with its abandoned attempt and durable checkpoint; logical task freshness is useful classification input, not a safety fence.

Once a cached lease is expired, the host must behave as a stale owner even if its periodic heartbeat callback has not run yet. Stopping intake and NAKing before ACK preserves upstream work while the poisoned boot is diagnosed or restarted.
