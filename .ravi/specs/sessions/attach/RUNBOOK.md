# Session Attach / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get sessions/attach --mode rules --json`.
2. Inspect `ravi sessions subscriptions <session>` for each active chat,
   speech mode, and default output marker.
3. For an inbound turn, resolve source chat and speech mode first.
4. If the source subscription is muted, resolve the default speak attachment.
5. If neither source nor default output can speak, fail closed and do not emit
   externally.
6. Do not use or reintroduce `focus` commands, fields, or runtime behavior.

## Validation

```bash
bun test src/router/session-attach.test.ts src/runtime/session-output-target.test.ts src/cli/commands/sessions.test.ts src/omni/consumer-context.test.ts
bun run build
```
