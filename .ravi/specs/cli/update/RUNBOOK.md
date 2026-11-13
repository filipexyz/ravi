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

The daemon uses `/bin/sh` with a constant inert-stdin command, with the exact
Bun executable supplied separately in the launch environment. No generated
launcher inside the replaceable package is required. Package paths containing
`bun`, whitespace or quotes cannot select PM2's Bun container or change the
daemon's arguments. Direct PM2 registration preserves the separate standby
process required for supervised replacement. Service registration clears session and gateway
context even when the PM2 manager inherited those values earlier.

Installed operator commands use the authenticated local gateway for stateful
work. Recovery/status commands remain available without a running gateway and
without initializing the real database. Source commands still require explicit
isolated state; a runtime context has no operator fallback.

During coordinated replacement, the predecessor remains available until the
successor reaches the ownership barrier. Native intake stops before ownership
transfers, and resumes only after exact-release readiness. Older daemons without
the ownership protocol require a stop-first upgrade. A failed migration never
authorizes an automatic database or package downgrade; inspect the failure and
recover with the same release or a separately validated recovery plan.
