# Sync agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/sync --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `3` + `WRITE_REQUIRES_EXECUTE`: read `error.plan` — the pending/failed
   counters show what the transfer would move. Confirm scope/domain filters,
   then re-run with `--execute`.
4. Exit `1` + `SYNC_RECORD_NOT_FOUND`: the row id does not exist in outbox or
   inbox — check counts with `ravi sync status --json`; row ids come from
   push/pull output.
5. `status: "unlinked"` on an executed push/pull is not an error: run
   `ravi login` to link the install to Console.
6. If a push/pull hit Console (or enqueued trace batches) without `--execute`,
   the brake regressed — it must run before `createConsoleSyncBridge()` and
   every write/provider boundary. The optional queue summary before it must use
   the read-only path and must not create `ravi.db` in a virgin state dir.

## Validation

```bash
bun test src/cli/commands/sync.test.ts
```

Live checks against the local CLI (isolated `RAVI_STATE_DIR`; dry-run safe):

```bash
ravi sync status --json                    # linked flag + queue counters
ravi sync push --json                      # expect exit 3 + plan with outboxPending
ravi sync pull --json                      # expect exit 3 + plan with inboxPending
ravi sync retry --json                     # unbraked: exit 0, retried count
ravi sync inspect nope --json              # expect exit 1 + SYNC_RECORD_NOT_FOUND
```
