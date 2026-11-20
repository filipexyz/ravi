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
  outcome in the returned `resultPath` and the detail in `logPath`
  (`<state>/updates/<runId>/`, where `<state>` is `RAVI_STATE_DIR`, `~/.ravi` by
  default).
- `UPDATE_DETACH_FAILED` means nothing was installed or stopped. Run
  `ravi update` from a terminal. With a relative `RAVI_STATE_DIR` the refusal
  can also mean the daemon's cwd could not be read: set an absolute
  `RAVI_STATE_DIR`.
- `UPDATE_FAILED` with "Could not read PM2 runtime status or the process
  ancestry" means Ravi could not tell whether the caller runs inside the
  daemon's process tree, so nothing ran. Check `pm2 jlist` and retry.
- An older CLI that reports "PM2 did not converge" while both processes still
  run the previous release, with `<state>/updates/supervisor-refused.json`
  present, hit the supervisor's refusal inside the daemon tree (or a PM2 it
  could not read; the file says which). Nothing was stopped. Run `ravi update`
  again: the CLI it installed detaches first.

## Waypoint

- A host whose state a release older than 3.261113.2 prepared goes through
  3.261113.2 by itself when the update can roll back (a global install whose
  daemon wrote a boot receipt, 3.261104.2 on). It takes two installs and two
  boots; `supervisor.log` shows each step. A CLI older than this change stops
  waiting before that ends: read the outcome in
  `<state>/updates/supervisor-result.json` before acting, and do not restart
  anything while the update runs.
- `UPDATE_ROLLED_BACK` naming the waypoint: 3.261113.2 did not install, start,
  prepare the state or hold, and the release that wrote the state runs again on
  its own state. Report the step from the message.
- `UPDATE_ROLLED_BACK` with "no snapshot ... could be taken": the waypoint was
  not taken, and the release that wrote the state runs again on it, untouched.
  Fix what the warning names (a process that did not exit, a store still
  owned, a copy error), then run the update again. If that rollback failed,
  the result says why: a stopped process never exited (nothing starts beside
  it; run the commands once it is gone), or the release could not be
  installed or started again (run the commands when the registry answers).
- A runner that was stopped ran while the waypoint took its boot record, and
  could process queued inbound and outbound messages meanwhile; the result's
  warnings say so.
- `failed` with "could not be installed again": 3.261113.2 runs on the state it
  prepared, which is a valid release of its own. Run the commands the result
  names, the install first (the package directory may hold no runnable bundle),
  when the registry answers.
- After the waypoint and the update to the target, two snapshots are kept until
  the next update: the target's way back to 3.261113.2, and the state before
  the waypoint, of the release that wrote it (for a restore by hand).
- `UPDATE_WAYPOINT_REQUIRED`: the update could not take the waypoint by itself
  (a source checkout, a daemon with no boot receipt, or a running release not
  older than the waypoint). Nothing was stopped; run the commands it names.

## Going back by hand

- `ravi update --rollback` shows the way back to the release before the last
  update: the release it leaves, the one it restores, the snapshot's time and
  where what was written since then is kept. Add `--execute` to do it, from a
  terminal. It works only from the release that update installed, and only
  once per snapshot.
- With `--execute` the rollback runs in the update supervisor, which goes on
  if the terminal closes: then read `<state>/updates/supervisor-result.json`
  (and `<state>/updates/supervisor.log`) before acting.
- `UPDATE_ROLLBACK_UNAVAILABLE`: this run stopped nothing; the message says why
  (no snapshot, already restored, a source checkout, a daemon on another
  release, or a caller inside the daemon's tree). When it says Ravi is not
  running under PM2, an earlier rollback was cut after its stop: run the
  commands it gives, in order, with nothing started meanwhile.

## Rollback

- `UPDATE_ROLLED_BACK`: the target did not converge, and the previous release
  runs again on its state as of the snapshot: its daemon reached `ready` and
  both processes held for the stability window. `<state>/updates/supervisor-result.json`
  names the window that left the live state and where the target's files are
  (`candidateDir`; a store on another disk keeps them next to it, in
  `.ravi-update-candidate-<id>/`). Effects outside the state that the target
  had in that window (a message sent, a cron run) are not undone and may
  happen again under the previous release. Report the failure with
  `<state>/updates/supervisor.log` before trying that target again.
- `UPDATE_ROLLBACK_FAILED`: run the commands in the message, in order. The step
  says what the rollback left:
  - `stop`: nothing was restored. The commands stop both processes, move every
    live file of each store aside (WAL and shared memory too), put the
    snapshot files back, then install and start the previous release. Do not
    start the previous release on the current state.
  - `restore`: do not start any release before the restore is finished.
    `restore.json` in the snapshot directory lists every move and whether it
    was done; the commands (`mv -n`, which never replaces a file) finish it,
    then install and start the previous release. When the message says
    nothing was moved, the state is still the target's.
  - `reinstall`, `start`, `verify`: the state is restored. Install and start
    the previous release; `start` and `verify` also name its log.
  - `unknown`: the rollback itself failed. `restore.json` says whether the
    state was restored; read it before running anything.
- A CLI older than this change may report "did not converge" while the
  supervisor is still rolling back. Wait for `supervisor-result.json` before
  acting.
- `UPDATE_SNAPSHOT_SPACE`: nothing was stopped. Free the space the message
  names (the state disk, or the disk of a store that lives elsewhere) and run
  the update again. Do not delete `<state>/updates/snapshots/` while an update
  runs.
- `UPDATE_IN_PROGRESS`: another update supervisor runs on this state; nothing
  was stopped. Wait for its outcome in `supervisor-result.json`, then run the
  update again if it is still needed.
