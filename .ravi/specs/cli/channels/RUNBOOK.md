# Channels config agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/channels --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `1` + `CHANNEL_NOT_FOUND`: read `error.suggestions` — real local
   config names. Confirm with `ravi channels list --json`. Remember the
   collision: if the failing `op` starts with `slack`, you are looking at a
   Slack workspace channel, not a config record.
4. Exit `1` + `CREDENTIAL_CONNECTION_NOT_FOUND`: the referenced credential
   connection does not exist — follow the `suggestedAction`
   (`ravi credentials connections add --provider <p> --connection <c>`), then
   re-run the channels command.
5. Runner problems (`start`/`stop`/`status`/`logs`) are NOT contract
   territory: debug them as process infra (`pm2 jlist`, daemon parity checks
   in `validateChannelRunnerRuntimeTarget`).
6. Config changes hot-reload via `ravi.config.changed`; if a `set` succeeded
   but the runner behaves stale, restart the runner — that is an infra step,
   outside this contract.

## Validation

```bash
bun test src/cli/commands/channels.test.ts
```

Live checks against the local CLI (isolated `RAVI_STATE_DIR`; config-only, no
runner needed):

```bash
ravi channels list --json                             # configs + pagination
ravi channels list --fields name,provider --json      # expect compact items
ravi channels show nope --json                        # expect exit 1 + suggestions
ravi channels create demo --provider slack --json     # unbraked: writes immediately
ravi channels set demo enabled false --json           # unbraked reversible write
ravi channels create demo2 --provider slack --credential-connection ghost --json  # expect exit 1 + CREDENTIAL_CONNECTION_NOT_FOUND
```
