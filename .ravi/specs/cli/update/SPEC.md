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
- This restart mandate belongs to the explicit `update` operation. Status
  reads and env-file mutations MUST NOT automatically restart processes.
