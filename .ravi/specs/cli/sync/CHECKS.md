# Sync agent-first CLI contract / CHECKS

## Checks

- `sync push` without `--execute` MUST exit 3 with `dryRun: true` and a plan
  including the filters and `outboxPending`/`outboxFailed`, and MUST NOT
  upload, create the bridge, or enqueue trace batches (even with `--traces`).
- `sync pull` without `--execute` MUST exit 3 with `dryRun: true` and a plan
  including the filters and `inboxPending`/`inboxFailed`, and MUST NOT
  download or apply anything.
- `sync push --execute` and `sync pull --execute` on an unlinked install MUST
  return `{linked:false, status:"unlinked"}` with exit 0 instead of throwing.
- `sync retry` is declared unbraked and MUST keep flipping failed/dead rows to
  pending immediately, without `--execute`.
- `sync inspect <unknown-id> --json` MUST exit 1 with the
  `SYNC_RECORD_NOT_FOUND` envelope and a `suggestedAction` pointing at
  `ravi sync status --json` (no similarity suggestions — ids are opaque).
- `sync status` MUST stay a plain exit-0 read, including on unlinked installs.
- `bun test src/cli/commands/sync.test.ts` SHOULD pass after any change to
  this contract surface.
