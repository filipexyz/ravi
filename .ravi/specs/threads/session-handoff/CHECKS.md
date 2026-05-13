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
