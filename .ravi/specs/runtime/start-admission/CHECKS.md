# Checks

Run focused tests with `RAVI_STATE_DIR` set to a disposable directory before Bun imports any module; disable automatic dotenv loading. Never use production state.

- `bun --no-env-file test src/runtime/start-admission.test.ts`: pressure eviction, serving-work guards, background reservation, concurrent A/B/C starts, independent TTL, watchdog rejection and occupant telemetry.
- `bun --no-env-file test src/runtime/session-dispatcher.test.ts`: admission refusal, canonical traces, bootstrap/skip-turn preservation, queue lifecycle and task boundaries.
- `bun --no-env-file test src/runtime/prompt-subscription.test.ts`: immediate receipt despite blocked dispatch, FIFO within a session, independent sessions, inbox-before-ACK, persistence failure, duplicate fencing after SQLite reopen, explicit resumption.
- `bun --no-env-file test src/channels/presence-consumer.test.ts`: a delayed Slack presence call cannot stall another session; start/stop remain ordered within a session.
- `bun --no-env-file test src/gateway-session-trace.test.ts`: receipt starts presence, refusal stops it, normal terminal/suppression behavior remains.
