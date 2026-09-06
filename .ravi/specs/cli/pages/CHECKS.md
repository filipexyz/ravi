# Pages agent-first CLI contract / CHECKS

## Checks

- `pages ship` without `--execute` MUST ensure the host (reuse an existing
  slug; do not fail) then publish+activate. It MUST NOT exit 3 with
  `WRITE_REQUIRES_EXECUTE` and MUST talk to Console when args are valid.
  `--execute` MUST be accepted as an unused no-op. `--body` MUST be wrapped
  in a simple HTML5 document. Success JSON MUST include
  `{url, site, slug, route, visibility, artifactId}`.
- `pages create` without `--execute` MUST write the host record. It MUST NOT
  exit 3 with `WRITE_REQUIRES_EXECUTE`. `--execute` MUST be accepted as an
  unused no-op.
- `pages publish` without `--execute` MUST upload/publish. It MUST NOT exit 3
  with `WRITE_REQUIRES_EXECUTE` and MUST talk to Console when args are valid.
  `--execute` MUST be accepted as an unused no-op.
- `pages domains` without `--execute` MUST exit 3 before credential reads,
  project resolution or any Console/provider request.
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
- A `ContractError` thrown by the remaining brakes or a not-found mapping MUST
  pass through `runPagesCommand`'s CloudAuthError funnel untouched.
- A 400 Console response carrying `DOMAIN_SETUP_REQUIRED` MUST preserve that
  code through cloud-auth mapping and render the sanitized TXT/CNAME instruction
  with exit 1; other provider messages MUST remain redacted.
- `pages list --fields a,b,c --json` and `pages published --fields a,b,c
  --json` MUST return items containing only the requested fields.
- Unbraked ops (`ship`, `create`, `publish`, visibility reductions and
  `password status`) MUST keep immediate behavior and be declared as unbraked
  in the spec.
- The dry-run plan of `pages domains` MUST work without saved Console scope,
  showing `(Console scope default)` placeholders instead of resolved refs.
- `ravi skills show pages` and `ravi skills show ravi-system-pages` MUST
  resolve to the same skill. The default gate `pages` MUST load
  `ravi-system-pages` for `ravi pages` and `pages.password`.
- The `pages` skill MUST teach `ravi pages ship … --json` as the only happy
  path to get a URL, without required `--execute`, and MUST NOT teach
  `create` + `publish` choreography. `create`/`publish` MAY appear only under
  an advanced/compat section.
- `bun test src/cli/commands/pages.test.ts` SHOULD pass after any change to
  the pages contract surface.
