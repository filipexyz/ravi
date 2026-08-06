# Agents agent-first CLI contract / CHECKS

## Checks

- `agents show <unknown-id> --json` MUST exit 1 with the `AGENT_NOT_FOUND`
  envelope and up to three `suggestions` built from the same visibility filter
  as `agents list`.
- Every agent-resolving op (`show`, `sync-instructions`, `delete`, `set`,
  `permissions`, `debounce`, `spec-mode`, `session`, `reset`, `debug`) MUST use
  the `AGENT_NOT_FOUND` envelope on an unknown id instead of plain
  `fail("Agent not found: ...")` text.
- An invalid flag on any `agents` op MUST exit 2 with `acceptedFlags` in the
  envelope.
- `agents delete` without `--execute` MUST exit 3, MUST report `dryRun: true`
  with the delete `plan`, and MUST NOT delete the agent; with `--execute` the
  delete MUST happen.
- `agents reset` (main, specific session, and `reset <id> all`) without
  `--execute` MUST exit 3 and MUST NOT abort or delete any session; with
  `--execute` the reset MUST happen.
- `agents permissions <id> <profile>` (or `--capabilities` /
  `--clear-capabilities`) without `--execute` MUST exit 3 with a plan carrying
  `before`/`after` and MUST NOT write agent defaults; with `--execute` the
  write MUST happen.
- The read-only form `agents permissions <id>` MUST keep exiting 0 without the
  brake.
- A braked op invoked with `RAVI_*` envs present (agent context) MUST still
  exit 3 with the envelope — the registry dispatcher MUST preserve
  `ContractError.exitCode` instead of the generic exit 1.
- `agents list --fields a,b,c --json` MUST return items containing only the
  requested fields.
- Unbraked writes (`create`, `set`, `sync-instructions`, `debounce`,
  `spec-mode`) MUST keep immediate-write behavior, and the shipped `agents`
  skill MUST list them explicitly as unbraked.
- Hint strings that teach mutating permission invocations
  (`leastPrivilegeExample`, `breakGlassCommand`, the `Clear:` line and the
  reset usage hints) MUST carry `--execute`; the read-only `permissionsCommand`
  hint MUST NOT.
- `bun test src/cli/commands/agents.test.ts` SHOULD pass after any change to
  the agents contract surface.
