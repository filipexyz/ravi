# Cron Target Resolution / RUNBOOK

## Interpreting Target Resolution States

### `ok`

No action needed. The agent exists and reply routing resolves.

### `agent_missing`

The job references an `agentId` that is not registered.

```bash
ravi cron show <id>      # Confirm the agentId
ravi agents list          # Check available agents
ravi cron set <id> agent <valid-agent>
```

### `reply_session_missing`

The `replySession` does not resolve to a live session. The runner may still
execute using the agent's main session, but channel delivery is not targeted.

```bash
ravi cron show <id>
ravi cron set <id> reply-session -   # Clear if no longer needed
```

### `derived_key`

Reply routing falls back to parsing the session key for channel info. This
works but is fragile. Consider setting an explicit reply session or clearing
the stale value.

```bash
ravi cron show <id>
```

### `unresolved`

Catch-all for targets that could not be classified. Inspect the job manually.

```bash
ravi cron show <id>
```
