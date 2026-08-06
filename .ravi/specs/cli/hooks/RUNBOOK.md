# Hooks agent-first CLI contract / RUNBOOK

## Debug Flow

1. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
2. Exit `1` + `HOOK_NOT_FOUND`: read `error.suggestions` — live hook ids and
   names similar to what was asked. Retry with one of them.
3. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
4. Exit `3`: read `error.plan` (hook id, name, event, scope, action), confirm
   the deletion is intended, then re-run the same command adding `--execute`.
5. If a deletion executed without `--execute`, the brake regressed: check that
   `rm` still calls `contractDryRun` before `dbDeleteHook`, and that the
   registry dispatcher still maps `ContractError.exitCode`.
6. Remember `rm` aliases (`delete`, `remove`) share the same body — the brake
   MUST hold for all of them.

## Common Operations

```bash
ravi hooks list --json --fields id,name,enabled     # compact discovery
ravi hooks show <id> --json                          # inspect one hook
ravi hooks disable <id>                              # pause (reversible, unbraked)
ravi hooks rm <id>                                   # dry-run: exit 3 + plan
ravi hooks rm <id> --execute                         # actually deletes + refresh
```

## Validation

```bash
bun test src/cli/commands/hooks.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi hooks show nope --json                  # expect exit 1 + suggestions
ravi hooks list --no-such-flag --json        # expect exit 2 + acceptedFlags
ravi hooks rm <hook-id> --json               # expect exit 3 + dryRun plan
ravi hooks list --fields id,name --json      # expect compact items
```
