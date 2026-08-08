# Pages agent-first CLI contract / CHECKS

## Checks

- `pages publish` without `--execute` MUST exit 3, MUST report `dryRun: true`
  with exactly `project`, `site`, `sourceKind`, path-basename-only
  `sourceName`, `route`, `visibility` and `entrypointPresent`; it MUST NOT
  expose the raw source path or title/description content, and MUST NOT call
  Console at all — not even the project scope resolution. With `--execute`
  the upload/release MUST happen.
- `pages password set` without `--execute` MUST exit 3 BEFORE the hidden
  password prompt and before any Console call; its plan MUST NOT contain a
  password key or raw route path and MUST use `routePresent` metadata.
- `pages password remove` MUST reject a missing replacement `--visibility`
  with `PAYLOAD_INVALID` even without `--execute`; with a valid visibility and
  no `--execute` it MUST exit 3 without calling Console or exposing the raw
  route path.
- `pages update`/`pages visibility` switching a site to `public` without
  `--execute` MUST exit 3; switching to `private` or `protected_link` MUST
  write immediately without any brake.
- A Console failure whose message matches a site not-found MUST surface as the
  `SITE_NOT_FOUND` envelope (exit 1) with suggestedAction `ravi pages list
  --json`; a route not-found MUST surface as `ROUTE_NOT_FOUND` (exit 1) with
  suggestedAction `ravi pages published --json`.
- A `ContractError` thrown by the brake or a not-found mapping MUST pass
  through `runPagesCommand`'s CloudAuthError funnel untouched.
- `pages list --fields a,b,c --json` and `pages published --fields a,b,c
  --json` MUST return items containing only the requested fields.
- Unbraked ops (`create`, `domains`, visibility reductions, `password status`)
  MUST keep immediate behavior and be declared as unbraked in the spec.
- The dry-run plans of `pages publish` MUST work without saved Console scope,
  showing `(Console scope default)` placeholders instead of resolved refs.
- `bun test src/cli/commands/pages.test.ts` SHOULD pass after any change to
  the pages contract surface.
