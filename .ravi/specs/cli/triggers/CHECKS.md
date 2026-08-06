# Triggers agent-first CLI contract / CHECKS

## Checks

- `triggers show <unknown-id> --json` MUST exit 1 with the `TRIGGER_NOT_FOUND`
  envelope and up to three `suggestions` of real, scope-visible trigger
  ids/names.
- An invalid flag on any `triggers` op MUST exit 2 with `acceptedFlags` in the
  envelope.
- `triggers rm` without `--execute` MUST exit 3, MUST report `dryRun: true`
  with the trigger `plan` (id, name, topic), and MUST NOT delete anything nor
  emit `ravi.triggers.refresh`; with `--execute` the delete MUST happen.
- `triggers test` MUST keep firing its FAKE event without `--execute` — it is
  declared unbraked as the designed debug tool and MUST report
  `changedCount: 0`.
- A braked op invoked with `RAVI_*` envs present (agent context) MUST still
  exit 3 with the envelope — the registry dispatcher MUST preserve
  `ContractError.exitCode` instead of the generic exit 1.
- `triggers list --fields a,b,c --json` MUST return `items` (and `triggers`)
  containing only the requested fields.
- Unbraked writes (`add`, `set`, `enable`, `disable`) MUST keep
  immediate-write behavior, and the shipped `triggers` skill MUST list them
  explicitly as unbraked together with the `test` rationale.
- Changes under this contract MUST NOT touch the trigger runtime
  (`src/triggers/`); only `src/cli/commands/triggers.ts` is in scope.
- `bun test src/cli/commands/triggers.test.ts` SHOULD pass after any change to
  the triggers contract surface.
