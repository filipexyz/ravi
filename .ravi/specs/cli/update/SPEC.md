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
  Starting a service MUST NOT turn it into a remote CLI invocation.
- Operator CLI commands targeting real state MUST use the authenticated
  installed gateway for stateful authorization/execution. Local lifecycle and
  recovery operations MUST remain usable when the daemon is unavailable,
  without opening or migrating real databases. Runtime contexts MUST never
  gain an operator fallback.
- Update MUST prepare and validate its launcher before disrupting managed
  processes, and wait for the new daemon's exact-release readiness before
  starting channel consumers. A failed candidate MUST NOT be reported as
  recovered based only on PM2 online or a boot receipt. Recovery MUST preserve
  schema ownership and MUST NOT imply a database rollback.
