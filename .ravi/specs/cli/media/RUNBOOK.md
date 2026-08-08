# Media agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/media --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `FILE_NOT_FOUND`: the local path is wrong — the file must exist
   on the machine running the CLI, not on the channel side.
4. Exit `1` + `MEDIA_SEND_FAILED`: delivery-side problem (omni CLI missing,
   unmapped instance, Slack upload failure). The message carries the transport
   error; it is retryable after fixing the target.
5. Exit `3`: read `error.plan`, confirm the file name/type, target
   channel/account and target-presence flags, then re-run the same command
   adding `--execute`. The plan intentionally omits the full path, caption and
   personal target IDs.
6. If a send executed without `--execute`, the brake regressed: check that
   `contractDryRun` still runs before `sendMediaWithOmniCli` in
   `src/cli/commands/media.ts`.

## Validation

```bash
bun test src/cli/commands/media-json.test.ts
```

Live checks (dry-run first — the brake protects you):

```bash
ravi media send /tmp/img.png --json                  # expect exit 3 + plan
ravi media send /tmp/nope.png --json                 # expect exit 1 + FILE_NOT_FOUND
ravi media send /tmp/img.png --caption "oi" --json --execute   # real delivery
```
