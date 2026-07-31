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

## Scope Guard

- No daemon startup hook is added in the first child.
- No provider or event-loop instrumentation is added in the first child.
- No live dispatcher queue is persisted in the first child.
- No classifier, sweeper, resume, requeue, or operator apply CLI is added in the first child.
- No exactly-once claim is made for external side effects.

## Commands

```bash
ravi specs sync --json
ravi specs get daemon/restart/crash-recovery --mode full --json
ravi specs get daemon/restart/crash-recovery --mode checks --json
bun test src/runtime/crash-recovery-store.test.ts
bun run typecheck
bun run build
```
