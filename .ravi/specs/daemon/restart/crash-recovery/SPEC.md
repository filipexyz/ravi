---
id: daemon/restart/crash-recovery
title: Abrupt Crash Recovery
kind: feature
domain: daemon
capability: restart
feature: crash-recovery
capabilities:
  - restart
  - runtime-context
  - session-continuity
  - delivery-queue
tags:
  - daemon
  - crash-recovery
  - runtime
  - ledger
applies_to:
  - src/router/router-db.ts
  - src/runtime/crash-recovery-store.ts
  - src/runtime/crash-recovery.ts
  - src/runtime/session-dispatcher.ts
  - src/runtime/host-event-loop.ts
  - src/daemon.ts
owners:
  - dev
status: active
normative: true
---

# Abrupt Crash Recovery

## Intent

Ravi must recover durable runtime work after an abrupt daemon or machine crash without treating historical trace rows as permission to replay side effects.

This feature complements `daemon/restart/active-session-resume`: graceful restart snapshots describe process memory captured during an intentional shutdown, while abrupt crash recovery relies on durable boot ownership, leases, immutable prompt atoms, safety markers, and transactional claims.

## Source Of Truth Boundaries

- `session_turns` remains the historical trace and cost surface. A recent `session_turns.status=running` row alone MUST NOT authorize replay.
- The crash-recovery ledger is the source of truth for boot ownership, provider attempts, durable queued prompt atoms, recovery claims, and audited recovery decisions.
- Provider adapters MUST NOT own recovery policy. Safe work MUST re-enter through `RuntimeSessionDispatcher` and its normal pool, queue, task-barrier, delivery-barrier, and interruption rules.
- Recovery MUST NOT delete or rewrite historical turn trace rows to hide stale state.

## Durable Contract

### Boot epochs

Every daemon process MUST have a durable `boot_epoch`, scoped to an instance and process id, with one of these states:

- `active`
- `graceful_stopped`
- `abandoned`

An active boot MUST renew a durable heartbeat and lease. Abandonment MUST compare-and-set the exact heartbeat and lease previously observed, and MUST NOT occur before that observed lease expires. An expired lease is evidence for later classification, not sufficient by itself to replay work. Terminal boot state is monotonic. A graceful boot MUST NOT later become abandoned, and an abandoned boot MUST NOT later become graceful.

### Turn attempts

Every provider delivery attempt MUST have its own durable `attempt_id`; multiple attempts MAY reference the same logical `turn_id`, and a recovered attempt SHOULD reference the preceding attempt explicitly.

The attempt MUST record:

- owning boot epoch, session, run/turn identity, provider, and model;
- start time, last heartbeat, and lease expiry;
- durable request/prompt/checkpoint references sufficient for later classification;
- source, turn provenance, delivery barrier, task barrier, and pending ids;
- monotonic `started_tool` and `materialized_output` safety markers;
- terminal state and recovery claim/result references.

Every attempt MUST carry a durable request blob reference or provider checkpoint, and attempt/queue leases MUST NOT outlive the owning boot lease. An attempt owned by a live boot or with an unexpired lease MUST NOT be classified as an orphan. Terminal attempts MUST NOT return to `running`.

### Prompt queue

Every durable queue row represents one immutable prompt atom. It MUST retain:

- a stable queue item id and dedupe key;
- session and lane identity plus a durable monotonic sequence;
- the original prompt envelope and runtime message metadata;
- origin, delivery barrier, task barrier, pending id, and boot/lease ownership;
- lifecycle, recovery claim, and result metadata.

Reusing a dedupe key with different immutable content MUST fail. Queue reads MUST preserve FIFO within a session lane by durable sequence, not timestamp alone.

Every owner-bound queue transition MUST compare the observed boot, lease owner token, and lease expiry. A stale worker MUST receive a lost-CAS result and MUST NOT advance or replace another owner's lease. Delivery MUST bind the prompt to a running, unexpired, unclaimed attempt from the same session and boot owner.

Queue lifecycle MUST follow an explicit forward transition graph. A prompt MUST be leased before it starts, MUST be starting under a fenced live owner before delivery, and MUST NOT return from `delivered` to a leaseable state. Enqueue metadata is part of the immutable prompt atom and lifecycle transitions MUST preserve it. The immutable fingerprint MUST be recomputed from the persisted prompt atom whenever the row is read or deduplicated; valid-but-divergent JSON is ledger corruption, not a new prompt value.

