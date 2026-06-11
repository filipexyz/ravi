# Presence Lifecycle / CHECKS

## Checks

- `bun test src/gateway-session-trace.test.ts src/gateway-typing.test.ts src/omni/typing-presence.test.ts`

## Regression Scenarios

- Silent response -> presence stops immediately.
- Final response -> delayed renewal does not reactivate presence.
- Late runtime activity after terminal event -> presence remains stopped.
- New user prompt -> presence can start again for that session.
- Runtime `status=idle` without a matching `turn.complete`/`turn.completed` -> presence stops.
- Low-level `provider.raw` passthrough -> presence does not start or renew.
- Background automation source with `suppressPresence=true` -> runtime activity and interrupts do not send `typing=true`.
- Account-name active target + instance-id runtime source for the same Omni instance -> renews/stops the existing heartbeat without fallback `typing=true` or duplicate pause.
- Presence transitions are queryable with `ravi sessions trace <session> --only presence`.
- Presence transitions are replayable from `ravi.presence.typing`.
