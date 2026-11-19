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

A PM2 manager/client version warning on `jlist` stdout does not invalidate the
following JSON and does not require `pm2 update` as a Ravi prerequisite.
Diagnose a state guard refusal separately: a missing default manager PID file
uses live parent verification as documented by `quality/state-boundary`.
Do not revert the inert-stdin launcher or fabricate boot receipts to grant
access; neither is the guard's authority.

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
the ownership protocol require a stop-first upgrade. A failed migration
authorizes no database or package downgrade by hand: the update's own rollback
(below) restores both together from its snapshot.

## Detached runs

- Run inside the daemon's process tree, `ravi update` answers at once with
  `mode: "handoff"`, a `runId`, and the paths of the log and the result. The
  session that asked may be interrupted when the daemon restarts. Read the
  outcome in `~/.ravi/updates/<runId>/result.json`, and the detail in `log`.
- `UPDATE_DETACH_FAILED` means nothing was installed or stopped. Run
  `ravi update` from a terminal.
- An older CLI that reports "PM2 did not converge" while both processes still
  run the previous release, with `~/.ravi/updates/supervisor-refused.json`
  present, hit the supervisor's refusal inside the daemon tree. Nothing was
  stopped. Run `ravi update` again: the CLI it installed detaches first.

## Rollback

- `UPDATE_ROLLED_BACK`: the target did not converge, and the previous release
  runs again on its state as of the snapshot. `~/.ravi/updates/supervisor-result.json`
  names the window that left the live state and where the target's files are
  (`candidateDir`). Report the failure with `~/.ravi/updates/supervisor.log`
  before trying that target again.
- `UPDATE_ROLLBACK_FAILED`: run the commands in the message, in order. The step
  says what the rollback left:
  - `stop`: nothing was restored. Do not start the previous release on this
    state.
  - `restore`: do not start any release; `restore.json` and `manifest.json` in
    the snapshot directory say which files moved.
  - `reinstall`, `start`, `verify`: the state is restored. Install and start
    the previous release.
- A CLI older than this change may report "did not converge" while the
  supervisor is still rolling back. Wait for `supervisor-result.json` before
  acting.
- `UPDATE_SNAPSHOT_SPACE`: nothing was stopped. Free the space the message
  names and run the update again. Do not delete `~/.ravi/updates/snapshots/`
  while an update runs.
