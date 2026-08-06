# Cloud Projects agent-first CLI contract / CHECKS

## Checks

- `cloud projects create <slug>` without `--execute` MUST exit 3 with
  `dryRun: true` and a plan carrying the effective `slug`, `name`,
  `defaultVisibility`, and `defaultPageSite`, and MUST NOT call Console.
- `cloud projects create <slug> --execute` MUST create the project through the
  Console CLI API with the same effective values shown in the plan.
- An invalid `--visibility` MUST fail with `PAYLOAD_INVALID` BEFORE the brake
  (no plan is produced), with or without `--execute`.
- `cloud projects list --fields a,b,c --json` MUST return project items
  containing only the requested fields (both `projects` and `items` keys).
- A `ContractError` thrown inside a cloud-projects command MUST pass through
  `runCloudProjectsCommand` with its exit code intact — never rewrapped as
  `SERVER_UNAVAILABLE`.
- Remote failures MUST keep the legacy CloudAuthError codes and exit map; the
  brake code `WRITE_REQUIRES_EXECUTE` MUST remain the only signal that means
  "re-run with --execute".
- `bun test src/cli/commands/cloud-projects.test.ts` SHOULD pass after any
  change to this contract surface.
