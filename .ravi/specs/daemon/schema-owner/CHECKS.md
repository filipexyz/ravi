# Checks

- `bun test src/db/schema-lock.test.ts`: real subprocess contention, kernel ownership through pause/crash, alias handling, descriptor inheritance and transaction semantics.
- `bun test src/cli/commands/daemon-restart-supervision.test.ts`: standby evidence, PID incarnation, predecessor preservation and readiness after cutover.
- `bun test src/cli/commands/daemon-schema-cutover.test.ts`: the real supervisor function with subprocess owners and a simulated PM2 registry; no database activity before predecessor exit, including a failed stop.
- `bun test src/db/schema-owner.test.ts`: owner/consumer marker semantics after integration with the state boundary.
- `bun test src/db/journal-mode-retry.test.ts`: failed journal setup cannot leave a cached handle in chat, router or Devin; retry initializes a fresh connection, including when cleanup itself throws.
- `bun test src/cli/commands/daemon-start-ready.test.ts`: the first-start wait returns only for PM2 `online` plus a `ready` receipt of the same PID and start; PM2 `online`, `owned` or `waiting` alone never count; `errored` and `stopped` end it at once; it never sleeps past its bound.
- `bun test src/cli/commands/daemon.test.ts -t "DaemonCommands start on a new installation"`: a first start keeps asking PM2 until the receipt appears, warns on stderr and exits 0 when none does, stops at `errored`, and does not wait when the state already exists; `--json` keeps stdout a single document.
- `bun test src/cli/commands/setup.test.ts`: the wizard runs the daemon before the agent and settings steps and skips them, saying `Configuração incompleta`, when the state is not ready; `stateIsReady` hides no failure other than `STATE_SCHEMA_NOT_READY`; `docs/start/install.mdx` lists the daemon before `ravi settings set` and before the wizard's state steps.
- Focused credentials table-rebuild and router/outbox migrations must keep their existing tests and child-reference preservation.
- Run the spec/coverage gate with a disposable `RAVI_STATE_DIR`; full build/typecheck/suite run in PR CI, never on the production host.
