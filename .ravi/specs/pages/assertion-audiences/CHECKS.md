# Pages viewer-assertion audiences / CHECKS

- `pages assertion audiences list --site <host>` MUST `GET /api/cli/projects/:projectRef/pages/:siteRef/viewer-assertion-audiences` and MUST NOT dry-run. `<host>` MAY be a slug, site id, or hostname. It MUST accept `--limit` and `--offset`.
- List JSON MUST include `jwksUrl` of `{consoleOrigin}/api/public/pages/viewer-assertions/jwks` and MUST omit JWT-shaped audiences and token fields from the Console body.
- A Console audience row `{ audience, origins }` MUST populate CLI `aud`. A row that only has `aud` MUST still parse. When both fields are present, `audience` MUST win.
- `set` without `--execute` MUST exit 3 before credentials and Console. The plan MUST include `site`, `aud`, and `origins`, and MUST NOT include a JWT.
- `set` with `--execute` MUST `PUT /api/cli/projects/:projectRef/pages/:siteRef/viewer-assertion-audiences` with `{ aud, origins }` and MUST NOT repeat `siteRef` in the body. Repeated `--origin` values MUST be unique https origins. More than 8 origins, and `http` origins, MUST be `PAYLOAD_INVALID` before the brake. A set response that uses `audience` MUST still fill the CLI audience row.
- `remove` without `--aud` MUST be `PAYLOAD_INVALID` before the brake. With `--aud` and without `--execute` it MUST exit 3 without calling Console. With `--execute` it MUST `DELETE` that same path with `{ aud }`.
- `pages ship --uses ravi.identity.assertion` MUST send `publish.uses` containing that id and MUST NOT send a JWT. Omitting `--uses` MUST omit `uses`.
- The `pages` skill MUST name `ravi.identity.assertion`, the JWKS URL, and the ban on logging the JWT. Its `set` examples MUST use a Pages host origin (`https://<host>.ravi.page` or a custom hostname of that site) and MUST NOT use an API URL as `--origin`.
- `pages assertion audiences set --help` MUST say `--origin` is an https origin of this Pages site (default host or active custom hostname), not the third-party API, and MUST example a Pages host origin such as `https://demo.ravi.page`.
- A Console HTTP 400 `PAYLOAD_INVALID` on `set --execute` whose message says the hostname must be this site's default or active custom hostname MUST be forwarded with the Pages-host rule. A provider dump in that body MUST NOT be forwarded. The CLI MUST NOT reject origins with a local hostname allowlist.
- A Console HTTP 409 on `set --execute` MUST surface `APP_GATEWAY_AUDIENCE_CONFLICT` with exit 2, MUST say the aud is reserved for a Pages app gateway target on this site, and MUST NOT suggest `ravi unlink`.
- App gateway targets MUST be managed only through `ravi pages apps targets` (contract `pages/app-gateway`), never through `pages assertion audiences`.
