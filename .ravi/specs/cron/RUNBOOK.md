# Cron / RUNBOOK

## Shell Job Disabled By Ownership

`cron list` displays `disabled-owner`; `cron show <id> --json` reports
`ownershipError: CRON_SHELL_NOT_OPERATOR`. Before the scheduler reconciles an
enabled invalid row, text list shows `invalid-owner`. Inspection does not write.

The scheduler keeps the row and previous execution history, clears its next run
and sends one notice to the default agent's main session. Check daemon logs if
the notice was not delivered. There are no repeated run failures for this state.

The operator can recreate the command from their own authenticated turn or
convert the job to an agent prompt. Do not blindly enable the same invalid job
or change its owner in the DB. Correcting ownership never auto-enables it.

Rollback of the code does not enable rows already disabled; inspect each one
before an explicit operator recovery. No production data is deleted.

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

## Admission snapshot diagnosis

A run records `cronRunAuthority` in runtime context metadata. Compare its admitted
owner with `cron show` only to explain a later transfer; never repair the running
turn by substituting the current owner. `enabled=false` stops future scheduled
runs, not the current one. A blocked/deleted admitted contact loses subsequent
owner-attributed access. An old queued run without a snapshot fails closed; after
review, admit a new run through the scheduler or explicit manual run. No deployment
or restart is part of validating this contract in isolated tests.
