# Stickers agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/stickers --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `1` + `STICKER_NOT_FOUND`: read `error.suggestions` — real catalog ids
   and labels. Retry with one of them or list with `ravi stickers list --json`.
4. Exit `1` + `STICKER_MEDIA_NOT_FOUND`: the catalog entry points at a missing
   file — re-add with `ravi stickers add <id> <mediaPath> --overwrite ...`.
5. Exit `1` with `Stickers are not supported on channel`: capability gate —
   the current channel has no sticker support; this is not retryable from the
   same context.
6. Exit `3`: read `error.plan`, confirm sticker and target, then re-run adding
   `--execute`.
7. If a send emitted without `--execute`, the brake regressed: check that
   `contractDryRun` runs before `nats.emit("ravi.stickers.send")` in
   `src/cli/commands/stickers.ts`.

## Validation

```bash
bun test src/cli/commands/stickers.test.ts
```

Live checks:

```bash
ravi stickers list --json --fields id,enabled      # compact catalog
ravi stickers send wave --json                     # expect exit 3 + plan
ravi stickers send wave --json --execute           # real send to current chat
ravi stickers remove wave --json                   # expect exit 3, still listed
```
