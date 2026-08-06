---
id: cli/hooks
title: "Hooks agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - hooks
tags:
  - cli
  - hooks
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/hooks.ts
  - src/cli/commands/hooks.test.ts
  - src/cli/agent-contract.ts
  - src/hooks-runtime
owners:
  - ravi-dev
status: active
normative: true
---
# Hooks agent-first CLI contract

## Intent

Make `ravi hooks` reliable for agent consumers under the agent-first contract
defined by `cli/crm`: typed error envelopes, the 0/1/2/3 exit taxonomy, a write
brake on the only destructive op (`rm`), and compact discovery. Hooks are
durable runtime automations (event → action), so deleting one silently removes
behavior the daemon depends on — that is the op that gets the brake.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. `hooks show`, `hooks enable`, `hooks disable`, `hooks rm` and `hooks test`
   on an unknown id MUST exit 1 with `HOOK_NOT_FOUND` and up to 3
   `suggestions` from live hook ids/names.
4. `hooks rm` MUST default to dry-run and require `--execute`; the dry-run MUST
   report `dryRun: true` and the `plan` (hook id, name, event, scope, action),
   and MUST NOT delete the hook nor emit a hook refresh.
5. `hooks list` MUST accept `--fields a,b,c` for compact output.
6. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.
7. Unbraked writes (`create`, `enable`, `disable`) keep their current
   immediate-write behavior (declared): `create` has an obvious inverse (`rm`)
   and `enable`/`disable` are a reversible pair.
8. Without `--json`, error output keeps the legacy text path (exit 1), except
   usage errors which exit 2 and teach the correct syntax inline.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| rm | destructive (config + fire counters deleted) | dry-run + `--execute` |
| create | reversible entry point (`rm` undoes it) | not braked (declared) |
| enable / disable | reversible pair | not braked (declared) |
| test | executes the hook once with a synthetic event (declared read/debug) | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| hook not found | `HOOK_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

The `hooks list` human output teaches `ravi hooks rm <id> --execute`. There is
no shipped `hooks` skill teaching this surface — registered as a gap for a
future wave; until then this spec and the list output are the teaching
surfaces.

## Validation

- `bun test src/cli/commands/hooks.test.ts` green (contract block included).
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): `hooks show
  <bad-id> --json` → `HOOK_NOT_FOUND`, exit 1; `hooks list --no-such-flag
  --json` → `USAGE_ERROR`, exit 2; `hooks rm <id> --json` → exit 3 and the
  hook still listed; with `--execute` → deleted and refresh emitted; `hooks
  list --json --fields id,name,enabled` narrows items.

## Known Failure Modes

- `hooks.test.ts` mocks `../context.js` by spreading the real module; the mock
  MUST still override `hasContext: () => true` or the contract helpers call
  `process.exit` inside tests.
- `runHookById` throws a plain `Error` on unknown ids; the CLI resolves the
  hook first (`requireHook`) so `hooks test` returns the envelope instead of
  an unhandled throw.
