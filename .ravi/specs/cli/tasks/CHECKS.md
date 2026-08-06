# Tasks agent-first CLI contract / CHECKS

## Checks

- `tasks show <unknown-id> --json` MUST exit 1 with the `TASK_NOT_FOUND`
  envelope and up to three `suggestions` of real tasks, even though
  `getTaskDetails` throws on unknown ids.
- An invalid flag on any `tasks` op MUST exit 2 with `acceptedFlags` in the
  envelope.
- `tasks dispatch` without `--execute` MUST exit 3, MUST report `dryRun: true`
  with the dispatch `plan`, and MUST NOT queue or dispatch anything.
- `tasks deps rm` and `tasks automations rm` without `--execute` MUST exit 3 and
  MUST NOT remove anything; with `--execute` the write MUST happen.
- A braked op invoked with `RAVI_*` envs present (agent context) MUST still exit
  3 with the envelope — the registry dispatcher MUST preserve
  `ContractError.exitCode` instead of the generic exit 1.
- `tasks list --fields a,b,c --json` MUST return items containing only the
  requested fields.
- Unbraked writes listed in the spec MUST keep immediate-write behavior, and the
  shipped `tasks` skill MUST list them explicitly as unbraked.
- `bun test src/cli/commands/tasks.test.ts` SHOULD pass after any change to the
  tasks contract surface.
