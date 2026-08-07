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
  - src/artifacts/publish-client.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Pages agent-first CLI contract

## Intent

Make `ravi pages` (and the `pages.password` group) reliable for agent
consumers under the agent-first contract defined by `cli`: typed error
envelopes, the 0/1/2/3 exit taxonomy, a write brake on every op that changes
what the open web can reach, and compact discovery. Pages talks exclusively to
Console, so the contract lives IN FRONT of the legacy CloudAuthError funnel:
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
4. `pages publish` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and the `plan`, and MUST NOT call
   Console at all — not even the project scope resolution.
5. `pages password set` and `pages password remove` MUST default to dry-run
   and require `--execute`. The `set` dry-run MUST fire BEFORE the hidden
   password prompt (a dry-run never reads secret material) and its plan MUST
   never carry a password. `remove` MUST validate the replacement visibility
   BEFORE the brake (missing `--visibility` is `PAYLOAD_INVALID` even on the
   dry-run path).
6. `pages update` and `pages visibility` carry a CONDITIONAL brake: switching
   a site default to `public` requires `--execute` (exit 3 otherwise);
   reducing visibility (`private`/`protected_link`) writes immediately —
   lockdowns are never slowed down.
7. `--execute` is the LAST declared option on every braked op.
8. `pages list` and `pages published` MUST accept `--fields a,b,c`.
9. A thrown `ContractError` MUST pass through `runPagesCommand`'s
   CloudAuthError funnel untouched (rethrow-first, model: mail.ts).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| publish | uploads bytes + (default) activates a public hosted route (external exposure, high) | dry-run + `--execute` |
| password set | flips the route access policy on a live site (high) | dry-run + `--execute`, braked before the secret prompt |
| password remove | widens who can reach the route, up to fully public (high) | dry-run + `--execute`, visibility validated first |
| update / visibility → `public` | exposes already-hosted content to the open web | conditional dry-run + `--execute` |
| update / visibility → `private`/`protected_link` | reduces exposure, reversible | not braked (declared) |
| create | ensures the host record only; no bytes are reachable until the braked publish | not braked (declared) |
| domains | reversible binding, needs external DNS control; exposure gated by publish/visibility | not braked (declared) |

There is no `pages remove`/route-removal command on this surface today; if one
is added it MUST arrive braked.

## Official error cases

| case | code | exit |
|---|---|---|
| Console site not found | `SITE_NOT_FOUND` + listing suggestedAction | 1 |
| Console route not found | `ROUTE_NOT_FOUND` + listing suggestedAction | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| other Console failures (auth, payload, rate limit) | stable CloudAuthError code | `2` for `PAYLOAD_INVALID`; otherwise `1` |

## Internal consumers

`ravi pages publish` is taught in `AGENTS.md` ("Ravi Pages Publishing"), in the
`artifacts` skill, and in the `contentPublishCommand` hint returned by
`pages create` (`src/pages/client.ts`) — the skill and the hint carry
`--execute`; AGENTS.md is owned by the workspace-instructions wave.

## Known gaps

- Pages has NO dedicated skill: the `artifacts` skill hosts the Pages
  publishing/password guidance today. A `pages` skill is a registered gap for
  a follow-up wave.
- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
- The Console not-found mapping is message-based (`site|route ... not found`);
  unrecognized 404 phrasings intentionally fall back to the legacy funnel
  instead of guessing a resource kind.

## Validation

- `bun test src/cli/commands/pages.test.ts` green (contract block included),
  no new failures vs the `dev` baseline.
- Live checks on the local CLI: `pages publish p s ./site --json` → exit 3, no
  Console call; with `--execute` → publishes; `pages password set p s --json`
  → exit 3 without prompting; `pages visibility p s public --json` → exit 3;
  `pages visibility p s private --json` → immediate write; `pages list --json
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
- Braking `password set` AFTER the prompt would make dry-runs read secret
  material; the brake fires right after arg parsing, before prompt and before
  any Console call.
