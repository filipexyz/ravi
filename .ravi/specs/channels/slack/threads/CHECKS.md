# Slack Threads Checks

## Regression Scenarios

- [ ] Root Slack message with `route.session` still routes to the forced parent session.
- [ ] Thread Slack message with `route.session` routes to `<parent_session_key>:thread:<thread_ts>`.
- [ ] Thread Slack message without existing forced parent still routes to a session key containing `:thread:<thread_ts>`.
- [ ] Prompt `source.threadId` equals the inbound Slack `thread_ts`.
- [ ] Canonical chat uses platform id `<channel_id>#<thread_ts>` and `chatType=thread`.
- [ ] Child session output target resolves back to the same Slack thread.
- [ ] Actor metadata is preserved on `source`, `context`, stored message and participant rows.
- [ ] Runtime continuity forks from parent provider state when the child has no resumable state.
- [ ] Runtime continuity resumes child provider state after the child has its own state.

## Commands

```bash
bun test src/channels/slack/routing.test.ts src/channels/slack/socket-mode.test.ts src/runtime/runtime-session-continuity.test.ts
bun run typecheck
bun run build
```
