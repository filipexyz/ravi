# Skill gates agent-first CLI contract / CHECKS

## Checks

- `skill-gates show <unknown-id> --json` MUST exit 1 with the `GATE_NOT_FOUND`
  envelope and up to three `suggestions` of real rule ids (defaults ∪
  configured).
- `skill-gates rm <custom-id>` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with a `plan` carrying `action: "delete-custom"` and the
  current row, and MUST NOT delete the rule; with `--execute` the rule MUST be
  deleted.
- `skill-gates rm <default-id>` without `--execute` MUST exit 3 with
  `action: "disable-default"` and MUST NOT write an override row; with
  `--execute` the default MUST be disabled via an override.
- `skill-gates rm <unknown-custom-id>` MUST exit 1 with `GATE_NOT_FOUND` even
  when `--execute` is passed — validation fires before the brake.
- `skill-gates reset <id>` with a configured override and no `--execute` MUST
  exit 3 with the override in `plan.discards` and MUST keep the override; with
  `--execute` the override MUST be deleted (`deleted: true`).
- `skill-gates reset <id>` without a configured override MUST keep the legacy
  no-op result: exit 0 and `deleted: false`, no brake.
- `skill-gates enable <never-configured-id> --json` MUST exit 1 with
  `GATE_NOT_FOUND` and suggestions restricted to configured overrides.
- `skill-gates list --fields a,b,c --json` MUST return items containing only
  the requested fields.
- Unbraked writes (`set`, `enable`, `disable`) MUST keep immediate-write
  behavior and the shipped `skill-gates` skill MUST list them as unbraked.
- `bun test src/cli/commands/skill-gates.test.ts` SHOULD pass after any change
  to the skill-gates contract surface.
