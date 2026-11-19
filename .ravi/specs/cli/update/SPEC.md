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
