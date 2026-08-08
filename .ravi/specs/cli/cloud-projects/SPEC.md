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
consumers under the agent-first contract defined by `cli`: typed error
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
   the dry-run MUST report `dryRun: true` and the plan (`slug`,
   `namePresent`, `descriptionPresent`, effective `defaultVisibility`,
   `defaultPageSite`), MUST NOT expose name/description content, and MUST NOT
   call Console.
4. Validation runs BEFORE the brake: an invalid `--visibility` MUST fail with
   `PAYLOAD_INVALID`, exit `2`, with or without `--execute`, and MUST NOT
   produce a plan.
5. `cloud projects list` MUST accept `--fields a,b,c` for compact output.
6. A `ContractError` thrown inside a command MUST pass through
   `runCloudProjectsCommand` untouched — the legacy CloudAuthError funnel MUST
   NOT rewrap it.
7. Remote failures preserve their stable CloudAuthError code through the
   global taxonomy: payload validation exits `2`; provider/auth failures exit
   `1`.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| create | creates a REAL remote Console resource (project + optional default Pages site); wrong-org blast radius | dry-run + `--execute` |

## Official error cases

| case | code | exit |
|---|---|---|
| braked create without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| invalid `--visibility` | `PAYLOAD_INVALID` | 2 |
| remote/provider errors | stable CloudAuthError code | 1 |

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

- Parser usage errors use the global exit-2 `USAGE_ERROR` envelope because the
  `cloud` root is registered in `AGENT_CONTRACT_DOMAINS`.
- The shared transport boundary MUST override the CloudAuthError object's
  historical exit map. Only `WRITE_REQUIRES_EXECUTE` means "re-run with
  --execute" and exits `3`.
- Before the rethrow guard, a `ContractError` thrown by the brake was
  rewrapped as `SERVER_UNAVAILABLE` exit 5 by `cloudAuthErrorFromUnknown`.
