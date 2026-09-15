# Workflows agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/workflows --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `WORKFLOW_SPEC_NOT_FOUND` / `WORKFLOW_RUN_NOT_FOUND`: read
   `error.suggestions` — real spec/run ids and titles. Retry with one.
4. Exit `1` + `WORKFLOW_NODE_NOT_FOUND`: suggestions are the node keys of that
   run; cross-check with `ravi workflows runs show <run-id> --json`.
5. Exit `3`: read `error.plan`, confirm the start/archive is intended, then
   re-run the same command adding `--execute`.
6. If a start/archive executed without `--execute`, the brake regressed: check
   the op still calls `contractDryRun` before the service call, and that the
   registry dispatcher still maps `ContractError.exitCode`.
7. `WORKFLOW_NODE_NOT_FOUND` on a run you believe exists: verify the run id
   first — the run pre-check (`requireWorkflowRunDetailsForContract`) is what
   keeps unknown runs from masquerading as unknown nodes.
8. A node that rejects mutations with `Workflow node X is archived.` is
   permanently terminal; there is no unarchive. That is the reason the archive
   op is braked, not a bug.

## Validation

```bash
bun test src/cli/commands/workflows.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi workflows specs show no-such-spec --json            # expect exit 1 + suggestions
ravi workflows runs start <spec-id> --json               # expect exit 3 + dryRun plan
ravi workflows runs archive-node <run-id> <node> --json  # expect exit 3 + dryRun plan
ravi workflows runs list --fields id,status --json       # expect compact items
```
