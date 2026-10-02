---
id: pages/assertion-audiences
title: "Pages viewer-assertion audiences"
kind: capability
domain: pages
capabilities:
  - assertion-audiences
tags:
  - pages
  - auth
  - console
  - cli
applies_to:
  - src/pages/assertion-audiences.ts
  - src/cli/commands/pages.ts
  - src/artifacts/publish-client.ts
  - src/cloud-auth/client.ts
  - src/plugins/internal/ravi-system/skills/pages/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---

# Pages viewer-assertion audiences

## Intent

A third-party API can trust a short-lived Console viewer assertion for one Pages host. OSS does not sign that assertion and does not store it. This surface registers the audience allowlist and tells a shipped page to opt in.

Console owns the viewer, the signature, revocation, and the JWKS document. The sibling Console PR implements the HTTP handlers. Until that PR is on Console main, this CLI still calls the locked paths below and treats a 404 as "not deployed", not as a missing site.

## Commands

```
ravi pages assertion audiences list --site <host> --json
ravi pages assertion audiences set --site demo --aud https://api.example --origin https://demo.ravi.page [--origin https://docs.example] --execute
ravi pages assertion audiences remove --site <host> --aud <aud> --execute
```

`--site` is the Console `siteRef`. It accepts a host slug, a site id, or a hostname such as `acme-proj.ravi.page`. The CLI passes that string through. `--project` and `--console` follow the rest of the pages group. Project resolution uses the active Console scope when `--project` is omitted.

`--aud` is who the assertion is for (the third-party API identifier). `--origin` is which origins of this Pages site may receive it. Each origin MUST be an `https` origin of this site: the default host (`https://<site>.ravi.page`) or an active custom hostname on the same site. The API URL is not an origin. Viewer assertions are minted for a viewer on that Pages host. The registry binds `(site, aud)` to those hostnames so only that host may receive or mint for that audience.

## Invariants

1. `list` MUST be read-only. It MUST NOT accept `--execute` and MUST NOT dry-run. It MUST accept `--limit` and `--offset` and return offset pagination.
2. `set` and `remove` MUST default to dry-run. Without `--execute` they MUST exit 3 with `WRITE_REQUIRES_EXECUTE` before credential reads, project resolution, or any Console call. `--execute` MUST be the last declared option.
3. `set` MUST require `--site`, `--aud`, and at least one `--origin` before the brake. `remove` MUST require `--site` and `--aud` before the brake. A missing value is `PAYLOAD_INVALID` (exit 2), including on the dry-run path.
4. Each `--origin` MUST be an `https` origin: scheme, host, optional port. A path, query, fragment, or userinfo MUST be rejected. Repeated `--origin` flags and comma-separated values MUST merge into one unique list of at most 8 origins. `set` MUST replace the origin list for that `aud`. More than 8 origins is `PAYLOAD_INVALID` before any Console call. OSS MUST NOT keep a second hostname allowlist. Console rejects an origin whose hostname is not this site's default host or an active custom hostname with HTTP 400 `PAYLOAD_INVALID`. The CLI MUST surface that Pages-host rule. A safe Console message MUST be forwarded. An unsafe provider body MUST stay behind the rule text.
5. `--aud` and `--origin` MUST NOT accept a JWT. Requests MUST send `aud`. Console responses use `audience` and MAY also send `aud`. The parser MUST accept both and MUST prefer `audience` when both are present. Success JSON and human output MUST allowlist `aud` and `origins` only. Fields named like tokens, and any JWT-shaped audience returned by Console, MUST be dropped. The CLI MUST NOT log the assertion, the access token, or the refresh token.
6. `list` MUST `GET /api/cli/projects/:projectRef/pages/:siteRef/viewer-assertion-audiences`. `set` MUST `PUT` that path with `{ aud, origins }`. `remove` MUST `DELETE` that path with `{ aud }`. `siteRef` is only the path segment. These paths are the contract in ravi-console#31. The CLI MUST NOT invent a fallback path when Console returns 404.
7. Success JSON MUST include `jwksUrl`. That URL MUST be `{consoleOrigin}/api/public/pages/viewer-assertions/jwks`, derived from the configured Console base URL. A Console `jwksUrl` is used only when it is that path on the same origin. Any other value MUST be ignored.
8. `pages ship --uses ravi.identity.assertion` MUST put that id on the finalize publish body as `uses`. Omitting `--uses` MUST leave `uses` off the publish body. An id that is not a dotted capability token, including a JWT, MUST be `PAYLOAD_INVALID` before any Console call. The ship MUST NOT embed an assertion or a CLI JWT in the artifact.
9. A Console HTTP 409 on `set` MUST be `APP_GATEWAY_AUDIENCE_CONFLICT` (exit 2). The aud has a Pages app gateway target row on this site in any status, and a revoked target still reserves it. The CLI MUST NOT suggest `ravi unlink` for it.
10. The skill `pages` MUST document this group, that `--origin` is a Pages host origin for the site (not the API URL), the `ravi.identity.assertion` use, the JWKS URL, and the rule against logging the JWT. Skill examples MUST NOT use an API URL as `--origin`.

## Write classification

| op | class | brake |
|---|---|---|
| assertion audiences list | reads the host allowlist | none |
| assertion audiences set | lets this site's Pages host origins receive a viewer assertion for one aud | dry-run + `--execute` |
| assertion audiences remove | stops new assertions for one aud | dry-run + `--execute` |
| ship `--uses` | declares a capability on an otherwise normal ship | same brake as `pages ship` |

## Official error cases

| case | code | exit |
|---|---|---|
| `set` or `remove` without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| missing `--site`, `--aud`, or `--origin`; non-https origin; JWT passed as aud/origin/uses | `PAYLOAD_INVALID` | 2 |
| Console HTTP 400 on `set` (`--origin` is not this site's hostname, or another payload rejection) | `PAYLOAD_INVALID` + Pages-host rule when the body is an origin rejection or unsafe; safe Console text forwarded | 2 |
| Console HTTP 409 on `set` (aud has an app gateway target on this site, active or revoked) | `APP_GATEWAY_AUDIENCE_CONFLICT` | 2 |
| Console site not found | `SITE_NOT_FOUND` | 1 |
| Console route for this collection not deployed (404 that is not a site/route miss) | stable CloudAuthError | 1 |

## App gateway targets

App gateway targets are a separate registry with their own CLI, `ravi pages apps targets list|set|remove`. Its contract is `pages/app-gateway`. One `(site, aud)` belongs to at most one registry: Console refuses a viewer-assertion audience that has a gateway target row on the site in any status, and refuses a gateway target whose aud is an active viewer-assertion audience. This group MUST NOT register or remove gateway targets.

## Console dependency

Handlers live in [ravi-console#31](https://github.com/filipexyz/ravi-console/pull/31). The Console spec is `.ravi/specs/console/pages/viewer-assertions/cli/SPEC.md`. This CLI calls:

```
GET    /api/cli/projects/:projectRef/pages/:siteRef/viewer-assertion-audiences
PUT    /api/cli/projects/:projectRef/pages/:siteRef/viewer-assertion-audiences
DELETE /api/cli/projects/:projectRef/pages/:siteRef/viewer-assertion-audiences
GET    {consoleOrigin}/api/public/pages/viewer-assertions/jwks
```

`siteRef` accepts a host slug, site id, or hostname. `PUT` body is `{ aud, origins: string[] }` (at most 8 origins). `DELETE` body is `{ aud }`. Console serializes each row as `audience`. `pages ship` MAY send `publish.uses: string[]` when `--uses` is set. The dry-run still exits 3 locally.
