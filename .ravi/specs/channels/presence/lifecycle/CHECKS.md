# Presence Lifecycle / CHECKS

## Checks

- `bun test src/gateway-session-trace.test.ts`

## Regression Scenarios

- Silent response -> presence stops immediately.
- Final response -> delayed renewal does not reactivate presence.
- Late runtime activity after terminal event -> presence remains stopped.
- New user prompt -> presence can start again for that session.
