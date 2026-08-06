---
id: cli/settings
title: "Settings agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - settings
tags:
  - cli
  - settings
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/settings.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/settings/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Settings agent-first CLI contract

## Intent

Make `ravi settings` reliable for agent consumers under the agent-first
contract defined by `cli/crm`: typed error envelopes, the 0/1/2/3 exit
taxonomy, a write brake on the destructive op, and compact discovery. Settings
are global daemon configuration; `delete` erases a live config row and is the
single braked op of the domain.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy (write brake).
3. `settings get` on a key that is neither known, nor set, nor a legacy
   `account.*` row MUST exit 1 with `SETTING_NOT_FOUND` and up to 3
   `suggestions` drawn from known setting keys plus keys actually set.
   Known-but-unset keys and legacy keys keep their informational read (exit 0).
4. `settings delete` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and a `plan` carrying `key`,
   `currentValue`, `legacy` and `known`, and MUST NOT delete anything nor emit
   `ravi.config.changed`.
5. `settings delete` of a key that is not set MUST exit 1 with
   `SETTING_NOT_FOUND` — validation fires BEFORE the brake, never exit 3.
6. `settings list` MUST accept `--fields a,b,c` for compact output of `items`.
7. `settings set` keeps immediate-write behavior (unbraked, declared): it is
   the reversible inverse documented across AGENTS.md and docs, and legacy
   `account.*` writes stay rejected.
8. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.
9. Without `--json`, error output keeps the legacy text path (exit 1).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| delete | destructive (erases live global config) | dry-run + `--execute` |
| set | reversible write (re-set or delete restores) | not braked (declared) |
| list / get | reads | n/a |

## Official error cases

| case | code | exit |
|---|---|---|
| setting not found | `SETTING_NOT_FOUND` + suggestions | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/settings/SKILL.md` (name:
`settings-manager`) teaches this surface and MUST carry `--execute` on the
delete example. `docs/cli/overview.mdx` and `docs/start/configuration.mdx`
mirror the same command list. AGENTS.md teaches only `ravi settings set ...`
(unbraked) and needs no change.

## Validation

- `bun test src/cli/commands/settings.test.ts` green (contract block included).
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`):
  `settings get bogusKey --json` → `SETTING_NOT_FOUND`, exit 1;
  `settings delete <set-key> --json` → exit 3 + plan, key still set;
  with `--execute` → deleted and `ravi.config.changed` emitted;
  `settings list --fields key,value --json` narrows items.

## Known Failure Modes

- `settings.test.ts` mocks `../context.js` by spreading the real module; the
  mock MUST override `hasContext` to return true or the contract helpers call
  `process.exit` inside tests.
- `delete` used to exit 0 with `status: "not_found"` for unknown keys; agents
  that relied on that soft path must read the envelope now (exit 1).
