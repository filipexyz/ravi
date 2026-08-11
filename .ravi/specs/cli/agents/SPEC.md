---
id: cli/agents
title: "Agents agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - agents
tags:
  - cli
  - agents
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/agents.ts
  - src/cli/agent-contract.ts
  - src/cli/registry.ts
  - src/plugins/internal/ravi-system/skills/agents/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Agents agent-first CLI contract

## Intent

Make `ravi agents` reliable for agent consumers under the agent-first contract
defined by `cli`: typed error envelopes, the 0/1/2/3 exit taxonomy, a write
brake on the riskiest mutations, and compact discovery. Agents are runtime
identities: `delete` removes one permanently, `reset` discards irrecoverable
session context, and `permissions` rewrites the agent's runtime authority — so
those three carry the brake.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. Every op that resolves an agent id (`show`, `sync-instructions`, `delete`,
   `set`, `permissions`, `debounce`, `spec-mode`, `session`, `reset`, `debug`)
   MUST exit 1 with `AGENT_NOT_FOUND` and up to 3 `suggestions` built from the
   same visibility filter as `agents list` (ids and names), so scope isolation
   is preserved while agent ids stay discoverable.
4. `agents delete`, `agents reset` (including `reset <id> all`) and
   `agents permissions` when the requested delta expands authority MUST
   default to dry-run and require `--execute`; the dry-run MUST report
   `dryRun: true` and the `plan`, and MUST NOT delete, abort, reset or write
   anything. `--execute` is always the LAST declared parameter of each braked
   op. Plan formats are minimal: delete uses
   `{agentId,cwdPresent,namePresent}`; reset-all uses `{agentId,target,count}`;
   one-session reset uses `{agentId,target,sessionKey}`; permission expansion
   uses the before/after presence, profile identifiers, and capability counts.
   Paths, display names, session names, and capability entries MUST NOT appear.
5. The read-only form, no-op changes and authority reductions (including
   `none` and `--clear-capabilities`) MUST execute without the brake.
6. `agents list` MUST accept `--fields a,b,c` for compact output.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher —
   the brake exits 3, never a generic `Error: ...` with exit 1.
8. Unbraked writes (`create`, `set`, `sync-instructions`, `debounce`,
   `spec-mode`) keep their current immediate-write behavior and MUST be listed
   as unbraked in the shipped `agents` skill.
9. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2 and teach the correct syntax inline.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| delete | destructive (agent removal) | dry-run + `--execute` |
| reset / reset all | discards irrecoverable session context | dry-run + `--execute` |
| permissions (authority expansion) | high risk (adds runtime authority) | dry-run + `--execute` |
| permissions (reduction / no-op) | containment or no added authority | not braked |
| permissions (read-only, no profile args) | read | not braked (exit 0) |
| create / set / sync-instructions | reversible config | not braked (declared) |
| debounce / spec-mode | reversible toggles | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| agent not found | `AGENT_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/agents/SKILL.md` teaches this surface
and MUST document `--execute` on every braked op (its delete, reset and
permissions examples carry the flag). The `architect` skill teaches
`agents delete` in its inverse recipe and carries `--execute`;
`docs/cli/overview.mdx` carries `--execute` on the delete/reset lines. The
permission hint strings emitted by `agents create`, `agents show` and the
read-only `agents permissions` output (`leastPrivilegeExample`,
`breakGlassCommand`) MUST include `--execute` when they teach expansion;
`Clear:` and the read-only `permissionsCommand` stay without it.

## Validation

- `bun test src/cli/commands/agents.test.ts` green (contract block included), no
  new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `agents show
  <bad-id> --json` → `AGENT_NOT_FOUND`, exit 1; `agents list --no-such-flag
  --json` → `USAGE_ERROR`, exit 2; `agents delete <id> --json` → exit 3 and the
  agent still listed; with `--execute` → deleted; `agents reset <id> all --json`
  → exit 3 and sessions untouched; `agents permissions <id> --json` → exit 0
  unbraked; `agents list --json --fields id,cwd` narrows items; brake verified
  with `RAVI_AGENT_ID` set (agent-context env) still exits 3 with the envelope.

## Known Failure Modes

- `agents delete` used to wrap the whole flow in one try/catch that flattened
  every error into `fail("Error: ...")`; placing `contractDryRun` or
  `failAgentNotFound` inside that block would swallow the `ContractError` and
  regress exit 3/1 to a generic exit 1. Resolution and the brake MUST stay
  outside the service-call try/catch.
- `agents.test.ts` mocks `../context.js` spreading the real module, so the real
  `hasContext` (env-based, false under bun test) leaks through; the mock MUST
  override `hasContext: () => true` or the contract helpers call
  `process.exit` and kill the test run.
- `reset` has three outcomes (all / one session / session not found); braking
  only the `all` branch leaves single-session resets writing without
  `--execute`. Both write paths carry the brake; the session-not-found path
  performs no write and stays exit 0 with hints.
