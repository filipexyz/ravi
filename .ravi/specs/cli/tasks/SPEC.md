---
id: cli/tasks
title: "Tasks agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - tasks
tags:
  - cli
  - tasks
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/tasks.ts
  - src/cli/commands/tasks-deps.ts
  - src/cli/commands/tasks-automations.ts
  - src/cli/commands/tasks-profiles.ts
  - src/cli/agent-contract.ts
  - src/cli/registry.ts
  - src/plugins/internal/ravi-system/skills/tasks/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Tasks agent-first CLI contract

## Intent

Make `ravi tasks` (and its `deps`, `automations`, `profiles` groups) reliable for
agent consumers under the agent-first contract defined by `cli/crm`: typed error
envelopes, the 0/1/2/3 exit taxonomy, a write brake on the riskiest mutations,
and compact discovery. Tasks are the core work-dispatch surface for agents, so
`dispatch` — which triggers real agent execution — is the primary braked op.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. `tasks show` and `tasks dispatch` on an unknown id MUST exit 1 with
   `TASK_NOT_FOUND` and up to 3 `suggestions` from live task ids/titles — even
   though the underlying `getTaskDetails` throws on unknown ids.
4. `tasks dispatch`, `tasks deps rm` and `tasks automations rm` MUST default to
   dry-run and require `--execute`; the dry-run MUST report `dryRun: true` and
   the `plan`, and MUST NOT dispatch, remove or delete anything.
5. `tasks list` MUST accept `--fields a,b,c` for compact output.
6. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher —
   the brake exits 3, never a generic `Error: ...` with exit 1.
7. Unbraked writes (`create`, `done`, `block`, `fail`, `comment`, `archive`,
   `unarchive`, `report`, `deps add`, `automations add|enable|disable`,
   `profiles init`) keep their current immediate-write behavior and MUST be
   listed as unbraked in the shipped `tasks` skill.
8. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2 and teach the correct syntax inline.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| dispatch | triggers real agent execution (high) | dry-run + `--execute` |
| deps rm | destructive (gating removal) | dry-run + `--execute` |
| automations rm | destructive (config deletion) | dry-run + `--execute` |
| create / done / block / fail / comment / report | reversible state transitions | not braked (declared) |
| archive / unarchive | reversible pair | not braked (declared) |
| deps add / automations add-enable-disable / profiles init | reversible config | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| task not found | `TASK_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/tasks/SKILL.md` teaches this surface and
MUST document `--execute` on every braked op (its dispatch example carries the
flag). The deprecated `tasks-manager` skill only points to `tasks` and teaches no
syntax. Daemon-side task automation dispatches follow-ups through the service
layer (`queueOrDispatchTask`), not through the CLI, so the brake does not affect
automation-driven dispatches.

## Validation

- `bun test src/cli/commands/tasks.test.ts` green (contract block included), no
  new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `tasks show <bad-id>
  --json` → `TASK_NOT_FOUND`, exit 1; `tasks list --no-such-flag --json` →
  `USAGE_ERROR`, exit 2; `tasks automations rm <id> --json` → exit 3 and the
  automation still listed; with `--execute` → deleted; `tasks list --json
  --fields id,title` narrows items; brake verified with `RAVI_AGENT_ID` set
  (agent-context env) still exits 3 with the envelope.

## Known Failure Modes

- `getTaskDetails` throws on unknown ids; mapping only `details.task === null`
  misses the real not-found path and regresses to plain text + exit 1
  (`getTaskDetailsForContract` covers both).
- Before the registry dispatcher learned `ContractError` exit codes, any braked
  op invoked with `RAVI_*` envs present printed `Error: ...` and exited 1,
  silently defeating the brake taxonomy for agent callers.
- `tasks.test.ts` mocks `../context.js` without spreading the real module; the
  mock MUST export `hasContext` or the contract helpers crash in tests.
