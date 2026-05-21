# Restart Active Session Resume / RUNBOOK

## Debug Flow

1. Identify the restart epoch and restart reason/message.
2. Inspect the shutdown/runtime snapshot for live sessions.
3. For a missing resume event, check the session's latest activity time and whether it was non-idle.
4. Confirm the session was inside the 1h restart resume window.
5. Check idempotency records for `(restart_epoch, session_key)`.
6. Inspect session trace for the restart resume event.
7. If the event exists but the agent did not continue, debug dispatcher/provider startup for that session.

## Expected Trace Shape

The implementation SHOULD make these states inspectable:

- restart epoch created.
- eligible sessions selected.
- skipped idle sessions with reason `idle`.
- skipped stale sessions with reason `older_than_restart_resume_window`.
- resume event persisted.
- duplicate delivery skipped with reason `already_delivered`.
- dispatch result for the resume event.

## Useful Queries

```bash
ravi sessions trace <session> --since 2h --explain
ravi sessions trace <session> --only dispatch --since 2h
ravi daemon logs --tail 200
```

## Classification

- **No resume event, session idle**: expected.
- **No resume event, last activity older than 1h**: expected.
- **No resume event, active inside 1h**: bug in eligibility, snapshot, or boot fan-out.
- **Duplicate resume event for same restart epoch**: idempotency bug.
- **Resume event delivered but output goes to wrong chat**: output-target/session attach bug, not restart fan-out.
- **Resume event delivered but pending user message lost**: runtime/session-continuity bug.

