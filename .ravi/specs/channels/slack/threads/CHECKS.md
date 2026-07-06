# Slack Threads Checks

## Regression Scenarios

- [ ] Root Slack message with `route.session` MUST still route to the forced parent session.
- [ ] Thread Slack message with `route.session` MUST route to `<parent_session_key>:thread:<thread_ts>`.
- [ ] Thread Slack message without existing forced parent MUST still route to a session key containing `:thread:<thread_ts>`.
- [ ] Prompt `source.threadId` MUST equal the inbound Slack `thread_ts`.
- [ ] Canonical chat MUST use platform id `<channel_id>#<thread_ts>` and `chatType=thread`.
- [ ] Child session output target MUST resolve back to the same Slack thread.
- [ ] Actor metadata MUST be preserved on `source`, `context`, stored message and participant rows.
- [ ] Runtime continuity MUST fork from parent provider state when the child has no resumable state.
- [ ] Runtime continuity MUST resume child provider state after the child has its own state.

## Commands

```bash
bun test src/channels/slack/routing.test.ts src/channels/slack/socket-mode.test.ts src/runtime/runtime-session-continuity.test.ts
bun run typecheck
bun run build
```
