# Slack Chat Actions Runbook

```bash
ravi sessions actions --json
ravi slack permissions-list --json
ravi channels status --json
ravi sessions trace <session>
```

- `missing_scope`: update the Slack app scopes, reinstall it and refresh the
  brokered connection.
- `cant_update_message` or `cant_delete_message`: verify the message was
  authored by this bot and is a supported normal message.
- queued action with no terminal event: inspect the channel runner and durable
  outbound receipt by idempotency key.
- `thread.create` root delivered but child absent: inspect
  `slack_thread_lifecycle`, then the daemon subscription to the originating
  session's delivery events.
- `thread.close` never calls Slack; debug the child lifecycle and parent prompt
  publication instead of Slack scopes.
- Never add an Omni instance mapping as a workaround for a native Slack action.
