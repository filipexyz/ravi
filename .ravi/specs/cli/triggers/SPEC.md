---
id: cli/triggers
title: "Triggers agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - triggers
tags:
  - cli
  - triggers
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/triggers.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/triggers/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Triggers agent-first CLI contract

## Intent

Make `ravi triggers` reliable for agent consumers under the agent-first
contract defined by `.ravi/specs/cli`: typed error envelopes, the 0/1/2/3 exit
taxonomy, risk-based brakes, and compact discovery.
Only the CLI surface (`src/cli/commands/triggers.ts`) is in scope — the trigger
RUNTIME (`src/triggers/`) is a separate, untouched contract.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy (write brake).
3. Every op that resolves a trigger by id (`show`, `enable`, `disable`, `set`,
   `test`, `rm`) MUST exit 1 with `TRIGGER_NOT_FOUND` and up to 3
   `suggestions` built from trigger ids/names that pass the same REBAC
   visibility filter as `triggers list` (access-denied stays folded into
   not-found, as before).
4. `triggers rm` MUST default to dry-run and require `--execute`; the dry-run
   MUST report `dryRun: true` and the plan `{triggerId, executionType, enabled}`,
   and MUST NOT delete anything or emit `ravi.triggers.refresh`. Trigger names
   and topics MUST NOT appear.
5. `triggers test` MUST default to dry-run and require `--execute`. Although
   its event data is synthetic (`_test: true`) and it does not mutate trigger
   configuration, emitting the event can activate an agent or shell action.
   The dry-run `{triggerId, executionType}` MUST happen before the NATS emission.
6. `triggers list` MUST accept `--fields a,b,c` for compact output (applied to
   both `items` and `triggers`).
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher — the brake exits 3, never a generic `Error: ...` with exit 1.
8. Unbraked writes (`add`, `set`, `enable`, `disable`) keep their current
   immediate-write behavior and MUST be listed as unbraked in the shipped
   `triggers` skill.
9. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| rm | destructive (subscription + config deleted) | dry-run + `--execute` |
| add / set / enable / disable | reversible config (inverse command exists) | not braked (declared) |
| test | emits a synthetic event that can activate an agent or shell | dry-run + `--execute` |

## Official error cases

| case | code | exit |
|---|---|---|
| trigger not found | `TRIGGER_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/triggers/SKILL.md` teaches this
surface and MUST document `--execute` on `triggers rm` and `triggers test`.
The docs pages (`docs/cli/overview.mdx`, `docs/features/overview.mdx`,
`docs/guides/triggers.mdx`) and `AGENTS.md` teach the same flag. The trigger runner
(`src/triggers/`) subscribes and fires through the service layer, never through
the CLI, so the brake does not affect event-driven firings.

## Validation

- `bun test src/cli/commands/triggers.test.ts` green (contract block included),
  no new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `triggers show
  <bad-id> --json` → `TRIGGER_NOT_FOUND`, exit 1; `triggers rm <id> --json` →
  exit 3 and the trigger still listed; with `--execute` → deleted; `triggers
  test <id> --json` → exit 3 without emitting; with `--execute` → emits the
  synthetic event; `triggers list
  --json --fields id,name` narrows items.

## Known Failure Modes

- `triggers.test.ts` mocks `../context.js` without spreading the real module;
  the mock MUST export `hasContext` or the contract helpers crash in tests.
- `--execute` MUST stay the LAST `@Option` parameter of `test` and `rm`; inserting options
  after it silently shifts positional test call sites.
- The rm brake must sit before the legacy `try { dbDeleteTrigger(...) }` block;
  inside it, the catch-all `fail("Error: ...")` would flatten the
  `ContractError` into exit 1.
