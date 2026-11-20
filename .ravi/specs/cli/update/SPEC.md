---
id: cli/update
title: "Package update and managed runtime reconciliation"
kind: capability
domain: cli
capabilities:
  - update
tags:
  - cli
  - pm2
  - lifecycle
applies_to:
  - src/cli/commands/update.ts
  - src/managed-runtime-rebind.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Package update and managed runtime reconciliation

## Invariants

- `ravi update` MUST reconcile every managed Ravi process that was online
  before the package update, including `ravi-channels`. Restart is mandatory;
  there MUST NOT be a `--no-restart` or equivalent bypass.
- Reconciliation MUST verify the successor's boot identity against the updated
  bundle. A new disk package version or matching PM2 path alone MUST NOT prove
  a live process adopted the update.
- A managed process that was stopped MUST NOT be started by the update. One
  exception: the waypoint (below) starts a stopped channel runner for its boot
  record and removes it again before the update to the target, with a warning.
- The result MUST expose warnings naming stale or unverifiable siblings and
  the explicit commands needed to reconcile them. Missing native intake MUST
  be reported when native channels are enabled.
- A failed reconciliation MUST fail the update result even if package
  installation succeeded. It MUST NOT claim the runtime is updated.
- An unreadable PM2 snapshot MUST fail closed; it MUST NOT be treated as an
  empty installation. Supervisor exit zero MUST be checked against live
  successor identities before the calling update reports success.
- Leading PM2 version/diagnostic banners MUST NOT make an otherwise valid
  `jlist` snapshot unreadable. All registry readers MUST share the parser and
  reject malformed/truncated/non-array payloads without logging registry data.
- Failed PM2 reads and build/reconciliation failures MUST retain their caught
  cause through the public diagnostic. A boot receipt persistence failure MUST
  emit a diagnostic warning while leaving the process identity unverifiable.
- Runtime-rebind tests MUST own and clean up their state directory independently
  of the package fixture and any caller-provided `RAVI_STATE_DIR`; tests MUST
  restore the inherited environment and leave the caller's receipts untouched.
- This restart mandate belongs to the explicit `update` operation. Status
  reads and env-file mutations MUST NOT automatically restart processes.
- Managed launchers MUST survive replacement of the installed package. PM2
  MUST execute the daemon bundle directly through the inert-stdin launcher,
  without selecting its Bun container because a parent directory contains
  `bun`. The launched argv and process registration MUST satisfy the existing
  state boundary without relaxing its identity checks.
- Daemon and channel registration MUST clear inherited session, gateway and
  supervisor routing context, including context retained by the PM2 manager.
  Starting a service MUST NOT turn it into a remote CLI invocation. PM2
  registration MUST overwrite retained context with empty tombstones, and the
  shell launcher MUST unset those keys before executing Bun. The application
  MUST receive absent context keys; an explicit empty context key is invalid
  broker caller identity and MUST NOT be accepted as local authority.
- The channels launcher MUST preserve its existing PM2 identity: canonical Bun
  executable and exactly `[bundle, "channels", "run"]` arguments. Its shell
  MUST clear context before exec without routing through PM2's Bun container.
  Bun installation directories containing spaces and quotes MUST remain valid.
  The launcher MUST pin executable lookup to canonical Bun, retain the package
  working directory, and reject an unsupported canonical executable filename
  or a conflicting package-local filename/PM2 process name/namespace before
  stopping any process. PM2
  itself MUST be resolved in the original caller PATH before Bun PATH is pinned.
- Operator CLI commands targeting real state MUST run in the operator's
  terminal, on that state, as a schema consumer (`quality/state-boundary`).
  Local lifecycle and recovery operations MUST remain usable when the daemon
  is unavailable or state is not prepared for the installed release, without
  opening or migrating real databases. Runtime contexts MUST never gain an
  operator fallback.
