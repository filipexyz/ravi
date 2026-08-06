---
id: cli/cloud-projects
title: "Cloud Projects agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - cloud-projects
tags:
  - cli
  - cloud
  - projects
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/cloud-projects.ts
  - src/cloud-projects/client.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Cloud Projects agent-first CLI contract

## Intent

Make `ravi cloud projects` (remote Ravi Console projects) reliable for agent
consumers under the agent-first contract defined by `cli/crm`: typed error
envelopes, the 0/1/2/3 exit taxonomy, a write brake on remote project
creation, and compact discovery. This is the domain of the RBBT wrong-scope
incident (see `cli/console-scope`): an agent creating a Console project in the
wrong organization is exactly the mistake the brake prevents.

## Invariants

1. With `--json`, every failure raised by the contract layer MUST return the
   envelope `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
2. Exit codes on contract paths MUST follow the taxonomy: `0` success · `1`
   error · `2` usage error · `3` blocked by policy (write brake).
3. `cloud projects create` MUST default to dry-run and require `--execute`;
   the dry-run MUST report `dryRun: true` and the plan (`slug`, effective
   `name`, `description`, effective `defaultVisibility`, `defaultPageSite`),
   and MUST NOT call Console.
4. Validation runs BEFORE the brake: an invalid `--visibility` MUST fail with
   `PAYLOAD_INVALID` (legacy funnel) with or without `--execute`, and MUST NOT
   produce a plan.
5. `cloud projects list` MUST accept `--fields a,b,c` for compact output.
6. A `ContractError` thrown inside a command MUST pass through
   `runCloudProjectsCommand` untouched — the legacy CloudAuthError funnel MUST
   NOT rewrap it.
7. Remote failures (auth, org denials) keep the legacy CloudAuthError funnel
   with its pre-existing code/exit map.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| create | creates a REAL remote Console resource (project + optional default Pages site); wrong-org blast radius | dry-run + `--execute` |

## Official error cases

| case | code | exit |
|---|---|---|
| braked create without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| invalid `--visibility` | `PAYLOAD_INVALID` (legacy funnel) | legacy CloudAuthError exit map (3) |
| remote/provider errors | legacy CloudAuthError codes | legacy CloudAuthError exit map |

## Internal consumers

`ravi connectors connect` and the console-scope resolver
(`validateProjectRef`) call `listCloudProjects` from the service layer — the
brake on the CLI `create` does not affect them. The wrong-scope debugging
story (local `rbbt` vs remote `rbbt-ravi`) lives in `cli/console-scope`. There
is no shipped `cloud-projects` skill — lacuna registrada; the CLI `--help`
plus this spec are the teaching surface.

## Validation

- `bun test src/cli/commands/cloud-projects.test.ts` green (contract describes
  included).
- `bun run typecheck` clean.

## Known Failure Modes

- The `cloud` domain root is not yet listed in `AGENT_CONTRACT_DOMAINS`
  (`src/cli/index.ts`, out of scope for this migration lot), so commander
  parser usage errors still print plain text with exit 1 instead of the
  `USAGE_ERROR` envelope with exit 2.
- The legacy CloudAuthError funnel maps `PAYLOAD_INVALID` to exit 3, which
  collides numerically with the write brake. Read `error.code` — only
  `WRITE_REQUIRES_EXECUTE` means "re-run with --execute".
- Before the rethrow guard, a `ContractError` thrown by the brake was
  rewrapped as `SERVER_UNAVAILABLE` exit 5 by `cloudAuthErrorFromUnknown`.
