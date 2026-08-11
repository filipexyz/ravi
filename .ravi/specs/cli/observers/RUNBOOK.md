# Observers agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/observers --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `OBSERVER_NOT_FOUND`: the message names the resource (binding,
   rule or profile); read `error.suggestions` for real ids and retry with one.
4. Exit `1` + `SESSION_NOT_FOUND`: no suggestions by design — list visible
   sessions with `ravi sessions list --json` and check the scope you run in.
5. Exit `3`: read `error.plan`, confirm the rule in the plan is the one you
   mean to delete, then re-run the same command adding `--execute`.
6. If `rules rm` deleted without `--execute`, the brake regressed: check the op
   still calls `contractDryRun` before `dbDeleteObserverRule` and that the
   registry dispatcher still maps `ContractError.exitCode`.
7. If a rule "does not fire" rather than "does not exist", that is not a
   contract problem — use `ravi observers rules explain --session <session>`.

## Validation

```bash
bun test src/cli/commands/observers.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi observers rules show no-such-rule --json     # expect exit 1 + suggestions
ravi observers rules rm <rule-id> --json          # expect exit 3 + dryRun plan
ravi observers refresh ghost-session --json       # expect exit 1 + SESSION_NOT_FOUND
ravi observers rules list --fields id,enabled --json   # expect compact items
```
