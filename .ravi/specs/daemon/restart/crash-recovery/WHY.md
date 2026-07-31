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

The ledger lands before instrumentation, queue persistence, classifier, sweeper, CLI, and crash harness. This keeps the first change inert at runtime while fixing the data contract those later phases depend on.
