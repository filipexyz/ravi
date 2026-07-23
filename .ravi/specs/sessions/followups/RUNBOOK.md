# Session Followups / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get sessions/followups --mode rules --json`.
2. Inspect the cadence target: session, chat, or reading list.
3. Check the last non-agent external activity used to anchor inactivity.
4. Verify `nextRunAt`, progressive step index, and idempotency key for the due
   run.
5. Confirm prompts use `deliveryBarrier=after_response`.
6. If a chat/list target has no attached session, record a skipped run instead
   of creating a route.

## Validation

```bash
bun test src/session-followups/db.test.ts src/session-followups/service.test.ts src/cli/commands/session-followups.test.ts
```
