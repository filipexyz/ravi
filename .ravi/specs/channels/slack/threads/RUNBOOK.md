# Slack Threads Runbook

## Smoke Test

1. Ensure Slack native channels are running with Socket Mode.
2. Send a root message in a routed Slack channel and confirm the parent session responds.
3. Reply to that Slack message in a thread.
4. Confirm a new child session exists with `:thread:<thread_ts>` in the session key.
5. Confirm the child session has a subscription to a canonical chat whose platform id is `<channel_id>#<thread_ts>`.
6. Confirm the response appears inside the Slack thread.

## Debug

- If the thread response appears at channel root, inspect `source.threadId` and the channel outbound target.
- If the thread response goes to the parent session, inspect `commitMatchedRoute` and verify `route.session` is not redirecting thread turns.
- If permissions fail unexpectedly, inspect prompt `source`/`context` actor metadata and confirm `contactId` and `platformIdentityId` are present.
- If provider context does not fork, inspect whether the parent session has provider state and whether the provider supports `supportsSessionFork`.

## Useful Checks

```bash
ravi sessions list | rg ':thread:'
sqlite3 ~/.ravi/ravi.db "SELECT session_key, name FROM sessions WHERE session_key LIKE '%:thread:%' ORDER BY updated_at DESC LIMIT 10;"
sqlite3 ~/.ravi/ravi.db "SELECT platform_chat_id, chat_type FROM chats WHERE channel='slack' AND chat_type='thread' ORDER BY updated_at DESC LIMIT 10;"
```
