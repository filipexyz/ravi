# Session Attach / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get sessions/attach --mode rules --json`.
2. Inspect `ravi sessions subscriptions <session>` for active chats and the
   default output marker.
3. Confirm the trace keeps one source for the whole physical turn.
4. Confirm messages from another chat/thread stay queued until that turn ends.
5. For a source-less turn, inspect the default attachment.
6. If an inbound source is unattached, fail closed instead of using the
   default.
7. For CLI-only `sessions send -w`, read this turn's assistant transcript
   after `turn.complete`. Do not treat a dropped chat emit as empty success.
8. For operator CLI-only or HTTP `sessions.send`, read the persisted user
   row. It MUST be the raw prompt. A `[session surface]` prefix, "waiting
   CLI", or "no inbound chat" on that row is a leak.
9. For the same operator turn, inspect launch-prompt metadata or the
   queued runtime `user` content. The model-facing prompt MUST still start
   with `[session surface]`.
10. For a real WhatsApp/Slack inbound turn, the runtime prompt MUST start
    with `[session surface] This turn came from a …`. The persisted user
    row MAY keep that prefix.
11. Do not reintroduce `speech`, `mute`, `unmute`, or `focus`.
12. Do not add a `from` field to `sessions.send`. App identity stays on
    `context issue`; `[from:]` is only `callerSessionKey` inside Inform.

## Validation

```bash
bun test src/router/session-attach.test.ts src/runtime/session-output-target.test.ts src/cli/commands/sessions.test.ts src/omni/consumer-context.test.ts
bun test src/runtime/delivery-queue.test.ts src/runtime/session-dispatcher.test.ts src/runtime/session-surface-hint.test.ts src/runtime/session-trace.test.ts
bun run build
```
