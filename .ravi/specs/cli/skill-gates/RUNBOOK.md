# Skill gates agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/skill-gates --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `GATE_NOT_FOUND`: read `error.suggestions` — real rule ids
   (defaults ∪ configured). Confirm the universe with
   `ravi skill-gates list --json` (`configuredTotal` tells overrides apart).
4. Exit `3`: read `error.plan`. For `rm`, check `action`
   (`disable-default` vs `delete-custom`) and `current`; for `reset`, check
   `discards`. If intended, re-run the same command adding `--execute`.
5. `reset` returned exit 0 with `deleted:false`: there was no configured
   override — the default was already in effect; nothing was discarded.
6. If an `rm`/`reset` executed without `--execute`, the brake regressed: check
   the op still calls `contractDryRun` before the DB write, and that the
   registry dispatcher still maps `ContractError.exitCode`.
7. A gate still fires after `rm --execute` on a default id: expected — the
   default is disabled via an override row, and a later `reset <id> --execute`
   re-enables it by deleting that row. Check `ravi skill-gates show <id>`.

## Validation

```bash
bun test src/cli/commands/skill-gates.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi skill-gates show nope --json              # expect exit 1 + suggestions
ravi skill-gates rm image --json               # expect exit 3 + dryRun plan
ravi skill-gates reset image --json            # exit 0 deleted:false (no override) or exit 3 (override)
ravi skill-gates list --fields id,enabled --json  # expect compact items
```
