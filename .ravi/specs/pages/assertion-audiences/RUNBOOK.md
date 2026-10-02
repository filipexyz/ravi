# Pages viewer-assertion audiences / RUNBOOK

1. Dry-run first. `ravi pages assertion audiences set --site demo --aud https://api.example --origin https://demo.ravi.page --json` exits 3 and does not call Console. `--origin` is this site's Pages host (`https://<site>.ravi.page` or an active custom hostname). `--aud` is the API identifier. An API URL in `--origin` is the wrong field.
2. Repeat with `--execute` after `ravi login`. The call is `PUT` or `DELETE /api/cli/projects/:projectRef/pages/:siteRef/viewer-assertion-audiences` (ravi-console#31). `--site` may be a slug, site id, or hostname. A 404 whose message is not "site not found" means that Console PR is not deployed. Keep the path.
3. Confirm with `ravi pages assertion audiences list --site <host> --json`. Read `jwksUrl`. It is `{consoleOrigin}/api/public/pages/viewer-assertions/jwks`. The API verifies signatures there. Do not copy an assertion out of a browser into logs.
4. Ship the page with `--uses ravi.identity.assertion` only when that page will call the registered API. The artifact stays free of tokens.
5. `remove --execute` drops one `aud`. It does not change visibility or delete the host.
6. `set --execute` exits 2 with `APP_GATEWAY_AUDIENCE_CONFLICT` when the aud has a Pages app gateway target on this site, even a revoked one. Pick another aud; check with `ravi pages apps targets list --site <host> --json`.
