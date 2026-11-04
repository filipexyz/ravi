# Package update and managed runtime reconciliation / CHECKS

- `bun test src/cli/commands/update.test.ts` MUST pass.
- A source-update fixture with two online siblings MUST invoke the rebind
  supervisor, replace both PIDs and verify new boot receipts before success.
- A supervisor exiting zero without replacing processes, a failed runner
  restart, and an unreadable PM2 snapshot MUST each fail the update.
- `ravi update --no-restart --json` MUST reject the removed bypass flag.
- A stopped sibling MUST remain stopped after the rebind plan executes.
- Runtime warnings MUST name the affected process and explicit reconciliation
  command without claiming disk version is the live version.
