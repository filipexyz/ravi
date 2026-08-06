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
contract defined by `cli`: typed error envelopes, the 0/1/2/3 exit
taxonomy, a write brake on the destructive mutation, and compact discovery.
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
   MUST report `dryRun: true` and the `plan` (id, name, topic, executionType,
   enabled), and MUST NOT delete anything or emit `ravi.triggers.refresh`.
5. `triggers test` MUST stay unbraked (declared): it fires the trigger with
   FAKE event data (`_test: true`), mutates no state (`changedCount: 0`), and
   is the debug tool designed for safely previewing a trigger — braking it
   would remove the escape hatch agents use before enabling real traffic.
6. `triggers list` MUST accept `--fields a,b,c` for compact output (applied to
   both `items` and `triggers`).
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher — the brake exits 3, never a generic `Error: ...` with exit 1.
8. Unbraked writes (`add`, `set`, `enable`, `disable`) keep their current
   immediate-write behavior and MUST be listed as unbraked in the shipped
   `triggers` skill, together with the `test` rationale.
9. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| rm | destructive (subscription + config deleted) | dry-run + `--execute` |
| add / set / enable / disable | reversible config (inverse command exists) | not braked (declared) |
| test | fires with FAKE data; designed debug tool; mutates nothing | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| trigger not found | `TRIGGER_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/triggers/SKILL.md` teaches this
surface and MUST document `--execute` on `triggers rm` and the unbraked `test`
rationale. The docs pages (`docs/cli/overview.mdx`,
`docs/features/overview.mdx`, `docs/guides/triggers.mdx`) teach the same flag.
`AGENTS.md` still lists the bare `ravi triggers rm <id>` form; that root
instruction file is managed separately from this wave. The trigger runner
(`src/triggers/`) subscribes and fires through the service layer, never through
the CLI, so the brake does not affect event-driven firings.

## Validation

- `bun test src/cli/commands/triggers.test.ts` green (contract block included),
  no new failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `triggers show
  <bad-id> --json` → `TRIGGER_NOT_FOUND`, exit 1; `triggers rm <id> --json` →
  exit 3 and the trigger still listed; with `--execute` → deleted; `triggers
  test <id> --json` → fires the fake event without `--execute`; `triggers list
  --json --fields id,name` narrows items.

## Known Failure Modes

- `triggers.test.ts` mocks `../context.js` without spreading the real module;
  the mock MUST export `hasContext` or the contract helpers crash in tests.
- `--execute` MUST stay the LAST `@Option` parameter of `rm`; inserting options
  after it silently shifts positional test call sites.
- The rm brake must sit before the legacy `try { dbDeleteTrigger(...) }` block;
  inside it, the catch-all `fail("Error: ...")` would flatten the
  `ContractError` into exit 1.
