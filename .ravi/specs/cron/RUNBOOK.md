# Cron / RUNBOOK

## Stale Agent on a Cron Job

### Symptom

`ravi cron list` shows `agent_missing` for an enabled job.

### Diagnosis

```bash
ravi cron show <id>
ravi agents list
```

The job references an `agentId` that no longer exists.

### Fix

```bash
ravi cron set <id> agent <valid-agent-id>
# or
ravi cron disable <id>
```

## Missing Reply Session

### Symptom

`ravi cron list` shows `reply_session_missing` for an agent job.

### Diagnosis

The `replySession` stored on the job does not resolve to a live session.
The runner falls back to derived-key routing if the session key encodes
channel info.

### Fix

If the reply target is no longer needed:

```bash
ravi cron set <id> reply-session -
```

Otherwise recreate the target session or update the reply-session value.
