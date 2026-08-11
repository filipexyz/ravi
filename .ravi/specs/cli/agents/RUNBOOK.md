# Agents agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/agents --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `AGENT_NOT_FOUND`: read `error.suggestions` — real agent ids and
   names similar to what was asked. Retry with one of them, or list with
   `ravi agents list --json`.
4. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
5. Exit `3`: read `error.plan`, confirm the delete/reset/permissions change is
   intended, then re-run the same command adding `--execute`.
6. If a delete/reset/permissions change executed without `--execute`, the brake
   regressed: check the op still calls `contractDryRun` before the service call
   (outside the `delete` try/catch), and that the registry dispatcher still
   maps `ContractError.exitCode`.
7. If a braked op exits 1 with `Error: ...` text when `RAVI_*` envs are set,
   the registry dispatcher lost the `ContractError` branch — see
   `src/cli/registry.ts`.
8. If `agents permissions <id>` (read-only, no profile) exits 3, the brake was
   placed before the read-only early return — it must stay after it.

## Validation

```bash
bun test src/cli/commands/agents.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi agents show ghost-agent --json           # expect exit 1 + suggestions
ravi agents list --no-such-flag --json        # expect exit 2 + acceptedFlags
ravi agents delete <id> --json                # expect exit 3 + dryRun plan
ravi agents reset <id> all --json             # expect exit 3 + dryRun plan
ravi agents permissions <id> full-access --json  # expect exit 3 + profile/count summary
ravi agents permissions <id> --json           # expect exit 0 (read-only, unbraked)
ravi agents list --fields id,cwd --json       # expect compact items
```
