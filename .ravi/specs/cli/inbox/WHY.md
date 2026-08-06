# Console Delivery CLI Compatibility / WHY

## Why This Spec Lives In OSS

This spec exists for the local CLI and daemon bridge for Console-delivered watch
events. It is useful and testable in the open-source repo because it only covers
local auth reuse, polling orchestration, SQLite durability, NATS publish,
replay, and debug UX.

The old command name `ravi inbox` is now a compatibility alias. Product inbox
semantics belong to `inbox/SPEC.md`.

The Console server specs remain private because they define server-side policy,
authorization, redaction, item creation, producer behavior, and product rules.

## Why Pulse First

The common path should be cheap. A pulse lets local Ravi learn that nothing
changed without leasing rows, writing receipts, or forcing server scans.

Polling only after a generation change keeps local daemons lightweight.

## Why Persist Before Publish And Ack

Local persistence before publish makes crash recovery possible. If the process
dies after publish but before Console ack, the mirror can recognize the item and
avoid duplicate publish while still retrying ack.

Acking before publish would lose events. Publishing before persistence would
make replay and idempotency ambiguous after a crash.

## Why Replay Is Local

Replay is an operator/debug action. It should re-emit the exact local event to
NATS consumers without mutating Console state or creating a new delivery item.

## Why Replay Carries The Write Brake

Replay is the one op in this CLI group that re-dispatches processing: the
republished event reaches every NATS consumer again — triggers fire, agents
get prompted, automations run — and none of that can be un-run. Under the
agent-first contract (Manual v2) that makes it the braked op: dry-run by
default, `--execute` to publish. The rest of the group stays immediate —
`done`/`archive`/`snooze` are reversible local status flips,
`enable`/`disable` reverse each other, and `poll` is the same delivery tick
the daemon already fires on a timer (braking it would break the foreground
debug flow this spec's RUNBOOK depends on).

## Why Console Delivery Does Not Create Watches

Watch creation belongs to `ravi watch`, because a watch may run locally or in
Console while exposing the same event contract. Console delivery is only the
delivery path for events that cross the Console boundary.
