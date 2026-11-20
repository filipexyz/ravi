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


If close reports `THREAD_DECISIONS_PENDING`, run `ravi decisions list --thread <child-session> --json`, then `ravi decisions show <decision-id> --json`. Answer from the authorized parent/operator. A recorded answer with failed delivery uses `ravi decisions retry <decision-id> --execute`; uncertainty requires operator trace inspection and `decisions resolve-delivery`.

## A thread-send waits, and cannot be taken back

`thread-send` queues behind the thread's running turn, so it can wait for minutes behind a long tool.

- **The result of a thread that closed itself is not lost.** If the thread closes in the turn the instruction waited behind, delivering the instruction reopens it, and the next close reaches the parent with its own `--return`. Only the thread's own close is undone: if the parent closed the thread (`close-thread` from the channel session) while the instruction waited, the instruction still runs and the thread stays closed; a new `thread-send` reopens it. A replayed instruction is not a new delivery and reopens nothing. A card that says "closed" while the thread works means that reopen did not run: `ravi sessions trace <thread>` shows the turn, and closing again after it delivers the result.
- **A queued instruction cannot be retracted.** A correction sent with `--immediate` runs first and the earlier instruction still runs after it. Name the pending one in the correction ("when X arrives, ignore it"), or wait for the turn to end.
- **A hard crash of the daemon loses queued instructions.** They are in memory until delivered; a graceful restart snapshots them and a crash does not. A credential retry or the recovery of a turn that never ended keeps them: they are stashed with the turn and run after the restart. After an unexpected restart, ask the thread for its state with `ravi sessions threads --json` and resend what it has not acknowledged.

## CI of a PR a thread published

While the thread is open, the CI, merge and review events of a PR it published reach the thread, not the channel session (the follow is the thread's; see SPEC). The channel session that merges learns of them only if the thread reports: `ravi sessions report "<CI conclusion on SHA / merged / change request>"`. If a channel session waits for a PR and hears nothing, read the thread (`ravi sessions threads --json`, `ravi sessions read <thread>`) and the PR checks (`gh api repos/<repo>/commits/<sha>/check-runs`). After the thread closes, the follow belongs to the channel session again and wakes it directly.

## Close refused by active triggers

For `THREAD_TRIGGERS_PENDING`, inspect every id in `triggerIds` with `ravi triggers show <id> --json`. Repoint each to its durable owner using `ravi triggers set <id> replySession <parent-session>`, inspect the saved target and activation verdict, then retry `ravi sessions close-thread`. Do not disable a live CI follow merely to close its thread. Generated `gh-follow` subscriptions use the parent automatically; maintenance repairs old thread targets, including closed/pruned children.

## Configure a child's runtime

From the authorized channel-root parent, find the child with
`ravi sessions threads --all --json`, then use:

```bash
ravi sessions thread-configure <thread> --effort ultra --json
ravi sessions thread-configure <thread> --provider codex --model gpt-6-astra --json
ravi sessions thread-configure <thread> --effort clear --json
```

Inspect `changed`, the prior/current overrides, and `thread.runtime` in the
readback. The configuration applies on the next turn; this command does not
start one. An existing closed thread remains closed. `--session <parent>` is
only for an operator/context already authorized to modify that parent.
Provider changes retain the separate agent-configuration authority check.
The operation does not authorize generic history access or session management.
