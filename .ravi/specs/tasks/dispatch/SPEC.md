---
id: tasks/dispatch
title: "Task Dispatch"
kind: capability
domain: tasks
capability: dispatch
capabilities:
  - ownership
  - typed-ports
  - dispatch-intent
  - acceptance-acknowledgement
  - idempotency
  - unavailable-state
  - repair-evidence
tags:
  - tasks
  - dispatch
  - runtime
  - sessions
  - ports
  - idempotency
applies_to:
  - src/tasks/service.ts
  - src/tasks/task-db.ts
  - src/tasks/session-publisher.ts
  - src/tasks/session-retention.ts
  - src/runtime/task-runtime-context.ts
  - src/runtime/delivery-queue.ts
  - src/cli/commands/tasks.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Task Dispatch

## Intent

Task Dispatch defines the normative protocol at the core/work boundary for
handing a durable task assignment to a runtime session and confirming that the
session accepted it.

The protocol exists so that dispatch, task-runtime binding, and task acceptance
stay safe when work-management state and core runtime state no longer share a
single SQLite connection or a single transaction. Once storage is split by
workload, a dispatch spans two independently durable stores. Without a protocol
this crossing produces crash windows, false acceptance, duplicate prompts, and
unsafe behavior when either store is unavailable.

This spec is specification-only. It MUST NOT introduce runtime, storage, schema,
migration, or reconciliation behavior. It defines the contract that later,
independently gated implementation phases MUST satisfy.

## Ownership And Direction

Work owns:

- task, assignment, task-event, and dispatch-intent lifecycle state;
- the durable dispatch intent, its idempotency key, and its payload hash;
- retry, timeout, dead-letter, and repair-evidence bookkeeping for dispatch.

Core owns:

- session resolution and materialization;
- prompt enqueueing;
- runtime launch, acceptance, and the acceptance acknowledgement receipt;
- session retention and eviction;
- session goals.

Every crossing in this spec has exactly one owner and one direction:

- `work -> core`: work asks core to resolve/materialize a session and enqueue a
  dispatch prompt. Work MUST use a typed core session port.
- `core/runtime -> work`: runtime reads task binding and reports acceptance.
  Runtime MUST use a typed work port.

## Typed Ports

Two typed ports replace the current direct module and database coupling.

`WorkPort` (called by core/runtime, owned by work):

- `resolveActiveTaskBinding(sessionName, taskId)`;
- `markTaskAccepted(sessionName, taskId, acknowledgement)`;
- `hasActiveTask(sessionName, excludeTaskId?)`;
- `resolveTaskRuntimeOptions(sessionName, taskId)`.

`CoreSessionPort` (called by work, owned by core):

- `resolveSession(ref)` / `materializeSession(ref, agentId, cwd, options)`;
- `enqueueDispatchPrompt(sessionRef, dispatchEnvelope)` returning a durable
  enqueue receipt;
- `applySessionRetention(sessionRef, ttl)`.

### Port Read Result Contract

Every port read MUST return exactly one status:

- `found` — the record exists and is returned;
- `missing` — the store is reachable and authoritatively has no such record;
- `unavailable` — the store could not be consulted (closed, locked, degraded,
  timed out, or not yet cut over);
- `unsupported` — the requested protocol/renderer version is not understood.

Callers MUST distinguish all four. `unavailable` MUST NOT be treated as
`missing`. `unsupported` MUST NOT be treated as `missing` or `found`. A caller
that cannot obtain `found` or an authoritative `missing` MUST fail closed or
defer per the Unavailable-State Safety section; it MUST NOT infer absence.

### Port Direction Invariants

- Runtime modules MUST NOT import work database functions directly. They MUST
  read task state through `WorkPort`.
- Work modules MUST NOT mutate core session tables and MUST NOT publish prompts
  through untyped infrastructure calls. They MUST enqueue through
  `CoreSessionPort`.
- Neither port MAY expose a cross-store transaction or a cross-store join.

## Dispatch State Machine

A dispatch is a durable work-owned object keyed by a stable dispatch key.

Canonical states:

- `intent` — assignment and dispatch intent committed in work storage;
- `enqueued` — core returned a durable enqueue receipt for the intent;
- `accepted` — runtime returned a matching acceptance acknowledgement;
- `timed_out` — no acknowledgement within the acceptance window; result unknown;
- `retry_scheduled` — a transient failure or timeout left retryable evidence;
- `dead_letter` — retries exhausted or a terminal failure occurred;
- `payload_conflict` — the same dispatch key was reused with a different payload
  hash;
- `repair_required` — operator/repair intervention is needed to make progress.

Allowed transitions:

```text
intent            -> enqueued | retry_scheduled | dead_letter | payload_conflict
enqueued          -> accepted | timed_out | retry_scheduled | payload_conflict
timed_out         -> retry_scheduled | accepted | dead_letter | repair_required
retry_scheduled   -> enqueued | dead_letter | repair_required
payload_conflict  -> repair_required
repair_required   -> retry_scheduled | dead_letter
accepted          -> (terminal for dispatch)
dead_letter       -> (terminal for dispatch; repairable via new dispatch key)
```

