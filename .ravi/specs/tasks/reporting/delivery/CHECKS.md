# Task Reporting Delivery Checks

## Durable State

- `ravi tasks report` MUST reject an empty progress message.
- `ravi tasks done` MUST reject a missing summary.
- `ravi tasks block` MUST reject a missing blocker reason.
- `ravi tasks fail` MUST reject a missing failure reason.
- Every successful mutation MUST emit task events through the task runtime.
- Chat text alone MUST NOT be recorded as durable task progress.

## Report Targeting

- A task without a configured report target MUST NOT publish a report prompt.
- Assignment-level report target and report events MUST override task-level
  values for that assignment.
- An empty or invalid `reportEvents` MUST fall back to `blocked`, `done`, and
  `failed`.
- Report delivery MUST NOT publish for event types outside the effective
  `reportEvents` set.

## Cross-Store Delivery

- The report delivery idempotency key MUST derive from the durable task event,
  target session, and renderer/protocol version and MUST be retry-stable.
- Replay with the same key and payload hash MUST NOT deliver a duplicate report
  prompt.
- A report MUST be marked delivered only after a durable core enqueue receipt
  for the same key and payload hash; enqueue attempt alone is not delivery.
- A conflicting payload hash for an existing key MUST fail closed with repair
  evidence.
- Transient failure MUST stay retryable; terminal failure MUST be an explicit,
  repairable dead-letter state.
- `unavailable` work state MUST defer delivery and MUST NOT be treated as
  `missing`.
- Work modules MUST enqueue report prompts through the typed core session port.

## Return Contracts

- Public report CLI/SDK return contracts MUST remain concrete; `@CliOnly()` and
  weak-baseline expansion MUST NOT be used to avoid schemas.

## Commands

- `bun test src/tasks/service.test.ts src/cli/commands/tasks.test.ts`
- `bun test src/tasks/notify.test.ts src/tasks/checkpoint-runner.test.ts`
- `ravi specs get tasks/reporting/delivery --mode checks --json`
- `bun run typecheck`
