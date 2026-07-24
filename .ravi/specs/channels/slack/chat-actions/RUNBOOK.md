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
- Never add an Omni instance mapping as a workaround for a native Slack action.
