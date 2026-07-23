# Presence Lifecycle / CHECKS

## Checks

- `bun test src/gateway-session-trace.test.ts src/gateway-typing.test.ts src/omni/typing-presence.test.ts`
  MUST pass after changing presence lifecycle behavior.

## Regression Scenarios

- Silent response MUST stop presence immediately.
- Final response MUST NOT schedule a delayed renewal that reactivates presence.
- Late runtime activity after terminal event MUST leave presence stopped.
- New user prompt MAY start presence again for that session.
- Runtime `status=idle` without a matching `turn.complete`/`turn.completed`
  MUST stop presence.
- Low-level `provider.raw` passthrough MUST NOT start or renew presence.
- Background automation source with `suppressPresence=true` MUST NOT send
  `typing=true` for runtime activity or interrupts.
- Account-name active target plus instance-id runtime source for the same Omni
  instance MUST renew/stop the existing heartbeat without fallback
  `typing=true` or duplicate pause.
- Presence transitions MUST be queryable with
  `ravi sessions trace <session> --only presence`.
- Presence transitions MUST be replayable from `ravi.presence.typing`.
