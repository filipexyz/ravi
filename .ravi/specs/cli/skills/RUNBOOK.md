# Skills agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/skills --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `SKILL_NOT_FOUND`: read `error.suggestions` — real skill names
   from the universe searched (catalog/installed/`--source`). Retry with one,
   or list the right universe: `ravi skills list [--installed|--source <src>]`.
4. Exit `1` + `AGENT_NOT_FOUND`: read `error.suggestions`; confirm with
   `ravi agents list --json`.
5. Exit `3`: read `error.plan` — source, plugin bucket, and per-skill
   `from`/`to`. Confirm the destination is intended, then re-run the same
   command adding `--execute`.
6. Batch ops (`grant-batch`/`revoke-batch`): there is NO `--execute` here; the
   preview is the pre-existing `--dry-run` (exit 0 with counts). If a batch
   surprised you, re-run with `--dry-run` and compare `pairsAffected`.
7. If an install executed without `--execute`, the brake regressed: check that
   `install` still calls `contractDryRun` before `installSkills`, and that the
   registry dispatcher still maps `ContractError.exitCode`.
8. If a dry-run on a git `--source` leaves `ravi-skills-*` dirs in the OS temp
   dir, the brake moved back inside `withResolvedSkillSource` — it must fire
   after the callback returns.

## Validation

```bash
bun test src/cli/commands/skills.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi skills show nope-skill --json                 # expect exit 1 + suggestions
ravi skills grant nope-agent agents-manager --json # expect exit 1 + AGENT_NOT_FOUND
ravi skills install agents-manager --json          # expect exit 3 + dryRun plan
ravi skills grant-batch --all-agents --all-skills --dry-run --json  # exit 0 preview
ravi skills list --fields name,source --json       # expect compact items
```
