# Slack Threads Runbook

## Smoke Test

1. Ensure Slack native channels are running with Socket Mode.
2. Send a root message in a routed Slack channel and confirm the parent session responds.
3. Reply to that Slack message in a thread.
4. Confirm a new child session exists with `:thread:<thread_ts>` in the session key.
5. Confirm the child session has a subscription to a canonical chat whose platform id is `<channel_id>#<thread_ts>`.
6. Confirm the response appears inside the Slack thread.

## Programmatic Smoke Test

1. From the channel-root session, run
   `ravi sessions create-thread "Summarize this branch" --model <model>`.
2. Confirm one new Slack root message appears.
3. Confirm the returned child session key contains the root message `ts`.
4. Confirm the child model override equals `<model>` before its first turn.
5. Confirm the child begins working in the new Slack thread without another
   inbound Slack message.
6. In the child, run `ravi sessions close-thread --return "done"`.
7. Confirm the parent receives one completion event.
8. Repeat the close command and confirm no duplicate parent event is emitted.

## Debug

- If the thread response appears at channel root, inspect `source.threadId` and the channel outbound target.
- If the thread response goes to the parent session, inspect `commitMatchedRoute` and verify `route.session` is not redirecting thread turns.
- If permissions fail unexpectedly, inspect prompt `source`/`context` actor metadata and confirm `contactId` and `platformIdentityId` are present.
- If provider context does not fork, inspect whether the parent session has provider state and whether the provider supports `supportsSessionFork`.
- If the Slack root exists but no child turn starts, inspect the thread
  lifecycle row, the channel delivery event and the daemon delivery observer.
- If a retry creates duplicate work, compare the action request id, outbound
  idempotency key and lifecycle first-prompt timestamp.
- If close cannot find the lifecycle, confirm the child session has a Slack
  thread binding and a `last_thread_id`.

## Useful Checks

```bash
ravi sessions list | rg ':thread:'
sqlite3 ~/.ravi/ravi.db "SELECT session_key, name FROM sessions WHERE session_key LIKE '%:thread:%' ORDER BY updated_at DESC LIMIT 10;"
sqlite3 ~/.ravi/ravi.db "SELECT platform_chat_id, chat_type FROM chats WHERE channel='slack' AND chat_type='thread' ORDER BY updated_at DESC LIMIT 10;"
sqlite3 ~/.ravi/ravi.db "SELECT request_id, status, parent_session_key, child_session_key, provider_thread_id, model_override, parent_notified_at FROM slack_thread_lifecycle ORDER BY updated_at DESC LIMIT 10;"
```
