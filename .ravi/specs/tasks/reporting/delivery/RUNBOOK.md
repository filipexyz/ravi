# Task Reporting Delivery Runbook

## Send And Inspect A Report

```bash
ravi tasks report <task-id> --message "..." [--progress <0-100>]
ravi tasks done <task-id> --summary "..."
ravi tasks block <task-id> --reason "..."
ravi tasks fail <task-id> --reason "..."
```

1. Each mutation updates durable task state and emits a task event.
2. When a report target and matching report event are configured, Ravi enqueues
   a report prompt to the resolved target session.
3. `ravi tasks show <task-id>` confirms durable state; chat text alone is never
   durable progress.

## Diagnose A Missing Report Prompt

1. Confirm a report target is configured (`reportToSessionName` at assignment or
   task level). Absent target means no report prompt is published — this is
   expected, not a bug.
2. Confirm the task event type is within the effective `reportEvents` set
   (`blocked`, `done`, `failed`). Progress reports are not terminal report
   events.
3. Confirm assignment-level report settings (which override task-level) resolve
   to the intended target.

## Diagnose A Duplicate Report Prompt

1. A duplicate usually means a retry minted a new idempotency key or "delivered"
   was recorded before a durable core receipt.
2. Verify the idempotency key derives from the durable task event, target
   session, and renderer/protocol version, and that replay with the same key +
   payload hash is a no-op.

## Diagnose A Payload Conflict Or Unavailable Store

1. If a report is blocked with a payload-hash conflict, inspect both hashes in
   the repair evidence; do not overwrite. A corrected report uses a new key.
2. If the work store is `unavailable`, delivery defers and is not marked
   delivered. Treat `unavailable` as "cannot deliver yet", never as "no report".

## Verify Boundaries

1. Work modules MUST enqueue report prompts through the typed core session port,
   not through untyped infrastructure.
2. Cross-store report delivery MUST reference the shared storage outbox/receipt
   protocol once available and MUST NOT introduce a second generic outbox.
