# Operation

1. First rollout from a version without kernel ownership: stop old channels and the old daemon before starting the new installed daemon. An advisory lock cannot stop old code that never acquires it.
2. Start the installed daemon against the intended local state. It acquires ownership, initializes schemas, then becomes ready. Start matching-release channels afterward.
3. Later daemon restarts may overlap PM2 registrations. The successor's `waiting` phase is a standby with no database access; `owned` means exclusive state ownership; only `ready` means boot completed.
4. On `STATE_SCHEMA_BUSY`, identify the existing runtime and its state paths. A SIGSTOP-paused process still owns its locks. Resolve the process lifecycle; do not remove sidecars or take ownership by changing paths.
5. After a crash, start the runtime normally. The kernel releases descriptors automatically; stale sidecar files remain harmless and must not be deleted.
6. On migration failure, inspect the original cause and the domain migration's recovery plan. Do not mark a component ready, force a previous binary to run, or disable foreign keys inside an outer transaction.

Phase receipts under `runtime-processes/schema-owner-<pid>.json` are diagnostic and bind to the current PM2 start time. They are never authorization, locks, or proof that an old PID still exists. Inspect PM2 identity alongside the receipt.

No production restart, migration, or DB copy is part of the development validation. Use disposable roots and subprocess fixtures.
