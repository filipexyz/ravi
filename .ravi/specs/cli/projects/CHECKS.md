# Projects agent-first CLI contract / CHECKS

## Checks

- `projects show <unknown-ref> --json` MUST exit 1 with the `PROJECT_NOT_FOUND`
  envelope and up to three `suggestions` of real project slugs/titles, and the
  same envelope MUST come out of service-layer throws (`update`, `link`,
  `workflows attach`, `tasks create|attach|dispatch`, `resources add|import`).
- `projects resources show <project> <unknown-ref> --json` MUST exit 1 with
  `RESOURCE_NOT_FOUND` and suggestions from that project's real resource
  ids/labels/locators.
- An unknown workflow run or node reached through the projects surface MUST
  exit 1 with `WORKFLOW_RUN_NOT_FOUND` or `WORKFLOW_NODE_NOT_FOUND` (node
  suggestions come from the linked run's node keys).
- `projects tasks dispatch` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with the dispatch `plan`, and MUST NOT dispatch anything —
  including the pre-resolved agent/session defaults in the plan.
- `projects workflows start` and `projects fixtures seed` without `--execute`
  MUST exit 3 and MUST NOT start or reseed anything; with `--execute` the
  effect MUST happen. The fixture plan MUST use only `ownerAgentId` and
  `resetsCanonicalFixtures:true`, never free-form effect text.
- `projects resources import` MUST create validated local links immediately
  without `--execute` and remain `kind: "mutate"`.
- Validation MUST run before the brake: an unknown project ref on a braked op
  MUST exit 1 with `PROJECT_NOT_FOUND`, never exit 3 with a bogus plan.
- A braked op invoked with `RAVI_*` envs present (agent context) MUST still
  exit 3 with the envelope — the legacy try/catch MUST rethrow `ContractError`
  and the registry dispatcher MUST preserve `ContractError.exitCode`.
- `projects list --fields a,b,c --json` and
  `projects resources list <project> --fields a,b,c --json` MUST return items
  containing only the requested fields.
- Unbraked writes listed in the spec (`init`, `create`, `update`, `link`,
  `workflows attach`, `tasks create|attach`, `resources add|import`) MUST keep
  immediate-write behavior, and the shipped `projects` skill MUST list them
  explicitly as unbraked.
- `bun test src/cli/commands/projects.test.ts` SHOULD pass after any change to
  the projects contract surface.
