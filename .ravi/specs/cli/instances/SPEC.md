---
id: cli/instances
title: "Instances & routes agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - instances
  - routes
tags:
  - cli
  - instances
  - routes
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/instances.ts
  - src/cli/commands/routes.test.ts
  - src/cli/agent-contract.ts
  - src/cli/registry.ts
  - src/plugins/internal/ravi-system/skills/instances/SKILL.md
  - src/plugins/internal/ravi-system/skills/routes/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Instances & routes agent-first CLI contract

## Intent

Make the instance/routing surface (`ravi instances`, `ravi routes`,
`ravi instances routes`, `ravi instances pending` — all living in
`src/cli/commands/instances.ts`) reliable for agent consumers under the
agent-first contract defined by `cli`: typed error envelopes, the 0/1/2/3
exit taxonomy, risk-proportional confirmation, and compact discovery. Instance
and route deletion are recoverable local soft-deletes, so they execute in one
call; the runtime-target guard still prevents mutations against the wrong live
bundle/database.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. An unknown instance on `show`, `get`, `set`, `delete`, `enable`,
   `disconnect`, `status`, `target`, every `routes` op that takes an instance,
   and the `pending` ops MUST exit 1 with `INSTANCE_NOT_FOUND` and up to 3
   `suggestions` drawn from real instance names/omni instanceIds. Instances have
   no per-agent visibility cloak (`instances list` filters only by tag), so
   suggesting across all instances leaks nothing.
4. An unknown route pattern on `routes show`, `instances routes show|remove|set`
   MUST exit 1 with `ROUTE_NOT_FOUND` and up to 3 `suggestions` from that
   instance's real route patterns; `restore` variants suggest from the deleted
   records instead.
5. `instances delete` and `instances routes remove` MUST execute immediately
   without `--execute`: both are local soft-deletes with explicit restore
   commands. Resolution and the runtime-mismatch check MUST still run before
   the write. `instances pending reject` has no restore path and MUST retain
   dry-run + `--execute`, with its resolved pending entry in the plan.
6. Unbraked writes keep immediate-write behavior and MUST be listed as unbraked
   in the shipped skills: `create`, `set`, `enable`, `disable`, `restore`,
   `disconnect`, `delete`, `connect` (interactive QR pairing — human in the
   loop), `routes add`, `routes set`, `routes remove`, `routes restore`,
   `pending approve`.
7. `instances list` and `routes list` MUST accept `--fields a,b,c`; the
   projection MUST apply to both duplicated payload arrays (`items` +
   `instances` / `items` + `routes`).
8. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.
9. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2 and teach the correct syntax inline.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| instances delete | local soft-delete; `instances restore` is the inverse | not braked |
| instances routes remove | local soft-delete; `routes restore` is the inverse; live impact remains high | not braked |
| instances pending reject | destructive (discards pending entry, no restore path) | dry-run + `--execute` |
| create / set / enable / disable / restore / disconnect | reversible config | not braked (declared) |
| connect | interactive QR pairing, human in the loop | not braked (declared) |
| routes add / set / restore | reversible config with live-effect echo | not braked (declared) |
| pending approve | additive (allows contact / creates route) | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| instance not found | `INSTANCE_NOT_FOUND` + suggestions | 1 |
| route pattern not found | `ROUTE_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/instances/SKILL.md` and
`.../skills/routes/SKILL.md` teach this surface and MUST document `--execute`
only on `instances pending reject`; delete/route-remove examples stay
brake-free. The `architect` skill's teardown recipe must likewise remove the
obsolete flag from `instances routes remove`. `docs/cli/overview.mdx`,
`docs/guides/instances.mdx`, `docs/start/configuration.mdx` and
`docs/plan-instances.md` teach the same flags. Runtime consumers resolve routes
through `src/router` (`matchRoute`), not through the CLI, so the brake does not
affect live message routing.

## Validation

- `bun test src/cli/commands/routes.test.ts` green (contract block included),
  no new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`):
  `instances show nope --json` → `INSTANCE_NOT_FOUND`, exit 1 with suggestions;
  `routes show main nope --json` → `ROUTE_NOT_FOUND`, exit 1;
  `instances list --no-such-flag --json` → `USAGE_ERROR`, exit 2;
  `instances routes remove main "<pattern>" --json` → exit 0 and the route is
  soft-deleted; `routes list --json --fields
  pattern,agent` narrows items.

## Known Failure Modes

- `requireInstance`/`dbGetRoute` return `null` instead of throwing, but the
  helper chain (`buildRouteListPayload`, `buildRouteDetailsPayload`,
  `buildRouteExplanationPayload`) is shared by four command groups: forgetting
  to thread `op`/`asJson` through a helper regresses that path to plain text +
  exit 1.
- `instances disable` with an unknown target is NOT a not-found: it registers
  the target as an ignored omni instanceId (by design). Mapping it to
  `INSTANCE_NOT_FOUND` would break the ignore workflow.
- `routes remove` MUST run `assertInstanceMutationRuntime` before the local
  soft-delete so a runtime split cannot mutate the wrong database.
- `routes.test.ts` mocks `../context.js` spreading the real module; the mock
  MUST still override `hasContext: () => true` or the contract helpers call
  `process.exit` inside tests.
