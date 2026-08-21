---
id: cli/projects
title: "Projects agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - projects
tags:
  - cli
  - projects
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/projects.ts
  - src/projects/read-facade.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/projects/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---

## Intent

Make `ravi projects` (and its `workflows`, `tasks`, `resources`, `fixtures`
groups) reliable for agent consumers under the agent-first contract defined by
`cli`: typed error envelopes, the 0/1/2/3 exit taxonomy, a write brake on
the riskiest mutations, and compact discovery. Projects are the
alignment/context substrate, but two of its ops launch real execution
(`workflows start`, `tasks dispatch` — the direct analog of `tasks dispatch`),
one resets state (`fixtures seed`); those three carry the brake. `resources
import` only creates normalized local resource links and runs immediately.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. `projects show|status` on an unknown ref MUST exit 1 with
   `PROJECT_NOT_FOUND` and up to 3 `suggestions` from live project
   slugs/titles. Service-layer throws (`Project not found: X` from
   `update`, `link`, `workflows attach`, `tasks create|attach|dispatch`,
   `resources add|list|import`) MUST map to the same envelope.
4. Per-resource not-found envelopes: `WORKFLOW_RUN_NOT_FOUND` (service throws
   `Workflow run not found: X`), `WORKFLOW_NODE_NOT_FOUND` (with node-key
   suggestions from the linked run), `TASK_NOT_FOUND` (no suggestions from this
   surface — point to `ravi tasks list`), and `RESOURCE_NOT_FOUND` on
   `resources show` (suggestions from the project's real resource
   ids/labels/locators).
5. `projects tasks dispatch`, `projects workflows start`, and
   `projects fixtures seed` MUST default to dry-run and require `--execute`;
   the dry-run MUST report `dryRun: true` and the `plan`, and MUST NOT dispatch,
   start, or seed anything. `projects resources import` MUST validate the
   project and locators, then create its local links immediately without
   `--execute` while remaining `kind: "mutate"`. Workflow/task plans retain
   only their allowed identifiers. Fixture seed uses
   `{ownerAgentId,resetsCanonicalFixtures:true}` instead of free-form effect
   text.
6. `projects list`, `projects next` and `projects resources list` MUST accept
   `--fields a,b,c` for compact output.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher —
   the brake exits 3, never a generic `Error: ...` with exit 1.
8. Unbraked writes (`init`, `create`, `update`, `link`, `workflows attach`,
   `tasks create`, `tasks attach`, `resources add`, `resources import`) keep their current
   immediate-write behavior and MUST be listed as unbraked in the shipped
   `projects` skill.
9. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2 and teach the correct syntax inline.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| tasks dispatch | triggers real agent execution (high) | dry-run + `--execute` |
| workflows start | starts a real coordinated workflow run (high) | dry-run + `--execute` |
| fixtures seed | resets + reseeds canonical fixtures (destructive) | dry-run + `--execute` |
| resources import | batch of normalized local links | not braked |
| init / create / update / link | reversible substrate writes | not braked (declared) |
| workflows attach / tasks create / tasks attach | reversible links (attach without `--dispatch` plans only) | not braked (declared) |
| resources add | single reversible link | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| project not found | `PROJECT_NOT_FOUND` + suggestions | 1 |
| workflow run not found | `WORKFLOW_RUN_NOT_FOUND` | 1 |
| workflow node not found | `WORKFLOW_NODE_NOT_FOUND` + suggestions | 1 |
| task not found (via projects surface) | `TASK_NOT_FOUND` | 1 |
| resource link not found | `RESOURCE_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Suggestion sources

`listProjects` applies no visibility/scope filter — it is the exact source
`projects list` prints — so `PROJECT_NOT_FOUND` suggestions come from real
slugs/titles with no cloaking to preserve. `RESOURCE_NOT_FOUND` suggestions come
from `listProjectResourceLinks` on the same project. `WORKFLOW_NODE_NOT_FOUND`
suggestions come from `getWorkflowRunDetails(runId).nodes`.

## Internal consumers

`src/plugins/internal/ravi-system/skills/projects/SKILL.md` teaches this surface
and MUST document `--execute` on every braked op (`workflows start`,
`tasks dispatch`, and `fixtures seed`) while teaching `resources import`
without the flag. `src/projects/fixtures.ts` proofCommands are read-only
(`projects status|show`, `tasks show`) and are not affected by the brake.
Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
`acceptedFlags`.

## Validation

- `bun test src/cli/commands/projects.test.ts` green (contract block included),
  no new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated state dir): `projects show nope --json`
  → `PROJECT_NOT_FOUND`, exit 1; `projects tasks dispatch <slug> <task> --json`
  → exit 3 and no dispatch; with `--execute` → dispatched;
  `projects fixtures seed --json` → exit 3 and nothing reseeded;
  `projects list --json --fields slug,status` narrows items.

## Known Failure Modes

- Every projects command wraps its body in a legacy `try/catch` that used to
  flatten errors through `fail()`; a catch that does not rethrow
  `ContractError` converts the brake's exit 3 into a generic exit 1
  (`rethrowProjectCommandError` rethrows first).
- `getProjectDetails` returns `null`, but the service layer throws
  `Project not found: X` — both paths MUST map to `PROJECT_NOT_FOUND`.
- `projects.test.ts` mocks `../context.js`; the mock MUST export `hasContext`
  (→ true) or the contract helpers process.exit inside bun tests.

## Read-only facade amendment

The six read operations (`list`, `next`, `show`, `status`, `resources list`,
`resources show`) MUST use `ProjectsReadFacade`; they MUST NOT invoke the
schema-initializing project, workflow, task, tag, or router stores.

The facade opens the existing SQLite database with `readonly: true` and
`create: false`, holds one explicit read transaction across every query,
finalizes every prepared query, and closes the database after one coherent
snapshot. The durable database and WAL MUST remain byte-identical; SQLite's
ephemeral `-shm` coordination is not durable state.

Project references match exact id or exact slug. If one value identifies two
rows, the facade MUST return `AMBIGUOUS_PROJECT_REF` and MUST NOT choose a row.
Resource id, asset id, locator, and case-insensitive label follow the same rule
with `AMBIGUOUS_RESOURCE_REF`.

`projects next` MUST default to a bounded page of 20 entries and expose
pagination. `--limit`, `--offset`, and `--fields` MUST compose without changing
the rank order. A read command declares `audit: none`; it MUST NOT require NATS
or emit an audit event after reading.

The compact projections have a fixed public field set per operation. An empty
or unknown field in `--fields`, including one mixed with valid fields, MUST fail
before success output with `USAGE_ERROR`, exit 2, and `acceptedFields`. This
usage mapping MUST NOT replace the domain-specific validation errors for
status, tag, or resource type.

Invalid status, tag, and resource-type filters MUST return typed public causes.
An incompatible read schema MUST fail closed with
`PROJECTS_READ_SCHEMA_UNSUPPORTED`; the reader MUST NOT migrate it.

## Compact projection correction

Supplying `--fields` creates a strict field list. Empty input, comma-only input,
a leading or trailing comma, or any empty token between valid fields MUST fail
with `USAGE_ERROR`, exit 2, and the operation's `acceptedFields`; normalization
MUST NOT erase malformed tokens.

A compact result MUST expose every requested field. If a requested field is
optional in the full entity and absent for one item, that item MUST contain the
field with JSON `null`; it MUST NOT serialize as `{}` or be removed from the
page. In the compact schema, that selected field is required and nullable.
Required source fields remain non-null, and full entity and mutation contracts
remain unchanged.
