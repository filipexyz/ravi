# Checks

- `bun test src/permissions/provider-runtime.test.ts` MUST pass after changing
  permission tag materialization.
- `bun test src/tags/tag-db.test.ts` MUST pass after changing tag definition or
  binding behavior.
- Generic tags MUST NOT produce runtime capabilities.
- Permission-scoped contact tags MUST materialize only through
  `contact-policy-permissions`.
- `permission.family` MUST materialize only when backed by a
  `kind=system`, `source=permissions` tag definition with explicit capability
  metadata.
- `permission.family` MUST NOT materialize for `pending` contacts or when the
  tag definition is missing.
