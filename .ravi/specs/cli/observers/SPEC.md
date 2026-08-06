---
id: cli/observers
title: "Observers agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - observers
tags:
  - cli
  - observers
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/observers.ts
  - src/cli/agent-contract.ts
  - src/cli/registry.ts
  - src/plugins/internal/ravi-system/skills/observers/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Observers agent-first CLI contract

## Intent

Make `ravi observers` (and its `rules` and `profiles` groups) reliable for agent
consumers under the agent-first contract defined by `cli`: typed error
envelopes, the 0/1/2/3 exit taxonomy, a write brake on the only destructive op,
and compact discovery. Observer rules are durable coordination config — a stray
`rules rm` silently deletes what routes observation to sidecar sessions — so
`rules rm` is the braked op.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. Unknown binding / rule / profile ids MUST exit 1 with `OBSERVER_NOT_FOUND`;
   the message names the resource and `suggestions` carry up to 3 real ids from
   the matching local list (`observers list`, `observers rules list`,
   `observers profiles list`). `rules enable|disable` pre-check the rule id
   because `dbSetObserverRuleEnabled` throws on unknown ids.
4. Unknown session refs (`observers list --session`, `observers refresh`,
   `observers rules explain`) MUST exit 1 with `SESSION_NOT_FOUND` and NO
   suggestions — same rationale as `cli/sessions`: scope isolation masks
   unauthorized sessions as not-found, and suggesting real names would leak
   sessions from other scopes.
5. `observers rules rm` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and the `plan` (rule id, observer agent,
   scope, enabled) and MUST NOT delete anything. `--execute` is the LAST
   declared option of the op, and rule existence is validated BEFORE the brake.
6. `observers list`, `observers rules list` and `observers profiles list` MUST
   accept `--fields a,b,c` for compact output.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.
8. Without `--json`, error output keeps the legacy text path (exit 1).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| rules rm | destructive (only reverse is manual recreation) | dry-run + `--execute` |
| refresh | reconciliation; disables stale bindings without deleting history | not braked (declared) |
| rules set | upsert; reversible by re-setting the same id | not braked (declared) |
| rules enable / disable | reversible pair | not braked (declared) |
| profiles init | scaffold; refuses overwrite unless `--overwrite` | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| binding / rule / profile not found | `OBSERVER_NOT_FOUND` + suggestions | 1 |
| session not found | `SESSION_NOT_FOUND` (no suggestions) | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/observers/SKILL.md` teaches this
surface and MUST document `--execute` on `rules rm` and list the unbraked
writes explicitly. No other non-test consumer invokes `observers rules rm`.
Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
`acceptedFlags`.

## Validation

- `bun test src/cli/commands/observers.test.ts` green (contract block
  included), no new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `observers rules rm
  <id> --json` → exit 3 and the rule still listed; with `--execute` → deleted;
  `observers rules show <bad-id> --json` → `OBSERVER_NOT_FOUND`, exit 1;
  `observers refresh <ghost> --json` → `SESSION_NOT_FOUND`, exit 1;
  `observers rules list --json --fields id,enabled` narrows items.

## Known Failure Modes

- `dbSetObserverRuleEnabled` throws on unknown ids; without the pre-check the
  not-found path regresses to a generic error instead of the envelope.
- `previewObserverProfile` throws `Unknown observer profile: X. ...` from the
  resolver; only that prefix is mapped to `OBSERVER_NOT_FOUND` — other preview
  errors stay on the legacy path.
- `observers.test.ts` mocks `../context.js`; the mock MUST export `hasContext`
  (returning true) or the contract helpers call `process.exit` in tests.
