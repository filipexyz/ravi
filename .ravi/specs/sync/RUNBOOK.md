---
id: sync
title: "Local-First Sync Runbook"
kind: runbook
domain: sync
owners:
  - ravi-dev
status: draft
normative: true
---

# Runbook

## Diagnose Stuck Outbox

1. List pending/failed outbox rows by domain.
2. Check cloud auth credentials and refresh status.
3. Check `next_attempt_at` and backoff state.
4. Check last remote error code.
5. Retry one event by id with JSON output.
6. Verify remote idempotency key behavior.

## Diagnose Stuck Inbox

1. List pending/failed remote events.
2. Check domain handler exists for event type.
3. Check local projection constraints.
4. Re-apply one event by id.
5. Verify applying the same event twice is safe.

## Recovery

Outbox and inbox should support marking an event dead with a reason, but dead
events MUST remain inspectable. Do not delete sync history to hide failures.
