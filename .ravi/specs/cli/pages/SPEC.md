---
id: cli/pages
title: "Pages agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - pages
tags:
  - cli
  - pages
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/pages.ts
  - src/cli/agent-contract.ts
  - src/pages/client.ts
  - src/pages/ship.ts
  - src/artifacts/publish-client.ts
  - src/plugins/internal/ravi-system/skills/pages/SKILL.md
  - src/cli/skill-gates.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Pages agent-first CLI contract

## Intent

Make `ravi pages` (and the `pages.password` group) reliable for agent
consumers under the agent-first contract defined by `cli`: typed error
envelopes, the 0/1/2/3 exit taxonomy, risk-based confirmation for external
Console mutations and public exposure, and compact discovery. Pages talks
exclusively to Console, so the contract lives IN FRONT of the legacy
CloudAuthError funnel:
contract errors rethrow first, recognizable Console not-found failures map to
`SITE_NOT_FOUND`/`ROUTE_NOT_FOUND`, everything else keeps the legacy funnel.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` execution/provider
   error · `2` usage error · `3` blocked by policy. Non-mapped Console failures
   preserve their stable CloudAuthError code under this global exit map.
3. A Console failure whose message matches a site not-found MUST exit 1 with
   `SITE_NOT_FOUND` and suggestedAction `ravi pages list --json`; a route
   not-found MUST exit 1 with `ROUTE_NOT_FOUND` and suggestedAction
   `ravi pages published --json`. Sites/routes live only in Console, so there
   is no cheap local candidate source — listing suggestedAction, never
   similarity suggestions.
4. `pages ship` MUST execute immediately when invoked with valid args. It
   MUST NOT dry-run, MUST NOT exit 3 with `WRITE_REQUIRES_EXECUTE`, and MUST
   talk to Console (or fail on credentials / usage) without `--execute`.
   `--execute` MAY remain as an unused compatibility no-op so existing scripts
   keep working. `pages create` and `pages publish` MUST dry-run (exit 3)
   until `--execute`. Public visibility on `ship`/`create`/`publish` is
   allowed in the same call. `pages domains` MUST
   still default to dry-run and require `--execute` before credential, project
   or provider resolution. Its plan MUST contain only parsed identifiers,
   counts and presence metadata.
5. `pages password set` and `pages password remove` MUST default to dry-run
   and require `--execute`. The `set` dry-run MUST fire BEFORE the hidden
   password prompt (a dry-run never reads secret material) and its plan MUST
   never carry a password or route path; it carries only `routePresent` route
   metadata. `remove` uses the same route metadata and MUST validate the
   replacement visibility BEFORE the brake (missing `--visibility` is
   `PAYLOAD_INVALID` even on the dry-run path).
6. `pages update` and `pages visibility` carry a CONDITIONAL brake: switching
   a site default to `public` requires `--execute` (exit 3 otherwise);
   reducing visibility (`private`/`protected_link`) writes immediately —
   lockdowns are never slowed down. `pages visibility` without `--route`
   MUST keep updating only site `defaultVisibility`. With `--route /` (or
   `/foo`) it MUST change that route's visibility only, without uploading
   artifacts, and success output MUST report the effective route visibility.
7. `--execute` is the LAST declared option on every braked op.
8. `pages list` and `pages published` MUST accept `--fields a,b,c`.
9. A thrown `ContractError` MUST pass through `runPagesCommand`'s
   CloudAuthError funnel untouched (rethrow-first, model: mail.ts).
10. When Console HTTPS fails from a provider sandbox, `pages published`,
    `pages list`, and `pages publish` MUST surface `HOST_UNREACHABLE` rather
    than `SERVER_UNAVAILABLE`. The host CLI remaining able to publish/read
    proves Console is up. Isolated CLIs MAY use the host unix-socket CLI
    gateway when `RAVI_CONTEXT_KEY` is set and `~/.ravi/cli-gateway.sock` is
    reachable. They MUST NOT auto-open raw `127.0.0.1`.
11. `pages ship` without a positional slug MUST publish a route on the
    project's default Pages host: a listed site with `isDefault`, otherwise
    the project-owned slug `<orgSlug>-<projectSlug>` (created once, with
    `isDefault`, when it is missing and the slug is computable). `--title`
    MUST NOT become a host slug. `--route` defaults to `/`. A positional slug
    is a legacy extra host: it MAY create or reuse that slug and MUST warn.
    Host slugs `ravi` and `ravi-*` MUST NOT be created.
12. `pages domains --execute` MUST be one idempotent setup command. When
    ownership or Pages DNS is not ready, the CLI MUST recognize
    `DOMAIN_SETUP_REQUIRED`, surface the Console-authored DNS instruction, exit
    1, and tell the operator to rerun the same command after propagation. This
    is the only cloud error whose authenticated Console message may cross the
    generic provider-message redaction boundary; terminal control characters
    MUST be stripped and output MUST be length-bounded.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| ship | publishes a route on the project default host (creates that one host when missing). A positional slug is a legacy extra host | not braked / executes immediately (`--execute` unused no-op) |
| publish | uploads bytes and (default) activates a hosted route | dry-run + `--execute` |
| password set | flips the route access policy on a live site (high) | dry-run + `--execute`, braked before the secret prompt |
| password remove | widens who can reach the route, up to fully public (high) | dry-run + `--execute`, visibility validated first |
| update / visibility → `public` | exposes already-hosted content to the open web | conditional dry-run + `--execute` |
| visibility --route → `public` | flips one published route's access policy without re-uploading bytes | conditional dry-run + `--execute`; plan names site vs route and current vs target |
| update / visibility → `private`/`protected_link` | reduces exposure, reversible | not braked (declared) |
| create | creates a host record in Ravi Console | dry-run + `--execute` |
| domains | changes provider-backed hostname bindings and routing | dry-run + `--execute` |
| assertion audiences set | registers Pages host origins that may receive a viewer assertion for one aud | dry-run + `--execute` (see `pages/assertion-audiences`) |
| assertion audiences remove | drops one assertion audience | dry-run + `--execute` (see `pages/assertion-audiences`) |
| assertion audiences list | reads the host allowlist | not braked |
| apps targets set | lets this site's pages invoke listed operations on one installation for one aud | dry-run + `--execute`; the dry-run MAY read `GET /api/cli/me` to name the installation and MUST NOT write (see `pages/app-gateway`) |
| apps targets remove | revokes one app gateway target; the aud stays reserved | dry-run + `--execute` before credentials (see `pages/app-gateway`) |
| apps targets list | reads the site's app gateway targets, active and revoked | not braked |

There is no `pages remove`/route-removal command on this surface today; if one
is added it MUST arrive braked. Viewer-assertion audience removal is
`pages assertion audiences remove`, which is braked, and it does not delete a
route. App gateway target removal is `pages apps targets remove`, which is
braked, revokes the target, and does not delete a route.

## Official error cases

| case | code | exit |
|---|---|---|
| Console site not found | `SITE_NOT_FOUND` + listing suggestedAction | 1 |
| Console route not found | `ROUTE_NOT_FOUND` + listing suggestedAction | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| domain setup saved but waiting for DNS/provider readiness | `DOMAIN_SETUP_REQUIRED` + exact safe DNS action | 1 |
| Console HTTPS failed from a provider sandbox | `HOST_UNREACHABLE` + host CLI suggestedAction | 1 |
| other Console failures (auth, payload, rate limit) | stable CloudAuthError code | `2` for `PAYLOAD_INVALID`; otherwise `1` |

## Internal consumers

The agent-first happy path is `ravi pages ship`, taught by the `pages` skill
(`ravi skills show pages` / `ravi skills show ravi-system-pages`) and by
`AGENTS.md` ("Ravi Pages Publishing"). Agents MUST NOT choreograph
`create` + `publish` to get a URL. `create` and `publish` remain implemented
as advanced/compat commands (host-only create; publish onto an existing host
or a local `art_*`) and MUST keep working. They MUST NOT be taught as the
default path. The `contentPublishCommand` hint returned by `pages create`
(`src/pages/client.ts`) still points at `pages publish` without a required
`--execute`. The `artifacts` skill MUST NOT teach Pages publishing; it points
at skill `pages`.

The default skill gate `pages` (`/^pages(?:[._]|$)/` → `ravi-system-pages`)
MUST load the skill for `ravi pages …` and `pages.password`.

## Known gaps

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
- The Console not-found mapping is message-based (`site|route ... not found`);
  unrecognized 404 phrasings intentionally fall back to the legacy funnel
  instead of guessing a resource kind.

## Validation

- `bun test src/cli/commands/pages.test.ts` green (contract block included),
  no new failures vs the `dev` baseline.
- Live checks on the local CLI: `pages ship --title T --route /weekly --body "<p>x</p>" --json`
  → project default host + that route and JSON `{url,site,slug,route,visibility,artifactId}`.
  `slug` is the host, not a slug derived from the title.
  (passing leftover `--execute` is a no-op); `pages create p s --json` →
  writes the host immediately; `pages publish p s ./site --json` → publishes;
  `pages domains p s docs.example.com --json` → exit 3 before credentials;
  `pages password set p s --json`
  → exit 3 without prompting;   `pages visibility p s public --json` → exit 3;
  `pages visibility p s private --json` → immediate write;
  `pages visibility p s public --route / --json` → exit 3 without a route
  mutation; `pages visibility p s public --route / --execute --json` → route
  update and `{target:"route", effectiveVisibility}`; `pages list --json
  --fields slug,status` narrows items.

## Known Failure Modes

- The CloudAuthError object retains a historical internal exit scheme, but the
  shared transport MUST normalize it to the global taxonomy. The
  ContractError rethrow in `runPagesCommand` keeps a braked dry-run from being
  re-wrapped as a provider failure.
- `pages.test.ts` uses the REAL context module (no context mock): braked calls
  in tests MUST run inside `runWithContext({}, ...)` so the contract helpers
  throw `ContractError` instead of killing the test process with
  `process.exit(3)`.
- Braking `domains` after project resolution would let a dry-run touch
  credential/provider state. Braking `password set` AFTER the prompt would
  make dry-runs read secret material; the brake fires right after arg
  parsing, before prompt and before any Console call. `ship` is unbraked
  on purpose; leftover `--execute` is ignored. `create` and `publish` keep
  the brake.
