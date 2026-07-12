---
id: threads/session-handoff
title: "Thread Session Handoff"
kind: capability
domain: threads
capability: session-handoff
status: draft
normative: false
---

# Thread Session Handoff Checks

## CLI

- Help for `ravi sessions send` documents `--thread <thread>`.
- `--thread` works with a thread id.
- `--thread` works with an unambiguous slug.
- Ambiguous slug fails without emission.
- Unknown thread fails without emission.
- `--json` includes thread and handoff metadata.

## Runtime

- The emitted prompt is one delivery to the target session.
- Source/context metadata carries `thread_id`.
- The provider adapter receives a normal runtime request and has no thread-storage coupling.
- Active-session delivery uses existing dispatcher/barrier behavior.

## Permissions

- Caller without thread read permission cannot send it.
- Caller without target session send permission cannot use `--thread`.
- Linked contact/chat does not grant outbound permission.

## Audit

- Handoff row exists for success.
- Handoff row exists or event exists for safe failure after validation starts.
- Included entries and links are reproducible from the handoff record.

## Cross-Store Delivery

- Thread entry, handoff, and delivery intent commit atomically in work storage.
- The handoff idempotency key is stable across retries and derived from durable
  identifiers.
- The handoff is marked `delivered` only after a durable core enqueue receipt
  for the same handoff id and payload hash, not on in-process publish return.
- Replay with the same key and payload hash does not create a duplicate entry,
  handoff, or prompt.
- A conflicting payload hash for an existing key fails closed as
  `payload_conflict` with repair evidence.
- Transient failure stays retryable; terminal failure is an explicit,
  repairable dead-letter state.
- `unavailable` work state defers delivery and is never treated as `missing`.
- Work modules enqueue the handoff prompt through the typed core session port.
- Public `sessions send --thread` return contracts stay concrete; no
  `@CliOnly()` or weak-baseline escape.
