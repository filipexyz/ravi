# Permissions / CHECKS

## Checks

- Permission checks MUST fail closed when principal, action, object, or context
  cannot be resolved.
- Runtime checks MUST use canonical Ravi subjects and objects, not display names
  or raw provider ids.
- External shared-surface execution MUST authorize through agent identity and
  explicit turn caps, with actor/contact retained as provenance.
- Contact policy status MUST NOT be treated as tool, CLI, app, session, or
  gateway authority.
- Discovery surfaces MUST filter to resources visible to the effective context.
- `bun test src/permissions/provider-runtime.test.ts src/permissions/capability-context.test.ts src/permissions/delegation.test.ts src/permissions/denials.test.ts`
  SHOULD pass after changing permission behavior.
