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
- A managed process that was stopped MUST NOT be started by the update.
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
  schema ownership and MUST NOT imply a database rollback.

## Waypoint and stability (supervisor)

These rules run in the supervisor, which is the target release's bundle, so
they also hold for an update started by an older CLI.

- Before it stops anything, the supervisor MUST refuse with
  `UPDATE_WAYPOINT_REQUIRED` a state written before the thread fence
  (`adopt-on-start`) that a release older than 3.261113.2 last prepared, or
  that has no readiness markers (`state_schema_versions`, `1:<release>`). The
  refusal MUST name the exact commands: `ravi update --version 3.261113.2`,
  `ravi daemon status`, then `ravi update --next`. It MUST say that the
  installed package is already the target release, because a restart before
  the waypoint would start it on that state.
- After the runtime converges and PM2 is saved, the supervisor MUST watch the
  converged processes for a stability window (30 s by default,
  `RAVI_UPDATE_STABILITY_WINDOW_MS`, at most 300 s). A new PID or start time,
  or a runtime that stops being converged, MUST fail the update instead of
  reporting success.
- The window MUST end before the starting CLI stops waiting. The CLI declares
  its wait in `RAVI_UPDATE_SUPERVISOR_BUDGET_MS`; with no declaration (a CLI
  that predates the window) the supervisor MUST assume 90 s. It keeps 10 s of
  that budget for its exit and the CLI's verification.
- A refusal before any stop MUST be left in
  `<state>/updates/supervisor-refused.json`. The CLI MUST capture the
  supervisor's output in `<state>/updates/supervisor.log`, read a refusal
  recorded since the supervisor started, and fail with that code and message
  instead of a generic convergence failure. Any other failure MUST name the
  supervisor log.
- Still open: the waypoint is checked after the package is installed, and a
  process that was stopped stays stopped (the CLI that verifies the result
  predates a change to that rule). Automatic waypoints and rollback replace
  both later.

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
- The worker MUST confirm it is outside the daemon's process tree before it
  installs anything. If it is still inside after the wait, it MUST refuse with
  `UPDATE_DETACH_FAILED` and record that result.
- The detached run MUST NOT carry runtime context. Every `RAVI_*` key except
  `RAVI_HOME`, `RAVI_REPO` and `RAVI_SUPPRESS_AUDIT_EVENTS` MUST be removed;
  `RAVI_STATE_DIR` MUST be passed as an absolute path.
- Each detached run MUST keep `request.json`, `log` and `result.json` under
  `<state>/updates/<runId>/`. The run id MUST match
  `^\d{8}T\d{6}Z-[0-9a-f]{6}$` before it is used as a path. Results MUST be
  written atomically.
- The run markers (`RAVI_UPDATE_HANDOFF`, `RAVI_UPDATE_HANDOFF_WORKER`,
  `RAVI_UPDATE_RUN_ID`) MUST NOT reach anything the worker starts: the worker
  MUST remove them from its environment before it installs anything, and PM2
  registrations MUST clear them like runtime context. Only the worker writes a
  run's `result.json`; an inline update that inherited a run id MUST NOT write
  to that run.
- The update supervisor (`RAVI_INTERNAL_UPDATE_RUNTIME_REBIND`) MUST refuse
  with `UPDATE_REFUSED_IN_DAEMON_TREE` when it runs inside the daemon's process
  tree. The refusal MUST happen before it reads its request or touches PM2, and
  it MUST leave `<state>/updates/supervisor-refused.json`. Only a CLI that
  predates detached execution starts a supervisor there.
- The refusal of the root command in a runtime context (`CLI_ONLY`) is
  unchanged by detached execution.
