# Restart Active Session Resume / CHECKS

## Regression Scenarios

- Active turn: start a long-running session turn, restart daemon, expect exactly one restart resume event after boot.
- Multi-session fan-out: keep two sessions non-idle, restart daemon, expect each receives exactly one event.
- Idle exclusion: leave a session idle with no pending work, restart daemon, expect no event.
- Stale exclusion: simulate a non-idle stop snapshot older than 1 hour, restart daemon, expect no event.
- Pending queue: queue a user message behind an active turn, restart daemon, expect the queued user message remains pending and the resume event does not reorder or clear it.
- Awaiting approval: restart while awaiting user approval, expect resume without auto-approval.
- Idempotency: rerun boot resume hook for same restart epoch, expect no duplicate session event.
- Caller preservation: session that invoked `ravi daemon restart` still receives its restart notice according to `daemon/restart/context-preservation`.

## Suggested Tests

- `bun test src/cli/commands/daemon.test.ts`
- `bun test src/runtime/session-dispatcher.test.ts`
- `bun test src/runtime/session-trace.test.ts`
- A focused future test for restart resume eligibility and idempotency.

## Hard Requirements

- No direct channel send is used for fan-out resume.
- The 1h window is enforced before event persistence.
- Idle sessions are not woken.
- Duplicate `(restart_epoch, session_key)` delivery is impossible.

