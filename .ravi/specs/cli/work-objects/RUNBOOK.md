# Work Objects agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/work-objects --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `WORK_OBJECT_NOT_FOUND`: no adapter handled the reference.
   Check the ref syntax (`--type task --id <task-id>` or a URL) and list real
   ids through the adapter-backed listing in `error.suggestedAction`
   (`ravi tasks list --json` today).
4. Exit `3`: read `error.plan` (`ref`, `actionId`, `value`), confirm the
   action is intended, then re-run the same command adding `--execute`.
5. Success envelope with `fieldErrors`/`formError`: the adapter REJECTED the
   patch — that is adapter validation, not a CLI failure; fix the values, do
   not debug transport.
6. If an action executed without `--execute`, the brake regressed: check that
   `action` still calls `contractDryRun` before `executeWorkObjectAction`.

## Validation

```bash
bun test src/cli/commands/work-objects.test.ts
```

Live checks against the local CLI (dry-run or task-scoped; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi work-objects resolve --type task --id <task-id> --json        # read
ravi work-objects action task <task-id> task.comment --value "x" --json
                                                    # expect exit 3 + dryRun plan
ravi work-objects action task <task-id> task.comment --value "x" --json --execute
                                                    # real adapter call
ravi work-objects resolve --type ghost --id nope --json
                                                    # expect exit 1 + WORK_OBJECT_NOT_FOUND
```
