---
id: daemon/restart/crash-recovery/checks
title: Abrupt Crash Recovery Checks
kind: checks
domain: daemon
capability: restart
feature: crash-recovery
status: active
normative: false
---

# Abrupt Crash Recovery Checks

## Contract And Schema

- The spec inherits `daemon/restart` and explicitly complements graceful active-session resume.
- `session_turns.status=running` alone never authorizes replay.
- Every provider delivery has an `attempt_id`; `turn_id` may repeat across attempts.
- Boot state is one of `active`, `graceful_stopped`, or `abandoned`; active ownership has a heartbeat/lease and terminal transitions are monotonic.
- Attempt state is terminal once it leaves `running`.
- Tool-started and output-materialized markers only move from false to true.
- Prompt atoms retain session, lane, sequence, envelope, origin, delivery barrier, task barrier, pending id, dedupe key, and lease ownership.
- Recovery audit retains run, candidate, decision, reason, proposed action, claim, action status, and result.
- Claim identity is globally unique by logical candidate, not only within one run.
- Candidate keys are derived from their durable source identity, not accepted as caller-defined aliases.
- Boot abandonment and queue ownership changes are fenced by the exact observed lease state.

## Storage Behavior

- Reopening an initialized DB does not fail or recreate incompatible tables.
- Creating an attempt requires an active owning boot.
- A heartbeat cannot revive a terminal attempt or move its lease backwards.
- Attempt and queue leases cannot outlive their boot lease.
- An identical prompt enqueue retry is idempotent.
- A divergent prompt enqueue using the same dedupe key fails.
- Same-lane queue reads are FIFO by durable sequence, including equal timestamps.
- Queue lifecycle updates use compare-and-set semantics.
- An owner-bound queue update requires the observed boot, owner token, and lease expiry; stale owners lose the CAS.
- Queue delivery follows `leased -> starting -> delivered`; queued work cannot skip ownership and delivered work cannot be leased again.
- Queue transitions preserve immutable enqueue metadata and cannot deliver after the observed queue lease expires.
- A delivered queue row cannot reference an attempt from another session or boot owner.
- Delivery rejects target attempts that are terminal, expired, or already recovery-claimed.
- A persisted prompt atom is rejected if its recomputed immutable fingerprint differs, even when the modified JSON remains valid.
- A dry-run or inspect run cannot acquire a recovery claim.
- Two apply runs claiming the same candidate produce one durable winner.
- A two-process race against the same candidate produces one durable winner.
- The two-process race uses distinct live boots and a start barrier so global uniqueness is exercised across overlapping apply runs.
- Completing a claim does not make the candidate claimable again.
- A claimed attempt or queue row rejects normal owner mutations; only its recovery claim may advance recovery projections.
- Claim completion rejects partial attempt and queue projection divergence while preserving transactional rollback.
- Completing a recovery run decodes every candidate and fails closed on an unknown lifecycle value.
- Persisted safety booleans accept only `0` or `1` and otherwise fail closed.
- Divergent terminal retries, regressive timestamps, corrupt safety enums, and missing source projections fail closed.
- An apply run cannot complete with pending or claimed candidates.

## Runtime Instrumentation

- The boot epoch is created before subscriptions accept runtime prompts.
- One independent timer renews the boot first and every running attempt second; repeated safety markers do not write repeatedly.
- Boot/attempt lease expiry or any marker/terminal ownership failure makes the coordinator fail closed and notifies every active attempt.
- Every owner mutation rechecks the current clock after the store write, so a stalled host cannot mutate after lease expiry before its next timer tick.
- Boot and attempt renewals validate the previously observed lease before publishing the renewed record; an extended lease cannot resurrect a write that crossed the old expiry.
- Ownership loss stops prompt intake; an already delivered JetStream message is NAKed before ACK and never reaches the handler.
- Adapter request trace and attempt exist before the common message generator yields to the provider.
- A trace or attempt persistence failure prevents the yield and preserves the exact pending message in queue/stash even when the failed write also loses coordinator ownership; ownership loss forbids only local auto-retry.
- Attempt metadata preserves current model, request hashes, source, provenance, delivery/task barriers, and pending ids.
- Tool and output markers are persisted before their corresponding projection/emission boundary, including provider-native raw events.
- Accepted assistant output is emitted only after the marker; interrupted, silent, heartbeat, and no-response assistant raw content is not externalized.
- Claude's catch-all `PreToolUse` (including `bypassPermissions` tools), capability approval, and user-input polls share the durable marker fence and cannot return allow/answers after losing their attempt binding or marker write. Codex and Pi are recorded as `provider_event_only`; their current physical turn is non-replayable before any asynchronous tool marker arrives.
- Each real external poll is fenced immediately before publication; local/inherited decisions do not create false output evidence, and a multi-question request rechecks ownership before every poll.
- Unterminated turns with durable tool/output evidence are not stashed by timeout, credential retry, provider interruption, dispatcher restart, or daemon restart snapshot paths.
- A first-terminal latch retains safety markers after the active attempt binding is removed; daemon restart treats every provider-terminal physical turn as consumed.
- Graceful restart uses explicit `continue`, `pending_only`, or `skip` mode. `pending_only` contains only durable independent successors and never appends the generic continuation prompt; a caller without its expected snapshot is `skip`.
- Persisted pending successors remain separate atoms with their original pending id, source, actor metadata, task barrier, and delivery barrier when hydrated into an existing or starting runtime.
- Bot startup does not invoke the legacy task-status/recency resume producer; task continuation waits for a durable classifier decision.
- A durable-preparation failure stashes the still-unconsumed prompt before the failed runtime session releases its slot.
- Attempt terminalization is not skipped when the historical trace was already terminalized by the dispatcher.
- Provider and dispatcher terminal races share one first-terminal status and timestamp across the attempt and historical trace.
- Normal completion, failure, interruption, timeout, host abort, restart, and unterminated stream exit leave no running attempt owned by a graceful boot.
- Graceful shutdown terminalizes remaining attempts before terminalizing the boot and before database close.
- Implicit native steer and host `turn.steer|turn.follow_up` are rejected until durable input journaling exists; `turn.interrupt` remains available.

## Scope Guard

- Neither the first nor the second child persists the live dispatcher queue.
- Neither the first nor the second child adds a classifier, sweeper, resume/requeue path, or operator apply CLI.
- No exactly-once claim is made for external side effects.
- The second child does not inspect or abandon prior boots.
- The second child does not classify candidates, acquire recovery claims, run startup/reconnect sweeps, or resume work.
- The second child does not claim crash/reboot E2E coverage.
- Changes to graceful restart only consume the new safety evidence; they do not add an abrupt-crash classifier, sweep, or resume path.

## Commands

```bash
ravi specs sync --json
ravi specs get daemon/restart/crash-recovery --mode full --json
ravi specs get daemon/restart/crash-recovery --mode checks --json
bun test src/runtime/crash-recovery-store.test.ts
bun test src/runtime/crash-recovery.test.ts src/runtime/prompt-subscription.test.ts src/runtime/delivery-queue.test.ts src/runtime/control-host.test.ts
bun test src/approval/service.test.ts src/runtime/control-host.test.ts src/runtime/session-trace.test.ts src/runtime/session-dispatcher.test.ts src/runtime/daemon-restart-resume.test.ts src/bot.runtime-guards.test.ts
bun run typecheck
bun run build
```
