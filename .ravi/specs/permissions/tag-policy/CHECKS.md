# Checks

- `bun test src/permissions/provider-runtime.test.ts`
- `bun test src/tags/tag-db.test.ts`
- Verify generic tags do not produce runtime capabilities.
- Verify permission-scoped contact tags materialize only through
  `contact-policy-permissions`.