### Dispatch Rules

- A work transaction MUST atomically persist the assignment and a stable
  dispatch intent. The assignment MUST NOT be observably dispatched without a
  committed intent, and an intent MUST NOT exist without its assignment.
- The dispatch key MUST be stable across retries and MUST be derived from
  durable identifiers (task id, assignment identity, and resolved target
  session reference). Retry MUST reuse the same dispatch key.
- Enqueueing MUST go through `CoreSessionPort.enqueueDispatchPrompt` and MUST
  record the returned durable enqueue receipt against the intent before the
  dispatch is treated as `enqueued`.
- Acceptance MUST require the matching runtime acknowledgement carrying the same
  dispatch key and payload hash. A successful enqueue alone is NOT acceptance.
- Core unavailability, enqueue failure, acceptance timeout, or a crash MUST
  preserve retryable evidence and MUST NOT create false `accepted` state.
- Reusing a dispatch key with a different payload hash MUST fail closed into
  `payload_conflict` and surface repair evidence; it MUST NOT silently
  overwrite the prior intent or deliver both payloads.
- Enqueue and acknowledgement MUST be individually idempotent under replay: a
  replay with the same dispatch key and same payload hash MUST NOT create a
  second assignment, a second prompt, or a second acceptance.

### Idempotency And Payload Hash

- `dispatchKey` identifies the logical dispatch and is retry-stable.
- `payloadHash` is a content hash of the rendered dispatch envelope (prompt,
  task/profile/runtime context, protocol version). It changes when the intended
  delivered content changes.
- Delivery decisions MUST compare both: same key + same hash is a safe replay;
  same key + different hash is a `payload_conflict`.
- The acknowledgement receipt MUST reference both `dispatchKey` and
  `payloadHash` so that acceptance cannot be attributed to a stale payload.

## Unavailable-State Safety

When work state is `unavailable`, the following operations MUST fail closed or
defer. They MUST NOT infer that no active task exists.

- Session eviction/retention MUST NOT evict a session whose active-task status
  cannot be confirmed; it MUST defer until work state is readable.
- Delivery barriers (notably `after_task`) MUST treat an unresolvable
  active-task check as "cannot deliver yet" and defer, never as "no active
  task, deliver now".
- Task runtime option resolution MUST fall back to safe core-only defaults and
  MUST NOT fabricate a task binding; it MUST NOT mutate session defaults.
- Task acceptance MUST NOT be recorded while the work store is `unavailable`;
  the dispatch MUST remain retryable.

Operations that MAY continue from core-only state:

- resolving and materializing a session;
- reading and accounting session goals (see `sessions/goals`);
- enqueueing prompts that do not depend on work-owned barriers.

Operations that MUST retry or defer when work state is unavailable:

- marking acceptance;
- `after_task` barrier release;
- task-aware retention/eviction decisions.

## Shared Protocol Boundary

- Cross-store delivery (enqueue receipts, acknowledgements, retries, dead-letter)
  MUST reference the shared storage outbox/receipt protocol once it exists under
  the storage topology (`storage/topology` and its `storage/topology/work`
  contract). This spec names the states and evidence that protocol must carry;
  it MUST NOT define a second generic outbox.
- This spec MUST NOT create or edit any storage spec subtree, `work.db`, a store
  registry, migrations, reconciliation, or repair implementation.
- Public CLI/SDK return contracts for dispatch MUST remain concrete.
  `@CliOnly()` and expansion of the weak return-schema baseline MUST NOT be used
  as an escape from defining concrete dispatch return schemas.

## Failure Matrix — Dispatch

Columns: observable source (work) state, core state, retry behavior,
idempotency behavior, repair evidence. Source intent is distinct from a durable
core enqueue receipt and from a runtime acceptance acknowledgement.

| Scenario | Source (work) state | Core state | Retry | Idempotency | Repair evidence |
| --- | --- | --- | --- | --- | --- |
| Crash before source commit | no intent, no assignment | no receipt | none needed; client MAY re-issue | fresh dispatch key on re-issue | none required; nothing durable created |
| Crash after source commit, before core request | `intent` | no receipt | resume enqueue with same dispatch key | same key + hash is safe replay | intent row with `enqueued=false` |
| Crash after durable core receipt, before source ack of receipt | `intent` | receipt exists | reconcile: attach receipt to intent, then `enqueued` | dedupe by receipt id + dispatch key | orphan receipt reconciled to intent |
| Timeout, unknown remote result | `enqueued` -> `timed_out` | receipt exists, acceptance unknown | retry with same key after backoff | acceptance dedupes on key + hash | `timed_out` marker + attempt count |
| Replay after acknowledgement loss | `enqueued` | receipt + prior ack lost | re-request ack; do not re-enqueue new payload | same key + hash ack is idempotent | ack ledger keyed by dispatch key |
| Payload-hash mismatch for existing key | `payload_conflict` | receipt for prior hash | blocked until repair | conflicting hash fails closed | conflict record with both hashes |
| Source (work) store unavailable | `unavailable` | n/a | defer; no acceptance recorded | no state change | unavailable read logged; dispatch retryable |
| Core store unavailable | `intent` | enqueue fails/unknown | `retry_scheduled` with same key | no false `accepted` | enqueue failure evidence |
| Unsupported protocol/version | intent with unsupported version | receipt refused | no blind retry; escalate | `unsupported` never counts as delivered | version mismatch record |

