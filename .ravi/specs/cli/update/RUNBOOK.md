# Package update and managed runtime reconciliation / RUNBOOK

1. Run `ravi update --next`, `ravi update --stable`, or
   `ravi update --version <version>` for the intended release.
2. The command restarts the managed siblings that were online. Allow a brief
   native channel intake interruption during reconciliation.
3. Inspect `ravi daemon status --json` and `ravi channels status --json`.
   Running versions come from boot receipts; disk versions are separate.
4. On reconciliation failure, inspect the named process and follow its
   explicit restart command. Do not infer success from package installation.
5. A stopped runner stays stopped. When native channels are enabled, follow
   the warning with `ravi channels start` if intake should be active.
