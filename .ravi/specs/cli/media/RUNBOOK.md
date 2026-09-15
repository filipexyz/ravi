# Media agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/media --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `FILE_NOT_FOUND`: the local path is wrong — the file must exist
   on the machine running the CLI, not on the channel side.
4. Exit `1` + `MEDIA_SEND_FAILED`: delivery-side problem (omni CLI missing,
   unmapped instance, Slack upload failure). The public message is stable and
   redacted; inspect redacted runtime logs and target configuration before retrying.
5. Exit `1` + `OMNI_AUTH_FAILED`: Omni returned `401` / `Invalid API key`. The
   Omni CLI reads `servers.list.<active>.apiKey` from `~/.omni/config.json`,
   which can be stale relative to the top-level `apiKey` or `OMNI_API_KEY`
   that Ravi's runtime (text send, media download) uses. Copy the live primary
   into the active server entry, or set `OMNI_API_URL` and `OMNI_API_KEY`, then
   retry. `ravi media send --execute` also isolates the child CLI onto a
   config whose `servers.list.default` mirrors `resolveOmniConnection()`.
6. Exit `3`: read `error.plan`, confirm the file name/type, target
   channel/account and target-presence flags, then re-run the same command
   adding `--execute`. The plan intentionally omits the full path, caption and
   personal target IDs.
7. If a send executed without `--execute`, the brake regressed: check that
   `contractDryRun` still runs before `sendMediaWithOmniCli` in
   `src/cli/commands/media.ts`.

## Validation

```bash
bun test src/cli/commands/media-json.test.ts src/cli/media-send.test.ts src/cli/media-send-auth.test.ts src/omni-config.test.ts
```

Live checks (dry-run first — the brake protects you):

```bash
ravi media send /tmp/img.png --json                  # expect exit 3 + plan
ravi media send /tmp/nope.png --json                 # expect exit 1 + FILE_NOT_FOUND
ravi media send /tmp/img.png --caption "oi" --json --execute   # real delivery
```