## Implementation Inventory

Current call sites that violate or will implement this boundary (repository
evidence, not implementation in this PR):

- `src/tasks/service.ts` `dispatchTask` persists the assignment via
  `dbDispatchTask` (work), resolves/materializes the session via
  `getOrCreateSession`/`resolveSession` from `src/router/sessions.ts` (core),
  and publishes the dispatch prompt via `publishTaskSessionPrompt`. There is no
  separate durable dispatch intent and no acceptance acknowledgement gate; today
  the two stores are one connection.
- `src/tasks/session-publisher.ts` publishes prompts through
  `publishSessionPrompt` from `src/omni/session-stream.ts` — an untyped
  infrastructure call from a work module. This MUST move behind
  `CoreSessionPort`.
- `src/runtime/task-runtime-context.ts` imports `dbResolveActiveTaskBindingForSession`
  and `dbMarkTaskAcceptedForSession` from `src/tasks/task-db.ts` directly. Both
  MUST move behind `WorkPort`, and acceptance MUST become the acknowledgement
  step of the dispatch state machine.
- `src/runtime/delivery-queue.ts` imports `dbHasActiveTaskForSession` from
  `src/tasks/task-db.ts` and uses it for the `after_task` barrier; a failed or
  unavailable read currently degrades toward "no active task". This MUST become
  a fail-closed/defer `WorkPort` read.
- `src/tasks/session-retention.ts` applies session TTL via `setSessionEphemeral`
  (core) using task-session naming, and `src/ephemeral/runner.ts` evicts on TTL
  without consulting active-task status. Eviction MUST become task-aware and
  fail closed when work state is unavailable.

## Follow-Up Phases

Implementation MUST be decomposed into independently executable, separately
gated phases. This PR performs none of them.

1. Introduce `WorkPort` and `CoreSessionPort` interfaces with the
   `found|missing|unavailable|unsupported` read contract; route existing direct
   calls through them with no behavior change. Prereq: none. Validation:
   `bun test src/tasks/service.test.ts src/runtime/*.test.ts`.
2. Add the durable dispatch intent, stable dispatch key, and payload hash to the
   work transaction. Prereq: phase 1. Validation: dispatch idempotency tests.
3. Add the acceptance acknowledgement receipt and make `accepted` require it.
   Prereq: phase 2.
4. Make `after_task` barrier, retention/eviction, and runtime-option resolution
   fail closed/defer on `unavailable`. Prereq: phase 1.
5. Bind enqueue receipts, retry, timeout, dead-letter, and repair evidence to
   the shared storage outbox/receipt protocol once it lands. Prereq: storage
   topology + shared outbox specs; phases 2-3.

Each phase MUST keep public CLI/SDK return contracts concrete and MUST pass its
own focused tests plus human validation before the next phase.

## Acceptance Criteria

- Owner and direction are explicit for every task/session crossing.
- The dispatch state machine names canonical intent, enqueue receipt,
  acknowledgement, timeout, retry, dead-letter, payload-conflict, and repair
  states.
- The dispatch key is retry-stable and the payload hash governs conflict.
- `found|missing|unavailable|unsupported` behavior is normative for the work and
  core session ports.
- Eviction, delivery barriers, runtime options, and acceptance fail closed or
  defer when work state is unavailable.
- The dispatch failure matrix is complete and distinguishes source intent from
  durable core receipt and from acceptance acknowledgement.
- The inventory cites concrete call sites and decomposes follow-up work into
  bounded phases.
- No runtime or storage implementation is included.

## Validation

- `ravi specs sync --json`
- `ravi specs get tasks/dispatch --mode full --json`
- `ravi specs get tasks/dispatch --mode checks --json`
- `bun test src/specs/service.test.ts src/cli/commands/specs.test.ts`
- `bun test src/tasks/service.test.ts`
- `bun run typecheck`
- `bun run build`

## Known Failure Modes

- Treating `unavailable` as `missing` and inferring no active task, then
  evicting a session or releasing an `after_task` barrier prematurely.
- Marking an assignment accepted on enqueue success without a runtime
  acknowledgement, producing a ghost/false acceptance.
- Generating a fresh dispatch key on retry and delivering a duplicate prompt.
- Overwriting an intent when the same dispatch key arrives with a different
  payload hash instead of failing closed.
- Work modules publishing prompts or mutating session tables through untyped
  infrastructure instead of `CoreSessionPort`.
- Runtime modules importing work database functions directly instead of using
  `WorkPort`.
- Defining a second generic outbox in this domain instead of referencing the
  shared storage protocol.
- Using `@CliOnly()` or weak-baseline expansion to avoid concrete dispatch
  return schemas.
