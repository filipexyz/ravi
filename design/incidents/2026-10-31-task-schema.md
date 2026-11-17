# Task API schema incident — 2026-10-31

## Data verdict

No user decision data was lost, based on the migration's behavior and the
read-only evidence. The live release's `task_decisions` table existed and was
empty when removed. There is no pre-migration snapshot: this is an inference,
not a comparison against a backup, and it does not prove the absence of all
possible historical writes/deletions.

Read-only SQLite observations on the production `ravi.db`:

- `task_decisions` absent; `decisions`, `decision_history` and
  `decision_deliveries` present, each with zero rows.
- 14,557 retained task events; zero decision events.
- No `decision_history` entry in `sqlite_sequence`. The absence of the old
  table's sequence is not evidence: DROP removes a table's sequence entry.
- The branch migration uses an immediate transaction with strict INSERT of
  every legacy row into `decisions`, plus the original row snapshot in
  `decision_history`, before dropping `task_decisions`. Empty destinations
  therefore imply an empty source at that migration, absent later deletion.

## Executed command and state escape

The session that produced PR #765 executed this review check:

```text
worktree: /Users/luis/dev/ravi-decisions-threads
branch: feat/generic-decisions-threads
command: python3 /tmp/ravi-decisions-run.py bun test src/runtime/session-dispatcher.test.ts
recorded batch start: 2026-10-31T14:24:29.942Z = 11:24:29.942 GMT-3
session: main-t-1793452712954889
tool: exec-50aee135-6738-42de-852d-d961b945e39d, step 1
retained output: /tmp/ravi-decisions-review-verify-1.log
```

The launcher deliberately created `ravi-decisions-check-*` under the system
TEMP directory and set `RAVI_STATE_DIR` to it. The test's inner decision/debounce
fixtures called `createIsolatedRaviState` and then `cleanupIsolatedRaviState`.
Cleanup unconditionally deleted `RAVI_STATE_DIR`, losing the launcher's sandbox.
The later recovery-loop test called `restartStashedSession`, which resolved a
session through `getSessionByName` → router `getDb`.

With the variable now **unset**, `getRaviStateDir()` selected
`/Users/luis/.ravi`. The branch's `getDb()` opened
`/Users/luis/.ravi/ravi.db` and unconditionally ran `migrateDecisions()`.
That migration removed the table still used by the installed daemon.
The exact temporary directory name is not preserved in the execution record;
its prefix and creation logic are present in the retained launcher.

This is a deterministic path from an executed test command to the production
schema migration. There is no DDL audit that proves which repeat was the first
mutation. The initial implementation window was 13:19–13:53Z (10:19–10:53
local); the same session reopened for review and ran this command at 14:24Z.
Do not infer a second migration from the database mtime at 11:38: a live WAL
store has many writers/checkpoints.

## Reproduction without production access

A temporary preload wrapped both `bun:sqlite.Database` construction and
`Database.open`. It threw **before** opening any path beneath the production
state directory. Running the recorded command with that preload captured
13 blocked opens, all with `RAVI_STATE_DIR=<unset>`; the first recovery-loop
stack was in `session-dispatcher.test.ts:663`.
The guard did not open or migrate production. A smoke test verified its block
before running the historical suite.

The retained artifacts are `/tmp/ravi-p0-db-guard.ts` and
`/tmp/ravi-p0-dispatcher-guard.log`. They are diagnostic tools, not a shipped
systemic guard (canonicalized paths and subprocesses need stronger coverage).

## Why the installed release is not the migrator

The installed 3.261031.6 bundle and its source map contain the legacy table and
queries, but no `migrateDecisions`, generic decision DDL, `decision_history`,
`decision_deliveries` or `DROP TABLE task_decisions`.
Installed bundle: `/Users/luis/.bun/install/global/node_modules/ravi.bot/dist/bundle/index.js`.
The supervised daemon boot at approximately 11:15–11:16 GMT-3 ran that release.
It cannot have performed the generic decision migration.

The task schema initializer caches `schemaReady` in memory. Once a separate
process removes the table, the daemon continues past that initializer and
fails on its next task detail query. The first observed overlay 500 at
11:31:44 GMT-3 is an observation time, not the migration timestamp.

## Observable failure and masked exception

`getTaskDetails()` always calls `dbListTaskDecisions()`, which selects from
`task_decisions`. Show and dispatch (including dry-run) need task details.
The actual exception is `no such table: task_decisions`.
CLI list can succeed because details are conditional, notably for dispatched
tasks. Different list filters/results explain why the overlay list can fail
while a small CLI list succeeds; no origin-auth difference is required.

`src/sdk/gateway/dispatcher.ts` normalized the exception to `UNHANDLED_ERROR`
and returned HTTP 500 without logging its cause or stack. The access log only
recorded path/status/duration. The patch adds a local diagnostic containing
command, duration, sanitized message and stack frames. It does not expose that
information in public responses or audit payloads.

