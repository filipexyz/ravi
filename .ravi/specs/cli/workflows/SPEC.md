---
id: cli/workflows
title: "Workflows agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - workflows
tags:
  - cli
  - workflows
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/workflows.ts
  - src/cli/agent-contract.ts
  - src/cli/registry.ts
  - src/workflows/service.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Workflows agent-first CLI contract

## Intent

Make `ravi workflows` (`specs` and `runs` groups) reliable for agent consumers
under the agent-first contract defined by `cli`: typed error envelopes, the
0/1/2/3 exit taxonomy, a write brake on the two riskiest mutations, and compact
discovery. `runs start` instantiates a live run that gates coordinated work
(the direct analog of `projects workflows start`), and `runs archive-node` is
irreversible — those two are the braked ops.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. Unknown refs MUST exit 1 with the code matching the resource:
   `WORKFLOW_SPEC_NOT_FOUND` (suggestions from `listWorkflowSpecs` ids/titles),
   `WORKFLOW_RUN_NOT_FOUND` (suggestions from `listWorkflowRuns` ids/titles),
   `WORKFLOW_NODE_NOT_FOUND` (suggestions from the run's node keys/labels) and
   `TASK_NOT_FOUND` on `task-attach`.
4. Node-level ops (`release`, `skip`, `cancel`, `archive-node`, `task-attach`,
   `task-create`) MUST pre-resolve the run so a missing RUN surfaces as
   `WORKFLOW_RUN_NOT_FOUND` — the service alone cannot tell "unknown run" from
   "unknown node" (`Workflow node K not found in run R.` covers both).
5. `workflows runs start` and `workflows runs archive-node` MUST default to
   dry-run and require `--execute`; the dry-run MUST report `dryRun: true` and
   the `plan`, with workflow titles reduced to `titlePresent` and nodes to
   `nodeCount`, and MUST NOT create a run or archive a node. `--execute` is the
   LAST declared option, and spec/run/node existence is validated BEFORE the
   brake.
6. `workflows runs cancel` MUST stay unbraked: it is the emergency stop for a
   live node run — a still-active node keeps gating the aggregate until it is
   cancelled, so braking the stop action would delay exactly the operation that
   limits damage (anti-safety).
7. `workflows specs list` and `workflows runs list` MUST accept
   `--fields a,b,c` for compact output.
8. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.
9. Without `--json`, error output keeps the legacy text path (exit 1), and the
   `task-create` cleanup invariant is preserved: when attach fails after task
   creation, the task is deleted BEFORE the contract error is raised.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| runs start | instantiates a live run gating coordinated work (high) | dry-run + `--execute` |
| runs archive-node | destructive: no unarchive; archived nodes are excluded from the aggregate and reject every further mutation | dry-run + `--execute` |
| runs cancel | emergency stop of a live node; braking it would be anti-safety | not braked (declared) |
| specs create | additive definition; reversible by superseding | not braked (declared) |
| runs release / skip | explicit human/agent gate actions with narrow preconditions | not braked (declared) |
| runs task-attach / task-create | reversible binding (task can finish/fail; failed nodes accept new attempts) | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| spec not found | `WORKFLOW_SPEC_NOT_FOUND` + suggestions | 1 |
| run not found | `WORKFLOW_RUN_NOT_FOUND` + suggestions | 1 |
| node not found in run | `WORKFLOW_NODE_NOT_FOUND` + suggestions | 1 |
| task not found (task-attach) | `TASK_NOT_FOUND` | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

There is NO shipped `workflows` skill — a registered gap: agents currently
learn this surface only from `docs/workflow-substrate-v0.md` (which documents
`--execute` on both braked ops) and from `projects workflows start`, the braked
project-level wrapper in `cli/projects`. `src/projects/fixtures.ts` only prints
`workflows runs show` hints (read-only). SDK/openapi surfaces call the service
layer, not the CLI brake. Parser-level usage errors use the global exit-2
`USAGE_ERROR` envelope with `acceptedFlags`.

## Validation

- `bun test src/cli/commands/workflows.test.ts` green (contract block
  included), no new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `workflows runs
  start <spec> --json` → exit 3 and no new run listed; with `--execute` → run
  created; `workflows runs archive-node <run> <node> --json` → exit 3 and the
  node still active; `workflows specs show nope --json` →
  `WORKFLOW_SPEC_NOT_FOUND`, exit 1; `workflows runs list --json --fields
  id,status` narrows items.

## Known Failure Modes

- The service throw `Workflow node K not found in run R.` is ambiguous between
  unknown run and unknown node; mapping it without the run pre-check reports
  `WORKFLOW_NODE_NOT_FOUND` for runs that do not exist.
- `archiveWorkflowNodeRun` has no reverse: `assertNodeRunMutable` permanently
  rejects release/skip/cancel/attach on archived nodes — a brake regression
  here is unrecoverable state loss, not an inconvenience.
- `workflows.test.ts` mocks `../context.js`; the mock MUST export `hasContext`
  (returning true) or the contract helpers call `process.exit` in tests.
