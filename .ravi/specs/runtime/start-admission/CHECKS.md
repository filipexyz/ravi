# Checks

Run focused tests with `RAVI_STATE_DIR` set to a disposable directory before Bun imports any module; disable automatic dotenv loading. Never use production state.

- `bun --no-env-file test src/runtime/start-admission.test.ts`: pressure eviction, serving-work guards, background reservation, concurrent A/B/C starts, independent TTL, watchdog rejection and occupant telemetry.
- `bun --no-env-file test src/runtime/session-dispatcher.test.ts`: admission refusal, canonical traces, bootstrap/skip-turn preservation, queue lifecycle and task boundaries.
- `bun --no-env-file test src/runtime/prompt-subscription.test.ts`: immediate receipt despite blocked dispatch, FIFO within a session, independent sessions, inbox-before-ACK, persistence failure, duplicate fencing after SQLite reopen, explicit resumption.
- `bun --no-env-file test src/channels/presence-consumer.test.ts`: a delayed Slack presence call cannot stall another session; start/stop remain ordered within a session.
- `bun --no-env-file test src/gateway-session-trace.test.ts`: receipt starts presence, refusal stops it, normal terminal/suppression behavior remains.

- `src/runtime/prompt-subscription.test.ts` MUST prove two pre-handoff capacity retries, success without inbox, exhaustion with durable receipt, duplicate receipt fencing, and no local retry of ambiguous provider failure.
- `python3 -m unittest discover -s scripts/ops -p 'test_queue_recovery.py'` MUST detect an unstarted child even without recent timeout events, excluding any prior handoff and recent dispatch.
- Dry-run stuck reports MUST NOT consume cooldown or write replay state.
- `src/decisions/decisions.test.ts` MUST emulate transport deduplication: capacity refusal gets a new delivery, ambiguous publication reuses its ID, and admission remains exactly once.
- Idle sessions MUST survive a refused lane when reclaiming every candidate cannot admit it, including outstanding start reservations.
- `src/tasks/thread-core.test.ts` MUST exercise real task admission through the prompt consumer: bounded refusal, inbox-before-ACK, DB reopen, no restart replay, explicit new-transport resumption and exactly one admitted execution.
