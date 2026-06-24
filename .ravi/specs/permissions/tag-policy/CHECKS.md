# Checks

- `bun test src/permissions/provider-runtime.test.ts`
- `bun test src/tags/tag-db.test.ts`
- Verify generic tags do not produce runtime capabilities.
- Verify permission-scoped contact tags materialize only through
  `contact-policy-permissions`.
- Verify `permission.family` materializes only when backed by a
  `kind=system`, `source=permissions` tag definition with explicit capability
  metadata.
- Verify `permission.family` does not materialize for `pending` contacts or
  when the tag definition is missing.
