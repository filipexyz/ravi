# Checks

- `bun test src/db/schema-lock.test.ts`: real subprocess contention, kernel ownership through pause/crash, alias handling, descriptor inheritance and transaction semantics.
- `bun test src/cli/commands/daemon-restart-supervision.test.ts`: standby evidence, PID incarnation, predecessor preservation and readiness after cutover.
- `bun test src/cli/commands/daemon-schema-cutover.test.ts`: the real supervisor function with subprocess owners and a simulated PM2 registry; no database activity before predecessor exit, including a failed stop.
- `bun test src/db/schema-owner.test.ts`: owner/consumer marker semantics after integration with the state boundary.
- `bun test src/db/journal-mode-retry.test.ts`: failed journal setup cannot leave a cached handle in chat, router or Devin; retry initializes a fresh connection, including when cleanup itself throws.
- Focused credentials table-rebuild and router/outbox migrations must keep their existing tests and child-reference preservation.
- Run the spec/coverage gate with a disposable `RAVI_STATE_DIR`; full build/typecheck/suite run in PR CI, never on the production host.
