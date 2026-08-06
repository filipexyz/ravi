# Credentials agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/credentials --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `CREDENTIAL_CONNECTION_NOT_FOUND`: read `error.suggestions` —
   real `provider:connection` pairs similar to what was asked. Retry with one,
   or list with `ravi credentials connections list --all --json`.
4. Exit `3`: read `error.plan`, confirm the removal/exec is intended, then
   re-run the same command adding `--execute`.
5. If any envelope or plan contains a secret value or a raw `secretRef`, that
   is a contract regression — check `failCredentialConnectionNotFound` and the
   remove/exec plans in `src/cli/commands/credentials.ts` (they must build
   plans from identity fields only).
6. If `broker exec` resolved a secret without `--execute`, check the brake
   ordering: connection lookup → brake → `execCredentialBroker`.

## Validation

```bash
bun test src/cli/commands/credentials.test.ts
```

Live checks against the local CLI (isolated `RAVI_STATE_DIR`; no daemon
needed):

```bash
ravi credentials connections show --provider slack --connection nope --json   # expect exit 1 + suggestions
ravi credentials connections remove --provider slack --connection main --json # expect exit 3 + plan, nothing removed
ravi credentials broker exec --provider slack --connection main --action messages.send --json  # expect exit 3 + policy plan
ravi credentials broker exec --provider slack --connection main --action messages.send --dry-run --json  # legacy exit 0 planned payload
ravi credentials connections list --fields provider,connection,status --json  # expect compact items
```
