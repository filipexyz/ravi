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
  - src/bot.ts
  - src/router/router-db.ts
  - src/runtime/crash-recovery-store.ts
  - src/runtime/crash-recovery.ts
  - src/runtime/prompt-subscription.ts
  - src/runtime/runtime-request-builder.ts
  - src/runtime/delivery-queue.ts
  - src/runtime/session-dispatcher.ts
  - src/runtime/host-event-loop.ts
  - src/runtime/control-host.ts
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
- durable `toolEffectFence` metadata distinguishing synchronous host write-ahead from asynchronous provider-event observation;
- terminal state and recovery claim/result references.

Every attempt MUST carry a durable request blob reference or provider checkpoint, and attempt/queue leases MUST NOT outlive the owning boot lease. An attempt owned by a live boot or with an unexpired lease MUST NOT be classified as an orphan. Terminal attempts MUST NOT return to `running`.

The runtime host MUST create its boot epoch before accepting subscriptions. It MUST heartbeat the boot independently of provider events and renew the boot before its active attempts. Loss or expiry of a boot/attempt fence MUST stop new provider deliveries and abort every active owned attempt in memory. Every lease-authorized persistent mutation MUST re-read the current clock after the write and validate the lease that authorized the write; a renewal MUST NOT validate a stalled write against the newly extended lease.

For each provider delivery, the host MUST persist the sanitized adapter request and create the attempt after resolving source/provenance but before the common prompt generator yields to any provider. Failure of either write MUST prevent delivery and retain the pending prompt. Provider adapters MUST remain unaware of the ledger.

Safety evidence is write-ahead and monotonic:

- adapters with a synchronous host tool boundary MUST set `started_tool` before returning allow, and observed tool start/completion/result events MUST set it before projection. Claude MUST finish every matching `PreToolUse` chain with a catch-all durable fence, including tools auto-allowed by `bypassPermissions`, and MUST deny execution if that fence cannot be persisted or revalidated;
- a provider without a synchronous durable pre-tool acknowledgement MUST persist `toolEffectFence=provider_event_only` before handoff; absence of a later tool event MUST NOT make that physical turn replayable. Codex and Pi use this conservative mode until their adapters provide an acknowledged write-ahead hook;
- externally streamable text or an accepted assistant message MUST set `materialized_output` before persistence, projection, or emission;
- an external approval or user-input poll MUST set `materialized_output` immediately before each real poll publication, while a local/inherited decision that emits no poll MUST NOT create false output evidence;
- provider-native raw events that contain assistant text or tool activity MUST follow the corresponding normalized safety fence, and raw assistant content rejected as interrupted, silent, heartbeat, or no-response MUST NOT be externalized;
- repeated markers SHOULD be coalesced in memory after their first durable write.

Attempt terminalization MUST be independent of the historical trace's terminal guard. The first terminal path wins, persists before waking the generator or starting a replacement runtime, retains the monotonic safety evidence after the active binding is removed, and uses the same status/timestamp as the canonical terminal trace. Graceful host shutdown MUST abort any remaining attempts before marking the boot `graceful_stopped` and closing the database.

Existing bounded retry and graceful-restart paths MUST consume that durable safety evidence. A physical turn with `started_tool`, `materialized_output`, an `inputMutated` safety marker, or `toolEffectFence=provider_event_only` MUST NOT be stashed or continued by a generic restart prompt. A physical turn already terminal at snapshot time is consumed regardless of its markers. A restart MAY continue a replay-safe current turn, MAY resume only independently queued durable successors, or MUST suppress continuation entirely; these cases are represented explicitly as `continue`, `pending_only`, and `skip` rather than inferred from prose. A caller restart reason/epoch without its expected session snapshot MUST resolve to `skip`; snapshot absence is not evidence that no physical turn existed.

Provider-owned ambiguous-turn reconciliation is distinct from generic replay. The host MAY retain an unsafe current turn solely for a live provider handle that advertises `reconcile_by_client_message_id`; the adapter MUST reattach or hydrate the matching native turn and MUST NOT issue another provider start after a failed/interrupted match without separate terminal replay authority. A provider without that advertised strategy MUST receive only replay-safe current input or independent successors.

The legacy `RaviBot.start()` task-recovery heuristic MUST NOT publish a fresh `Continue task ...` prompt from task status/recency alone. It remains disabled until the classifier/sweeper can bind the logical task resume to durable attempt safety and a recovery decision; a fresh task row is not replay authorization.

Implicit native steer MAY run only for a live, durably owned attempt and MUST persist `metadata.inputMutated=true` before invoking provider control. That marker makes the physical attempt ineligible for generic replay even when the control call later fails. Host `turn.steer` and `turn.follow_up` surfaces that cannot write the same fence MUST remain disabled until an append-only durable attempt-input journal binds every added input to the owning attempt. `turn.interrupt` does not add input and MAY remain available.

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

## Second Delivery Cut: Boot And Attempt Instrumentation

The second implementation child is limited to:

- one host-owned coordinator for the current boot epoch and active attempt leases;
- boot creation/heartbeat/graceful close wired to the `RaviBot` lifecycle;
- fail-closed attempt creation at the common provider handoff;
- monotonic tool/output safety markers and canonical terminalization;
- fail-closed safety integration for existing bounded retries and graceful restart snapshots;
- disabling non-durable steer/follow-up input paths;
- disabling the unclassified startup task-resume producer until the recovery classifier owns that decision;
- focused lifecycle, handoff, event-loop, dispatcher, and control-host tests.

It MUST NOT abandon prior boots, persist the live dispatcher queue, classify or claim candidates, run startup/reconnect sweeps, resume/requeue work, expose recovery CLI, or claim crash-harness E2E coverage.

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
- A boot epoch exists before runtime subscriptions accept work and becomes graceful only after owned attempts are terminal.
- Every provider-consumed prompt has a running durable attempt with the same request hashes, source/provenance, barriers, and pending ids captured before handoff.
- Lease/marker/terminal store failure makes the coordinator reject new deliveries and abort active ownership.
- Expired cached ownership cannot create, mark, terminalize, or gracefully close work before the next timer tick.
- Once ownership is lost, the prompt consumer NAKs before ACK and stops accepting new runtime input.
- Unterminated input is not replayed after durable tool/output safety evidence exists.
- Provider-event-only adapters never replay the current physical turn from absence of an asynchronous tool marker; only independent successors remain eligible.
- External approval/user-input polls and provider raw events cannot cross their external boundary before durable output/tool evidence.
- Graceful restart snapshots never revive a provider-terminal or unsafe physical turn; independently queued successors remain recoverable without appending a generic continuation, and a missing caller snapshot fails closed.
- Provider approval, physical attempt terminalization, and historical trace terminalization use the same fail-closed binding and first-terminal fence.
- Native prompt controls cannot bypass the immutable attempt request.

## Validation

- `ravi specs sync --json`
- `ravi specs get daemon/restart/crash-recovery --mode full --json`
- `bun test src/runtime/crash-recovery-store.test.ts`
- `bun test src/runtime/crash-recovery.test.ts src/runtime/prompt-subscription.test.ts src/runtime/delivery-queue.test.ts src/runtime/control-host.test.ts`
- `bun test src/approval/service.test.ts src/runtime/control-host.test.ts src/runtime/session-trace.test.ts src/runtime/session-dispatcher.test.ts src/runtime/daemon-restart-resume.test.ts src/bot.runtime-guards.test.ts`
- `bun run typecheck`
- `bun run build`