## Recovery decision and authorization boundary

Prefer an additive restoration of the legacy table/indexes required by the
live release, rather than deploying all of PR #765 to repair this incident.
No decision rows need reconstruction under the data verdict above. Keep all
three generic tables intact. First stop the offending test path from opening
production or it can remove the restored table again.

This PR **does not apply a production repair, migration, restart or deploy**.
The operator must confirm recovery before any production write. At execution:

1. Re-read the schema and the three destination counts using read-only SQLite;
   if any count is nonzero or the schema differs, stop and re-evaluate the plan.
2. Preserve an approved recovery snapshot before a production schema write.
3. In one short transaction, create only `task_decisions` and its three indexes
   using the DDL in the installed release / commit `05c77ab0`
   (`git show 05c77ab0:src/tasks/task-db.ts`). Current dev has a newer schema.
   Do not drop, copy over or remove the generic decision tables.
4. Verify task show and a dispatch **without --execute**, and compare counts.
   No daemon restart is needed for the proposed additive repair.

At PR commit `28821a3a`, the gateway regression test simulated the missing legacy
table in a temporary fixture,
asserted show=500 and dry-run dispatch=500, restored the captured release DDL,
and asserted show=200 / dry-run dispatch=409 exit 3, with zero assignments and
an unchanged generic destination. After #765 landed on dev, the ongoing regression
uses the current `decisions` table. It verifies the same failure/recovery boundary
and unchanged history/deliveries; it is not the DDL for repairing the old daemon.

## Authorized recovery check, 15:11:34Z

After recovery was authorized, the first read-only inspection already found
`task_decisions` and its three indexes restored. Column, foreign-key, index and
normalized SQL comparisons matched the exact block extracted from the installed
3.261031.6 bundle. No recovery SQL was applied by this investigation.
All four decision tables were empty at that observation.

The initial schema-only record and extracted DDL are in
`/tmp/ravi-task-restore-20261031T151134Z/sqlite-master-before.json` and
`bundle-task-decisions.sql` in the same directory. This record captures the
first read of the authorized check, not the earlier absent-table state.
The entire database was not copied.

Validation: `tasks show task-12178a2a --json` exited 0; dispatch with `--agent dev`
and without `--execute` returned HTTP 409 / exit 3. Omitting the required agent
returned HTTP 422, not 500. Two direct POSTs to `/api/v1/tasks/list` with the
extension Origin returned HTTP 200 (limit 100, with/without dispatched filter).
They used this investigation's runtime context, not the browser's identity.
The last observed real-extension 500 was at 11:50:55 local.

The follow-up regression ships the temporary guard as a dedicated **test-only**
preload in `src/test/isolated-runtime-preload.ts`. It creates the outer sandbox
before Ravi imports and rejects SQLite opens under the operator state before
connection. An after-suite assertion fails even if a test caught the rejection.
With the old cleanup, the actual session-dispatcher suite fails at the original
recovery path; with the fixed helper, all 107 tests pass. The production guard
and official lightweight publication flow remain owned by the separate
development/production boundary workstream.

## Systemic guard proposal

Restoring the launcher's state directory fixes this incident's escape, but is
not a complete boundary between development and production.

- Put an access check **before opening writable storage**, not merely before
  migrations. Source/worktree/test processes must default to rejecting the
  production state directory, even when explicitly selected via RAVI_STATE_DIR.
- Require an explicit production-write opt-in for source tooling; the installed
  supervised runtime needs a separately verifiable runtime identity. Do not
  trust cwd, a mutable env var or a version string as proof of installation.
- Resolve real paths, including existing ancestors, aliases and symlinks;
  cover every SQLite store and subprocess. A helper-local guard is insufficient.
- Fail closed before side effects with the resolved database path, entrypoint
  and requested access mode. Record schema migrations with build/source identity
  and schema before/after, without credentials or user payloads.
- Acceptance tests: omitted/unset state after cleanup; explicit production path;
  symlink aliases; source CLI/build imports; spawned children; normal isolated
  tests; legitimate installed daemon; explicit operator opt-in.

Ship this guard as a separate storage-boundary change, with a read-only
inventory of existing entrypoints first. This PR does not claim the broader
boundary is already enforced.

## Validation

- Old source + new regressions: outer-state restoration fails; both diagnostic
  logging regressions fail. Production opens were blocked by the preload.
- Fixed source on dev after #765: helper 2, gateway 49, decisions 9 and
  session-dispatcher 107 tests pass (167 total). The formerly escaping
  session-dispatcher test file reports zero blocked production opens after
  the helper fix, versus 13 on the original branch code.
- Full build/typecheck/suite belong in CI, not on this production workstation.
