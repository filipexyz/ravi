# Cloud Projects agent-first CLI contract / CHECKS

## Checks

- `cloud projects create <slug>` without `--execute` MUST exit 3 with
  `dryRun: true` and a plan carrying `slug`, `namePresent`,
  `descriptionPresent`, effective `defaultVisibility`, and
  `defaultPageSite`, and MUST NOT call Console or expose descriptive content.
- `cloud projects create <slug> --execute` MUST create the project through the
  Console CLI API with the supplied values and the effective policy decisions
  shown in the plan.
- An invalid `--visibility` MUST fail with `PAYLOAD_INVALID` BEFORE the brake
  (no plan is produced), with or without `--execute`.
- `cloud projects list --fields a,b,c --json` MUST return project items
  containing only the requested fields (both `projects` and `items` keys).
- A `ContractError` thrown inside a cloud-projects command MUST pass through
  `runCloudProjectsCommand` with its exit code intact — never rewrapped as
  `SERVER_UNAVAILABLE`.
- Remote failures MUST preserve their stable CloudAuthError codes under the
  global exit map (`PAYLOAD_INVALID` → `2`; provider/auth failures → `1`). The
  brake code `WRITE_REQUIRES_EXECUTE` remains the only exit-3 signal.
- `bun test src/cli/commands/cloud-projects.test.ts` SHOULD pass after any
  change to this contract surface.
