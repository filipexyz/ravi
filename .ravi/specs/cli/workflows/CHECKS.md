# Workflows agent-first CLI contract / CHECKS

## Checks

- `workflows runs start <spec>` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with the start `plan` (specId, runId, title, nodes), and MUST
  NOT instantiate any run.
- `workflows runs archive-node <run> <node>` without `--execute` MUST exit 3
  and MUST NOT archive; with `--execute` the archive MUST happen.
- `workflows runs start <unknown-spec> --json` MUST exit 1 with
  `WORKFLOW_SPEC_NOT_FOUND` and suggestions of real spec ids — validated BEFORE
  the brake, so a bad spec never reaches exit 3.
- `workflows runs show <unknown-run> --json` MUST exit 1 with
  `WORKFLOW_RUN_NOT_FOUND` and suggestions of real run ids.
- `workflows runs archive-node <run> <unknown-node> --json` MUST exit 1 with
  `WORKFLOW_NODE_NOT_FOUND` and suggestions of that run's node keys, and a
  node-level op on an unknown RUN must report `WORKFLOW_RUN_NOT_FOUND`, never
  `WORKFLOW_NODE_NOT_FOUND`.
- `workflows runs cancel` MUST stay unbraked (emergency stop, documented
  anti-safety rationale) while still emitting the not-found envelopes.
- `workflows specs list --fields a,b --json` and `workflows runs list --fields
  a,b --json` MUST return items containing only the requested fields.
- The `task-create` cleanup invariant MUST hold: when attach fails after task
  creation, the created task is deleted before the contract error propagates.
- The teaching surfaces MUST show `--execute` on both braked ops — today that
  is `docs/workflow-substrate-v0.md`, because no `workflows` skill exists (gap
  registered in the SPEC).
- `bun test src/cli/commands/workflows.test.ts` SHOULD pass after any change to
  the workflows contract surface.
