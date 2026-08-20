# CRM CLI interface / CHECKS

## Checks

- Expected CRM JSON failures MUST use the global `cli` envelope with the real
  operation path and a stable CRM code.
- Not-found errors MUST use entity-specific codes and MUST NOT expose
  suggestions outside the caller's visible scope.
- Invalid flags, arguments, enum values, and filters MUST be usage errors with
  accepted interface fields.
- Pipeline review and validation failures MUST retain stable codes and bounded
  details.
- Migrated lists MUST support `--fields` and a literal pagination next command
  or `null`.
- Positional names and focused help MUST remain semantic, compact, and aligned
  with `ravi crm help --json`.
- The shipped CRM skill MUST match live paths, arguments, and confirmation
  flags.
- Compatibility tests MUST preserve existing aliases and response fields until
  their consumers have a documented migration path.
- Effect-state, approval, execution, verification, and recovery assertions
  MUST live under `crm/facade`.
- `bun test src/cli/commands/crm.test.ts src/apps/router.test.ts` SHOULD pass
  after an interface or help-router change.