- Update MUST prepare and validate its launcher before disrupting managed
  processes, and wait for the new daemon's exact-release readiness before
  starting channel consumers. A failed candidate MUST NOT be reported as
  recovered based only on PM2 online or a boot receipt. Recovery MUST preserve
  schema ownership. A database is rolled back only together with its package,
  from a snapshot taken while no process owned the stores ("Snapshot and
  rollback" below); nothing else rolls a database back.

## Waypoint and stability (supervisor)

These rules run in the supervisor, which is the target release's bundle, so
the refusals also hold for an update started by an older CLI. The text of a
refusal does not: an older CLI starts the supervisor with its output ignored
and does not read `supervisor-refused.json`, so it prints its own generic
failure; the refusal's text reaches the operator on the next run, through the
CLI that run installed.

- A state written before the thread fence (`adopt-on-start`) that a release
  older than 3.261113.2 last prepared, or that has no readiness markers
  (`state_schema_versions`, `1:<release>`), needs the waypoint 3.261113.2.
  When the update can roll back (a global install whose running release
  proved itself with a boot receipt) and that release is older than the
  waypoint, the supervisor MUST take the waypoint by itself. A daemon online
  under PM2 with no boot receipt for its process (a release before
  3.261104.2) MAY take it too, with a rollback to the release known by weaker
  evidence, and only with every guard: PM2's record of the daemon
  (`pm2_env.version`, which PM2 reads from the package.json nearest the
  script each time it launches it), only when that script is inside this
  install's package (not a launcher or another install) and the version is a
  Ravi release before 3.261104.2; or the operator's `--running-release`,
  which MUST be such a release and MUST agree with PM2's record when that one
  is usable. A daemon with a receipt is decided by the receipt alone, and a
  `--running-release` given then MUST be reported as not used. Whatever
  fails MUST refuse with the reason (fail closed, never a guess), and the
  refusal MUST ask for `--running-release` only when that settles it (PM2's
  record missing, not a Ravi release, or not the daemon's). After such a
  rollback the restored release is proven by PM2's record (launched from this
  install's package, with that version), as it writes no receipt.
  Taking the waypoint:
  - stop both processes and snapshot the state, as an update that can roll
    back does. Without that snapshot the waypoint MUST NOT be taken, and the
    supervisor MUST bring the release that wrote the state back on it by
    itself, with nothing to restore (the state is untouched): install it in the
    same place and start it through its own CLI, as a rollback does, once every
    stopped process has exited. A stopped process that never exits, or a
    release that cannot be installed or started again, leaves the host
    stopped; the result then names the commands;
  - install 3.261113.2 in the same global install and start the daemon, then
    the channel runner, through its own CLI (`daemon start`, `channels
    start`), without target routing or runtime context, and with installs run
    outside the package directory they replace; both, because the target's
    adoption needs a boot record of each, so a runner that was stopped runs
    for that time, and the result MUST say so in its warnings once the hop got
    that far (and that it may have run, when the hop stopped while starting). The daemon counts only at schema
    phase `ready` (the same process, for the whole window) before the runner
    starts;
  - count the waypoint once the state shows its readiness markers (3.261113.2
    or later) and the last boot record of `ravi` and `ravi-channels` was
    written by 3.261113.2 with its bundle, and both held for the stability
    window;
  - install the target again and update from the waypoint to the target, as
    any update (its own snapshot, and a rollback to the waypoint). That pass
    MUST keep the snapshot taken before the waypoint until the next update,
    and its space check MUST NOT count that kept snapshot as room,
    and record whatever ends it, also a return before it could roll back. A runner
    that was stopped before the update MUST be removed again before that
    pass, so it stays stopped. A second waypoint on that pass MUST NOT be
    taken, and a pass that stops before it begins MUST be recorded as
    `failed`, with the waypoint running on the state it prepared.
  A waypoint that fails to install, start, prepare the state or hold, or
  throws, MUST roll back to the release that wrote the state (its snapshot and its exact
  release), and the result says the waypoint failed. A target that cannot be
  installed again leaves the waypoint running on the state it prepared, and the
  result names the commands to install the target and retry, the install first:
  the package directory may hold no runnable bundle.
- Otherwise (a source checkout, no rollback, or a running release not older
  than the waypoint), before it stops anything, the supervisor MUST refuse with
  `UPDATE_WAYPOINT_REQUIRED`. The refusal MUST name the exact commands: `ravi update --version 3.261113.2`,
  `ravi daemon status`, then `ravi update --next`. A source checkout does not
  accept `--version`, so there the refusal MUST give the checkout steps
  instead, as commands that run as written, the path in POSIX single quotes:
  `git -C '<checkout>' fetch --tags`,
  `git -C '<checkout>' switch --detach v3.261113.2`, build, then
  `ravi daemon restart -m "waypoint"` and `ravi channels restart`. It MUST say that the installed package (or the checkout) is
  already the target release, because a restart before the waypoint would
  start it on that state.
- After the runtime converges and PM2 is saved, the supervisor MUST watch the
  converged processes for a stability window (30 s by default,
  `RAVI_UPDATE_STABILITY_WINDOW_MS`, at most 300 s). A new PID or start time,
  or a runtime that stops being converged, MUST fail the update instead of
  reporting success. PM2 reads count inside the window: it MUST end by its
  deadline even when each read is slow.
- The window MUST end before the starting CLI stops waiting. The CLI declares
  its wait in `RAVI_UPDATE_SUPERVISOR_BUDGET_MS`, and the supervisor keeps 10 s
  of that budget for its exit and the CLI's verification. With no declaration
  (a CLI that predates the window, which waits 30 s up to 3.261113.2 and 90 s
  from 3.261113.3) the supervisor MUST NOT run a window: it answers right
  after convergence, as before the window existed.
- `ravi daemon restart` and `ravi daemon start` do not check the waypoint yet
  (follow-up): after a waypoint refusal, the next step is the commands the
  refusal names, not a restart.
- A refusal before any stop MUST be left in
  `<state>/updates/supervisor-refused.json`. The CLI MUST capture the
  supervisor's output in `<state>/updates/supervisor.log`, read a refusal
  recorded since the supervisor started, and fail with that code and message
  instead of a generic convergence failure. Any other failure MUST name the
  supervisor log.
- Still open: the refusal comes after the package is installed, and a process
  that was stopped stays stopped (the CLI that verifies the result predates a
  change to that rule).

## Snapshot and rollback (supervisor)

- An update can roll back when the target is a global install (bun or npm),
  the daemon that was running proved its release with a boot receipt and ran
  from that same install, and that release is not the target. Any other update
  MUST run as before: no snapshot, no rollback, coordinated replacement where
  it applied. Source checkouts keep that behaviour.
- One update supervisor MUST run per state directory: it holds
  `<state>/updates/update.lock` for its whole life, and a second one MUST
  refuse with `UPDATE_IN_PROGRESS` before any stop (recorded and read back like
  the waypoint's refusal). The lock is released with its process.
- Before any stop, an update that can roll back MUST plan its snapshot. The
  stores are `runtimeStateDatabasePaths` with each database's `-wal` and
  `-journal`. It MUST refuse with `UPDATE_SNAPSHOT_SPACE` before any stop when
  the state disk cannot hold the copy: on a filesystem without copy-on-write
  clones, the stores' size plus the larger of 10% and 256 MiB, against free
  space plus earlier snapshots; with clones, 256 MiB plus any store on another
  disk, against free space only (an earlier clone shares its blocks with the
  live stores, so deleting it frees almost nothing). A store on another disk
  MUST also have its size plus that margin free on its own disk, for the
  restore. The refusal is recorded and read back like the waypoint's.
- Such an update MUST stop both processes before it starts the target, with no
  coordinated overlap. After the stop it MUST confirm the stopped PIDs exited,
  and it MUST hold every lock a daemon takes before opening a store
  (`daemon-schema-owner.lock` and each `<store>.schema.lock`) while it copies.
  The manifest is written last. Only the latest update's snapshot is kept, in
  `<state>/updates/snapshots/<id>/`.
- A snapshot that cannot be taken after the stop MUST NOT start the target, on
  any update that can roll back (the second pass after a waypoint included):
  the release that wrote the state MUST come back on it by itself, with
  nothing to restore, and the result is `rolled-back`, saying why.
- When the target does not converge, does not stay up for the stability
  window, or the rebind fails after the snapshot, the supervisor MUST roll
  back:
  - remove both processes from PM2 and confirm they exited;
  - under the store locks, put the snapshot back with renames on each disk:
    the snapshot copy of a store on another disk is first copied next to it
    (a failure there moves nothing); then, store by store, the live files
    (including `-wal`, `-shm` and any store the target created) move aside on
    their own disk (`<snapshot>/candidate/`, or `.ravi-update-candidate-<id>/`
    next to a store on another disk), and the snapshot files move into place.
    `restore.json` MUST list every move and whether it was done, updated after
    each one; a restore that stops MUST end the rollback with commands (`mv -n`)
    that finish it, followed by the install and start of the previous release;
  - settle thread fence leftovers;
  - reinstall the previous exact release with the same installer;
  - start the daemon, then the channel runner if it was online, through that
    release's own CLI (`daemon start`, `channels start`), without target
    routing or runtime context;
  - count the daemon only once it reached the schema phase `ready` (its boot
    receipt is written before that); a release older than 3.261109.1 records
    no schema phase, so there its boot receipt and the window decide. Then
    save PM2, verify both identities
    against that release, and hold them for the stability window
    (`RAVI_UPDATE_STABILITY_WINDOW_MS`, 30 s by default, also when the CLI
    declared no budget). A daemon that never gets ready, or a process that
    restarts in the window, MUST end as `rollback-failed`, not `rolled-back`.
- A rollback MUST NOT delete what the target wrote: its files stay in
  `candidate/` until the next update. One snapshot MUST NOT be restored twice
  (`restore.json`).
- The supervisor MUST record `<state>/updates/supervisor-result.json`
  (`converged`, `rolled-back`, `rollback-failed` or `failed`) with the snapshot
  time, the restore time and where the target's files are. A failed rollback
  also records its step and the manual commands for the state it left; an
  error thrown inside a step MUST end as a failure of that step, and one
  thrown by the rollback itself as `rollback-failed` at step `unknown`, with
  where to read what it did. The commands for a rollback that stopped before
  any restore MUST move every live file of each store aside (WAL and shared
  memory included) before a snapshot file comes back. The CLI
  waits up to 15 min and fails with `UPDATE_ROLLED_BACK` or
  `UPDATE_ROLLBACK_FAILED` from that record. A CLI that stops waiting earlier
  reports a generic failure, and the record still holds the outcome.

## Operator rollback (`ravi update --rollback`)

- `ravi update --rollback` MUST go back to the release before the last update,
  with its state as of that update's snapshot, through the update's own
  rollback: stop both processes, restore under the store locks, reinstall
  the exact previous release in the same global install, start it through
  its own CLI, and hold it for the stability window. With `--execute` all of
  it MUST run in the update supervisor, the same detached process as an
  update's rebind, which outlives the command: a closed terminal, a lost SSH
  session or a Ctrl-C after the first stop MUST NOT cut it. The supervisor
  MUST make the plan again under the update lock and refuse, before any stop,
  when the latest snapshot is not the one the preview named; the outcome goes
  to `<state>/updates/supervisor-result.json`, which the command reports.
- It MUST be a preview unless `--execute` is given (the contract's dry-run,
  exit 3), naming the release it leaves, the release it goes back to, the
  snapshot's time and where what was written since then is kept.
- Before stopping anything it MUST refuse with `UPDATE_ROLLBACK_UNAVAILABLE`
  when there is no update snapshot, when the latest one was already restored
  (or a restore of it was cut short), when a copy its manifest lists is
  missing, cannot be read or is not the size it was copied with, when the
  daemon does not run
  from a global install, when the daemon's verified release is not the target
  of that update, when the command's own release is not the one installed
  where the daemon runs from (the rollback runs in that install's supervisor),
  or when the caller runs inside the daemon's process tree. The rollback
  itself, automatic or not, MUST check the snapshot's copies again before its
  first `pm2 delete` and stop nothing when one is gone. Its request to the
  supervisor MUST be schema 2, which a supervisor from before
  `ravi update --rollback` refuses instead of reading it as a rebind. Before
  planning, it MUST refuse with `UPDATE_IN_PROGRESS` while another process's
  supervisor holds the update lock (an update, or a rollback whose command was
  cut), pointing at `supervisor-result.json` and `supervisor.log`; that probe
  records no refusal and creates nothing where no update ever ran. Only then, when neither process runs under PM2 next to an
  unused snapshot (a rollback cut after its stop), the refusal MUST say so and
  give the commands that finish it by hand: the snapshot's restore and the
  previous release's install and start, or, once a restore ran, its
  `restore.json` and the install and start; a snapshot that cannot be put back
  gives only the start of the release that wrote the state. Commands in a refusal or a failure
  MUST come one per line after where they are kept (`finish-by-hand.txt` next to
  the snapshot, written by a run with `--execute` and never by the preview, or
  `supervisor-result.json`): a message line past 2048
  characters reaches the operator as `[redacted:oversize]`. A result the
  supervisor cannot write MUST NOT turn a rollback that ran into a failure.
- Before any stop, an update that can roll back and `ravi update --rollback`
  MUST find the release they would install again in the registry the
  installer reads (a probe with a timeout), and refuse otherwise
  (`UPDATE_PREVIOUS_RELEASE_UNAVAILABLE` for an update,
  `UPDATE_ROLLBACK_UNAVAILABLE` for the rollback): found out after the stop,
  the host stays down. After the probe, the update MUST check again that each
  managed process is the one it started from (pid and start time) and refuse
  with `UPDATE_RUNTIME_CHANGED` before any stop or snapshot when PM2 started
  one again meanwhile (a PM2 read that fails is tried once more first): that process runs the installed target, and the
  snapshot would keep its writes as the previous release's state. The registry is the installer's: its environment
  (`BUN_CONFIG_REGISTRY` for bun, `npm_config_registry`), then `~/.npmrc` (the
  last `registry=` line; bun reads it over its `bunfig.toml`), then bun's
  `[install] registry`, then `https://registry.npmjs.org`.
- The probe reads secrets and MUST keep them. It sends the credential the
  installer would send to that registry, to its host only, in the request
  header: the token, or the user and password, of bun's `[install] registry`
  entry when that entry is the registry used; a `user:password@` in the
  address, as Basic and taken off the address asked; otherwise what
  `~/.npmrc` gives that host (`_authToken`, then `_auth`, then `username` with
  `_password`). None of them is ever printed, logged or recorded; a 401 or 403
  names which one went along, never its value; a message, a recorded
  refusal (`supervisor-refused.json`) or an error cause names the registry
  without user, password, query and fragment, and the error of the request
  goes on only as its name, code and a message with those taken out. Only an
  http or https registry is asked or named: any other value (`user:pw@host`
  parses as a scheme) is refused without being echoed.
- It takes no release selector, and `--execute` without `--rollback` is a
  usage error. Its supervisor MUST hold `<state>/updates/update.lock` while it
  runs (`UPDATE_IN_PROGRESS` when another update holds it). A rollback that stops
  MUST end as `UPDATE_ROLLBACK_FAILED` with the step and the commands.

## Detached execution

- `ravi update` started inside the daemon's process tree (an agent tool, a
  cron shell job, a hook) MUST NOT install, stop or rebind anything in that
  process. It MUST hand the request to a detached child, which starts a worker
  and exits at once, so the worker is reparented outside the tree. The caller
  returns the run id, the log path and the result path.
- If the detached child cannot be started, the update MUST be refused with
  `UPDATE_DETACH_FAILED`. It MUST NOT fall back to running inline. A launch
  counts as started only after the process reports `spawn`; a launch failure
  reported as an `error` event MUST take the same refusal path and MUST NOT
  escape as an unhandled event.
- Whether the caller is inside the daemon's process tree MUST come from a
  strict PM2 read, tested against every registration named `ravi` (a
  supervised restart lists the successor and the predecessor at once). A PM2
  that cannot be read, and an ancestry that cannot be read (`/proc` on Linux,
  `ps` otherwise), loops or is deeper than the walk, is an unknown position
  and MUST NOT be taken for "outside": the CLI MUST refuse with `UPDATE_FAILED` before it
  detaches, installs or stops anything, and the supervisor MUST refuse as below.
  Usage errors are reported before the read. The detached child and the worker
  decide by their run markers and MUST NOT read PM2 for that decision.
- The worker MUST confirm it is outside the daemon's process tree before it
  installs anything; a PM2 read that fails during that wait counts as still
  inside. If it is still inside after the wait, it MUST refuse with
  `UPDATE_DETACH_FAILED` and record that result.
- The detached run MUST NOT carry runtime context. Every `RAVI_*` key except
  `RAVI_HOME`, `RAVI_REPO` and `RAVI_SUPPRESS_AUDIT_EVENTS` MUST be removed;
  `RAVI_STATE_DIR` MUST be passed as an absolute path. A relative value was
  handed down by a daemon that predates the boot anchor and MUST be resolved
  against the cwd of the daemon whose tree holds the caller (from the same PM2
  read), never the caller's, as in
  `ravi daemon restart` (#857). The run directory MUST use the same resolved
  path. A relative value with no readable daemon cwd MUST be refused with
  `UPDATE_DETACH_FAILED`.
- Without a selector, the handoff MUST resolve the channel from the saved
  channel in that same resolved state directory (never one relative to the
  caller's cwd) and pass it to the worker as `--next` or `--stable`, so the
  worker installs what the caller was told.
- Each detached run MUST keep `request.json`, `log` and `result.json` under
  `<state>/updates/<runId>/`. The run id MUST match
  `^\d{8}T\d{6}Z-[0-9a-f]{6}$` before it is used as a path. Results MUST be
  written atomically.
- The run markers (`RAVI_UPDATE_HANDOFF`, `RAVI_UPDATE_HANDOFF_WORKER`,
  `RAVI_UPDATE_RUN_ID`) MUST NOT reach anything the worker starts: the worker
  MUST remove them from its environment before it installs anything, and PM2
  registrations MUST clear them like runtime context. Only the run's own
  processes write its `result.json` (the worker, or the detached child when it
  cannot start the worker); an inline update that inherited a run id MUST NOT
  write to that run.
- The update supervisor (`RAVI_INTERNAL_UPDATE_RUNTIME_REBIND`) MUST refuse
  with `UPDATE_REFUSED_IN_DAEMON_TREE` when it runs inside the daemon's process
  tree or cannot read PM2 to tell. The refusal MUST happen before it reads its
  request or stops anything in PM2, and it MUST leave
  `<state>/updates/supervisor-refused.json` with the reason. Only a CLI that
  predates detached execution starts a supervisor there.
- The refusal of the root command in a runtime context (`CLI_ONLY`) is
  unchanged by detached execution.
