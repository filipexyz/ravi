# Cron agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/cron --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `CRON_JOB_NOT_FOUND`: read `error.suggestions` — live job ids and
   names similar to what was asked. Retry with one of them.
4. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
5. Exit `3`: read `error.plan` — for `cron run` it shows the resolved job and
   the message/shell command that would fire. Confirm the run/delete is
   intended, then re-run the same command adding `--execute`.
6. If a delete or manual run executed without `--execute`, the brake regressed:
   check the op still calls `contractDryRun` before `dbDeleteCronJob` /
   `nats.emit("ravi.cron.trigger")`, and that the registry dispatcher still
   maps `ContractError.exitCode`.
7. If a braked op exits 1 with `Error: ...` text when `RAVI_*` envs are set,
   the registry dispatcher lost the `ContractError` branch — see
   `src/cli/registry.ts`.

## Validation

```bash
bun test src/cli/commands/cron-commands.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi cron show cron-nope --json          # expect exit 1 + suggestions
ravi cron list --no-such-flag --json     # expect exit 2 + acceptedFlags
ravi cron rm <job-id> --json             # expect exit 3 + dryRun plan
ravi cron run <job-id> --json            # expect exit 3 + plan with message
ravi cron list --fields id,name --json   # expect compact items
```
