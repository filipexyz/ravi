# Thread Session Handoff / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get threads/session-handoff --mode rules --json`.
2. Resolve the target session explicitly; the operator chooses where the thread
   continues.
3. Resolve or create the portable thread, recording whether it was reused or
   created.
4. Build a bounded thread brief plus the operator instruction.
5. Send exactly one prompt to the target session with thread metadata.
6. Verify runtime trace, emitted event metadata, and handoff audit include
   `thread_id`, brief snapshot/hash metadata, and included ids.

## Validation

```bash
bun test src/threads/service.test.ts src/cli/commands/sessions.test.ts
```
