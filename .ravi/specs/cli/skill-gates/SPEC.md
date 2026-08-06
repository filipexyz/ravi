---
id: cli/skill-gates
title: "Skill gates agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - skill-gates
tags:
  - cli
  - skill-gates
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/skill-gates.ts
  - src/cli/agent-contract.ts
  - src/cli/skill-gates.ts
  - src/plugins/internal/ravi-system/skills/skill-gates/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Skill gates agent-first CLI contract

## Intent

Make `ravi skill-gates` reliable for agent consumers under the agent-first
contract defined by `cli`: typed error envelopes, the 0/1/2/3 exit
taxonomy, a write brake on destructive rule changes, and compact discovery.
Skill gates decide which skills load automatically at runtime — removing or
resetting a rule silently changes runtime behavior for every session, so `rm`
and `reset` are the braked ops.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. `show`, `disable`, `enable` and `rm` on an unknown rule id MUST exit 1 with
   `GATE_NOT_FOUND` and up to 3 `suggestions` from real rule ids (defaults ∪
   configured; `enable` suggests configured overrides only, since only those
   can be enabled).
4. `skill-gates rm` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and a `plan` carrying the id, the
   pending action (`disable-default` or `delete-custom`) and the current
   configured row when one exists, and MUST NOT write. Not-found validation
   MUST fire BEFORE the brake (exit 1, never 3).
5. `skill-gates reset` MUST brake (exit 3, plan shows the override being
   discarded) whenever a configured override exists; without an override the
   legacy no-op result stands (exit 0, `deleted:false`) because there is
   nothing to discard.
6. `skill-gates list` MUST accept `--fields a,b,c` for compact output.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.
8. Unbraked writes (`set`, `enable`, `disable`) keep immediate-write behavior
   and MUST be declared as unbraked in the shipped `skill-gates` skill.
9. Without `--json`, error output keeps the legacy text path (exit 1).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| rm | destructive (deletes custom / disables default) | dry-run + `--execute` |
| reset | discards configured override | dry-run + `--execute` (only when an override exists) |
| set | upsert, re-settable at will | not braked (declared) |
| enable / disable | reversible pair | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| gate rule / override not found | `GATE_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/skill-gates/SKILL.md` teaches this
surface and MUST carry `--execute` on its `rm`/`reset` examples. The runtime
gate resolver reads `skill_gate_rules` directly (not through the CLI), so the
brake does not affect gate evaluation.

## Validation

- `bun test src/cli/commands/skill-gates.test.ts` green (contract block
  included), no removed tests.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `skill-gates rm
  image --json` → exit 3 + plan, rule still effective; with `--execute` →
  default disabled; `skill-gates show nope --json` → `GATE_NOT_FOUND`, exit 1;
  `skill-gates list --fields id,enabled --json` narrows items.

## Known Failure Modes

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
- `rm` on a DEFAULT id with no configured row is valid (it plans
  `disable-default`); guarding not-found with `!existing` alone would wrongly
  reject default ids — the check must be `!isDefault && !existing`.
- Braking `reset` unconditionally would turn the common "already at default"
  no-op into exit-3 friction; the brake only fires when an override actually
  exists.
