# Bases agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/bases --mode rules --json`.
2. Reproduce with `--json` and `--project <ref>`; check `error.code`,
   `error.consoleError`, and `error.requestId`.
3. `PROJECT_ACCESS_DENIED` with `missingScopes`: run `ravi login` again.
   Without `missingScopes`: the user lacks project or base access; try the
   view the user was given (`--view`).
4. `VERSION_CONFLICT`: read `error.current`, merge, retry with
   `--expected-version <current.version>`.
5. `CONFLICT` with `consoleError: idempotency_conflict`: the key was reused
   with another body. For imports, re-run with the original `--batch`.
6. `PAYLOAD_INVALID` with `cursor_invalid`: re-run without `--cursor`.
7. A brake that reached the Console, or a 409 reported as `AUTH_PENDING` on a
   Bases path, is a regression: check `contractDryRun` ordering in
   `src/cli/commands/bases.ts` and `statusToErrorCode` in
   `src/cloud-auth/client.ts`.
8. Row events missing: `ravi bases subscriptions <base> --json`, then
   `ravi inbox status`; events arrive on `ravi.console.inbox.item` with
   `category: "bases"`.
9. A generated page shows an error (the `error` field of the exec response):
   - `connector_not_allowlisted`: the id is missing from the host's active
     release. `grep -o 'ravi\.bases\.[a-z.]*' page.html | sort -u`, then
     ship again with `--uses` listing those ids (and the ids of the other
     data pages on the same host).
   - `not_found` on `views.describe` or `charts.data`: the view does not
     grant `{kind: "page_viewer", siteId}` for this site, the view or chart
     was archived (pages never manage, so archived reads as missing), or the
     id is wrong. Check
     `ravi bases views show <base> <view> --json` against
     `ravi pages list --project <ref> --json`.
   - `connector_permission_required`: the viewer's Pages session is not a
     login session (capture or unscoped), or Bases is off for the
     organization.
   - `connector_session_required`: no Pages session: a public route the
     viewer opened without signing in, or a password-protected route (a
     password session is not a Pages session, and reloading only shows the
     password prompt again). Keep data pages on private routes without a
     password.
   - `connector_unauthorized`: the session expired or is invalid, the viewer
     lost organization membership or project read, or the write came with
     another `Origin`. Reloading a private route signs the viewer in again.
   - `view_invalid`: a property the view or chart uses was deleted. Fix it
     with `bases views update` or `bases charts update`.
   - `base_forbidden`: the page called an action the view does not grant
     (`query` on a form view, create without `write.create`). Compare with
     `capabilities` from `views.describe`.

## Validation

```bash
bun test src/bases/ src/cloud-auth/
bun test --timeout 20000 src/cli/commands/bases.test.ts
bun test src/cli/confirmation-policy.test.ts src/cli/commands/json-coverage.test.ts \
  src/cli/commands/pagination-coverage.test.ts src/sdk/client-codegen/return-schema-coverage.test.ts
make quality
```

Live checks (requires `ravi login` with the Bases scopes):

```bash
ravi bases list --project <ref> --json
ravi bases rows query <base> --limit 5 --json
ravi bases rows purge <base> <row> --json   # expect exit 3, nothing deleted
```
