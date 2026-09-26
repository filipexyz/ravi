# Restart Active Session Resume / CHECKS

## Regression Scenarios

- Active turn: start a long-running session turn, restart daemon, expect exactly one restart resume event after boot.
- Multi-session fan-out: keep two sessions non-idle, restart daemon, expect each receives exactly one event.
- Idle exclusion: leave a session idle with no pending work, restart daemon, expect no event.
- Stale exclusion: simulate a non-idle stop snapshot older than 1 hour, restart daemon, expect no event.
- Pending queue: queue a user message behind an active turn, restart daemon, expect the queued user message remains pending and the resume event does not reorder or clear it.
- Awaiting approval: restart while awaiting user approval, expect resume without auto-approval.
- Idempotency: rerun boot resume hook for same restart epoch, expect no duplicate session event.
- Fenced resume: restart while a session's current turn is unsafe to replay (tool started or output emitted) with no durable successors, expect one restart notice with the restart reason, no "Continue de onde parou", and a delivery record with kind `notice`.
- Failed publish: when publishing the restart event fails, expect no delivery record for that session.
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
- A delivery record MUST exist only for an event that was published, and MUST say `resume` or `notice` accordingly.
- Resume MUST select last-used / snapshot provider when no explicit override is present.
- Resume MUST NOT treat the snapshot provider as a launch override that clears a compatible stored id.
- A `/login` or `Not logged in` stub MUST NOT persist on `main` or emit to WhatsApp/Slack via `lastChannel`.

