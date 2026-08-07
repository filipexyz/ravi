# Projects agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/projects --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `PROJECT_NOT_FOUND`: read `error.suggestions` — live project
   slugs/titles similar to what was asked. Retry with one of them.
4. Exit `1` + `WORKFLOW_RUN_NOT_FOUND` / `WORKFLOW_NODE_NOT_FOUND` /
   `TASK_NOT_FOUND` / `RESOURCE_NOT_FOUND`: the project resolved but the nested
   ref did not; inspect with `ravi projects show <project> --json` (linked runs)
   or `ravi projects resources list <project> --json`.
5. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
6. Exit `3`: read `error.plan`, confirm the dispatch/start/seed is
   intended, then re-run the same command adding `--execute`.
7. If dispatch/start/seed executed without `--execute`, the brake regressed: check the
   op still calls `contractDryRun` before the service call and that the
   command's catch rethrows `ContractError` before mapping messages.
8. If a braked op exits 1 with `Error: ...` text when `RAVI_*` envs are set,
   either the command's legacy catch swallowed the `ContractError`
   (`rethrowProjectCommandError` must be the only catch body) or the registry
   dispatcher lost the `ContractError` branch — see `src/cli/registry.ts`.

## Validation

```bash
bun test src/cli/commands/projects.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
state dir):

```bash
ravi projects show nope-project --json                       # expect exit 1 + suggestions
ravi projects tasks dispatch <slug> <task-id> --json         # expect exit 3 + dryRun plan
ravi projects workflows start <slug> <spec-id> --json        # expect exit 3 + dryRun plan
ravi projects fixtures seed --json                           # expect exit 3, nothing reseeded
ravi projects resources import <slug> --url https://x.dev --json  # expect exit 0 + local link
ravi projects list --fields slug,status --json               # expect compact items
```
