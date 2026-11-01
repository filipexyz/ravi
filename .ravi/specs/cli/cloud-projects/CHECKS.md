# Projects (Console) agent-first CLI contract / CHECKS

## Checks

- `projects create <slug>` without `--execute` MUST exit 3 with
  `dryRun: true` and a plan carrying `slug`, `namePresent`,
  `descriptionPresent`, effective `defaultVisibility`, and
  `defaultPageSite`, and MUST NOT call Console or expose descriptive content.
- `projects create <slug> --execute` MUST create the project through the
  Console CLI API with the supplied values and the effective policy decisions
  shown in the plan.
- An invalid `--visibility` MUST fail with `PAYLOAD_INVALID` BEFORE the brake
  (no plan is produced), with or without `--execute`.
- `projects list --fields a,b,c --json` MUST return project items
  containing only the requested fields (both `projects` and `items` keys).
- A `ContractError` thrown inside a projects command MUST pass through
  `runCloudProjectsCommand` with its exit code intact — never rewrapped as
  `SERVER_UNAVAILABLE`.
- Remote failures MUST preserve their stable CloudAuthError codes under the
  global exit map (`PAYLOAD_INVALID` → `2`; provider/auth failures → `1`). The
  brake code `WRITE_REQUIRES_EXECUTE` remains the only exit-3 signal.
- `ravi cloud projects list|create` MUST behave exactly like `ravi projects
  list|create`, with `op` and `nextCommand` naming `cloud projects`.
- `bun test src/cli/commands/projects.test.ts` SHOULD pass after any
  change to this contract surface.
- `src/cli/command-access.test.ts`: legacy `execute:group:projects` and
  `projects_create` grants do not authorize `ravi projects create`;
  `mutate:cloud.projects:create` and `execute:group:cloud.projects` still do.
