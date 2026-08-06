# Observers agent-first CLI contract / CHECKS

## Checks

- `observers rules rm <id>` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with the deletion `plan`, and MUST NOT delete the rule; with
  `--execute` the delete MUST happen.
- `observers rules rm <unknown-id> --json` MUST exit 1 with the
  `OBSERVER_NOT_FOUND` envelope and up to three `suggestions` of real rule ids
  — validated BEFORE the brake, so a bad id never reaches exit 3.
- `observers show <unknown-binding> --json` and `observers profiles show
  <unknown-profile> --json` MUST exit 1 with `OBSERVER_NOT_FOUND` and
  suggestions from the matching local list.
- `observers rules enable|disable <unknown-id> --json` MUST exit 1 with the
  envelope instead of the raw `dbSetObserverRuleEnabled` throw, and MUST NOT
  write.
- `observers refresh <unknown-session> --json` (and `rules explain`, and
  `observers list --session`) MUST exit 1 with `SESSION_NOT_FOUND` and MUST NOT
  carry suggestions.
- `observers list`, `observers rules list` and `observers profiles list` with
  `--fields a,b --json` MUST return items containing only the requested fields.
- Unbraked writes (`refresh`, `rules set`, `rules enable|disable`,
  `profiles init`) MUST keep immediate-write behavior and MUST be listed as
  unbraked in the shipped `observers` skill.
- The shipped `observers` skill (`skills/observers/SKILL.md`) MUST document
  `--execute` on `rules rm`.
- `bun test src/cli/commands/observers.test.ts` SHOULD pass after any change to
  the observers contract surface.