### Recovery runs, candidates, and claims

Each inspect, dry-run, or apply pass MUST have a durable recovery run. Each evaluated candidate MUST record a stable candidate key, decision, reason code, proposed action, action status, claim, and result.

Candidate keys MUST be derived canonically from the attempt, queue item, or legacy session+turn identity; caller-defined aliases MUST NOT decide global uniqueness. Claims MUST be transactional and globally unique by logical candidate key. Repeated or concurrent apply passes MUST acquire at most one claim for a candidate. A failed claimed action remains auditable and MUST NOT silently become replayable again.

Inspect and dry-run modes MUST NOT acquire claims or produce runtime side effects.

Terminal writes are strongly idempotent: an exact retry returns the durable row, while a retry with a different timestamp, result, reason, summary, or immutable projection MUST fail closed. An apply run MUST NOT become terminal while a candidate remains pending or claimed.

Acquiring a recovery claim fences the underlying attempt or queue row immediately. Normal owner mutations MUST reject a claimed source and their SQL compare-and-set MUST include an unclaimed-source predicate. Only the recovery claim projection may advance recovery result fields for that claim, and completion MUST compare every claimed source projection instead of repairing partial divergence. Persisted safety booleans and lifecycle enums MUST be decoded strictly before a mutating decision; an unknown value MUST fail closed as ledger corruption.

## Recovery Policy

The classifier and sweeper are later phases, but their contract is fixed here:

- candidates MUST come from expired non-terminal attempts owned by an abandoned boot or durable queued work without a live owner;
- ambiguous ownership, missing checkpoint/request data, unsafe tool execution, or materialized output MUST fail closed;
- recurring cron, heartbeat, follow-up, and sweep work SHOULD defer to the next schedule unless the producer explicitly opts into crash resume;
- stable decisions are `resume`, `requeue`, `reconcile_interrupted`, `defer_next_schedule`, `ignore_stale`, and `manual_review`;
- recovery MUST NOT promise exactly-once external effects without a producer-owned durable idempotency key;
- resumed or requeued work MUST NOT call a provider directly.

## First Delivery Cut: Contract And Ledger

The first implementation child is intentionally limited to:

- this normative specification;
- persistent boot, turn-attempt, prompt-queue, recovery-run, candidate, and claim tables;
- typed storage APIs with monotonic state changes, immutable dedupe, FIFO reads, and transactional claim semantics;
- focused persistence and idempotency tests.

It MUST NOT start a recovery sweep, instrument daemon/provider lifecycle, persist the live dispatcher queue, classify candidates, resume work, add CLI apply surfaces, or claim crash/reboot E2E coverage. Those are later children.

## Acceptance Criteria

- Schema creation is idempotent on an existing Ravi database.
- Boot and attempt terminal state cannot be reversed.
- Tool/output safety markers are monotonic.
- Prompt dedupe accepts an identical retry and rejects divergent content.
- Same-lane prompt rows are returned in durable FIFO order.
- Inspect/dry-run recovery runs cannot acquire a claim.
- Repeated or concurrent apply claims return one winner and the original durable claim to all losers.
- A real two-process claim race persists one global claim.
- Boot abandonment and owner-bound queue transitions use observed lease fencing.
- Queue delivery requires the forward `leased -> starting -> delivered` lifecycle and delivered rows cannot be leased again.
- Recovery claims fence normal attempt and queue mutation before an action can be applied.
- Delivery rejects terminal, expired, or recovery-claimed target attempts.
- Claim completion rejects partial source-projection divergence, and run completion decodes every candidate before deciding no work remains.
- Persisted prompt fingerprints are revalidated against row contents, including valid JSON tampering.
- Regressive timestamps, divergent terminal retries, cross-session delivery, unknown safety enums, and incomplete source projections fail closed.
- Candidate audit exposes decision, reason, proposed action, claim, action status, and result without deleting history.
- No startup, dispatcher, provider, or channel behavior changes in this cut.

## Validation

- `ravi specs sync --json`
- `ravi specs get daemon/restart/crash-recovery --mode full --json`
- `bun test src/runtime/crash-recovery-store.test.ts`
- `bun run typecheck`
- `bun run build`
