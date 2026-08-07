# Triggers agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/triggers --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `TRIGGER_NOT_FOUND`: read `error.suggestions` — live trigger ids
   and names similar to what was asked. Retry with one of them.
4. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
5. Exit `3`: read `error.plan` (id, name, topic), confirm the delete is
   intended, then re-run the same command adding `--execute`.
6. Need to see what a trigger would do? Run `triggers test <id>` to inspect
   the plan, then add `--execute` only when activating the agent or shell with
   the synthetic event is intended; check `ravi daemon logs -f`.
7. If a delete executed without `--execute`, the brake regressed: check `rm`
   still calls `contractDryRun` before `dbDeleteTrigger`, and that the registry
   dispatcher still maps `ContractError.exitCode`.
8. If a braked op exits 1 with `Error: ...` text when `RAVI_*` envs are set,
   the registry dispatcher lost the `ContractError` branch — see
   `src/cli/registry.ts`.

## Validation

```bash
bun test src/cli/commands/triggers.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi triggers show trg_nope --json           # expect exit 1 + suggestions
ravi triggers list --no-such-flag --json     # expect exit 2 + acceptedFlags
ravi triggers rm <trigger-id> --json         # expect exit 3 + dryRun plan
ravi triggers test <trigger-id> --json       # expect exit 3, no event emitted
ravi triggers test <trigger-id> --json --execute # emits synthetic event
ravi triggers list --fields id,name --json   # expect compact items
```
