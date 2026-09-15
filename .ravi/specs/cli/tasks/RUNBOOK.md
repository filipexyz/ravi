# Tasks agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/tasks --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `TASK_NOT_FOUND`: read `error.suggestions` — live task ids and
   titles similar to what was asked. Retry with one of them.
4. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
5. Exit `3`: read `error.plan`, confirm the dispatch/removal is intended, then
   re-run the same command adding `--execute`.
6. If a dispatch/removal executed without `--execute`, the brake regressed:
   check the op still calls `contractDryRun` before the service call, and that
   the registry dispatcher still maps `ContractError.exitCode`.
7. If a braked op exits 1 with `Error: ...` text when `RAVI_*` envs are set,
   the registry dispatcher lost the `ContractError` branch — see
   `src/cli/registry.ts`.

## Validation

```bash
bun test src/cli/commands/tasks.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi tasks show tsk-nope --json               # expect exit 1 + suggestions
ravi tasks list --no-such-flag --json         # expect exit 2 + acceptedFlags
ravi tasks dispatch <task-id> --agent main --json   # expect exit 3 + dryRun plan
ravi tasks list --fields id,title --json      # expect compact items
```
