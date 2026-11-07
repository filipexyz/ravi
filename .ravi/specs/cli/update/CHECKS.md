# Package update and managed runtime reconciliation / CHECKS

- `bun test src/cli/commands/update.test.ts` MUST pass.
- A source-update fixture with two online siblings MUST invoke the rebind
  supervisor, replace both PIDs and verify new boot receipts before success.
- Every receipt-writing fixture MUST own a disposable state directory, restore
  the caller's `RAVI_STATE_DIR` (including an absent value), and remove its state
  afterward. The managed rebind test MUST pass without an external state override.
- A subprocess regression MUST run the managed rebind test with caller receipts
  already present and prove their contents and directory entries stay unchanged.
- A supervisor exiting zero without replacing processes, a failed runner
  restart, and an unreadable PM2 snapshot MUST each fail the update.
- The PM2 read failure MUST retain both the reconciliation error and the
  underlying command failure in the public diagnostic cause.
- `bun test src/runtime-process-identity.test.ts` MUST verify that an actual
  receipt write failure returns false and emits a diagnostic warning with the
  filesystem cause, without logging receipt or environment-file contents.
- `ravi update --no-restart --json` MUST reject the removed bypass flag.
- A stopped sibling MUST remain stopped after the rebind plan executes.
- Runtime warnings MUST name the affected process and explicit reconciliation
  command without claiming disk version is the live version.
