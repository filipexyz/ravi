# Task Dispatch Rationale

## Why A Protocol Before A Storage Split

Task dispatch currently works because work-management state (tasks,
assignments, task events) and core runtime state (sessions) live in the same
SQLite database. `dispatchTask` can persist an assignment and materialize a
session in what is effectively one transaction, then publish a prompt in the
same process. Correctness is accidental: it depends on a single connection and
a single crash boundary.

The storage-by-workload effort splits these into separate durable stores. The
moment they are separate, a dispatch becomes a cross-store operation with two
independent commit points and two independent failure domains. Moving tables
without first defining the protocol would create crash windows (assignment
persisted but prompt lost), false acceptance (assignment marked accepted before
the runtime actually took it), duplicate prompts (retry without a stable key),
and unsafe eviction (work store unreadable, so the session looks idle).

Defining the normative protocol first lets the later data move be a mechanical,
independently reversible change against a contract that is already tested.

## Why Intent Is Separate From Acceptance

Enqueueing a prompt is not the same as the runtime accepting the task. If
acceptance is inferred from enqueue success, a crash or a dropped acknowledgement
produces a task that looks accepted but was never actually launched. Separating
a durable dispatch intent, a durable core enqueue receipt, and a runtime
acceptance acknowledgement makes every intermediate crash state observable and
retryable instead of silently "done".

## Why A Stable Dispatch Key And A Payload Hash

Retries are unavoidable across stores. A retry that reuses the same dispatch key
is a safe replay; a retry that mints a new key duplicates work. Separating a
stable key (identity of the logical dispatch) from a payload hash (the content
actually delivered) lets replays be idempotent while still catching the
dangerous case where the same logical dispatch is asked to deliver different
content — which must fail closed rather than guess.

## Why Fail Closed On Unavailable

The most dangerous failure is a confident wrong answer. If the work store is
unreachable and a caller treats that as "no active task", it will evict live
sessions and release delivery barriers early. Requiring `unavailable` to be
distinct from `missing`, and requiring fail-closed/defer behavior, trades a
little liveness for the guarantee that Ravi never destroys or interrupts active
task work based on an unread store.

## Why Reference The Shared Outbox Instead Of Building One

Report delivery, thread handoff, and dispatch all need the same durable
cross-store delivery primitive. Building a task-specific outbox here would
create a second generic mechanism that later has to be reconciled with the
storage topology's shared outbox/receipt protocol. This spec names the states
and evidence that protocol must carry and defers the mechanism to the shared
contract.
