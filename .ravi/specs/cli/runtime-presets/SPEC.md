---
id: cli/runtime-presets
title: "Runtime presets agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - runtime-presets
tags:
  - cli
  - runtime-presets
  - agent-first
  - error-envelope
  - exit-taxonomy
applies_to:
  - src/cli/commands/runtime-presets.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Runtime presets agent-first CLI contract

## Intent

Make `ravi runtime presets` reliable for agent consumers under the agent-first
contract defined by `cli/crm`: typed error envelopes, the 0/1/2/3 exit
taxonomy and compact discovery. This domain predates the wave with its own
write-preview convention — opt-in `--dry-run` on `set`, `enable`, `disable`
and `delete` — plus a store-level integrity guard that blocks `disable` and
`delete` while any agent references the preset. That local pattern is KEPT and
documented as the equivalent; flags are not renamed and `delete` is not
converted to the `--execute` brake (minimal change, local pattern wins).

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   guard) · `2` usage error · `3` blocked by policy.
3. `show`, `set`, `impact`, `enable`, `disable` and `delete` on an unknown
   preset MUST exit 1 with `PRESET_NOT_FOUND` and up to 3 `suggestions` built
   from live preset ids — even though the store raises
   `RuntimeModelPresetError` for the same case.
4. The pre-existing `--dry-run` flags on `set`, `enable`, `disable` and
   `delete` MUST keep their names and semantics (opt-in preview, exit 0,
   `dryRun: true` in the payload, no persistence, no version bump).
5. The store-level reference guard MUST keep blocking `disable`/`delete` of a
   referenced preset (exit 1 with the store's `nextCommand` hint pointing at
   `impact`); this is the domain's own irreversibility protection.
6. `runtime presets list` MUST accept `--fields a,b,c` for compact JSON
   output; human output stays complete.
7. Non-not-found `RuntimeModelPresetError` guards (referenced preset, invalid
   id/model, immutable provider) keep the legacy text path with the store's
   `nextCommand` hint.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| create | reversible while unreferenced (reverse path: delete) | not braked (declared; no `--dry-run` either) |
| set (model) | versioned, reversible rotation | pre-existing opt-in `--dry-run` (documented equivalent) |
| enable / disable | reversible pair; disable guarded when referenced | pre-existing opt-in `--dry-run` + reference guard (documented equivalent) |
| delete | destructive, but hard-blocked while referenced | pre-existing opt-in `--dry-run` + reference guard (documented local pattern, NOT converted to `--execute`) |

## Official error cases

| case | code | exit |
|---|---|---|
| preset not found (show / set / impact / enable / disable / delete) | `PRESET_NOT_FOUND` + id suggestions | 1 |
| referenced preset on disable/delete | legacy text + `nextCommand` hint | 1 |
| invalid flag/arg (once the domain is registered in the usage-contract list) | `USAGE_ERROR` + acceptedFlags | 2 |

## Internal consumers

`.ravi/specs/runtime/model-presets/` (RUNBOOK and CHECKS) already teach the
`--dry-run` flow for rotation and deletion; keeping the flag names preserves
those runbooks verbatim. Agents reference presets via `agents set <id>
modelPresetId`, resolved through the store — not through this CLI — so the
contract changes affect operator/agent CLI calls only.

## Validation

- `bun test src/cli/commands/runtime-presets.test.ts` green (contract block
  included), no new failures vs the `dev` baseline.
- Live checks (isolated `RAVI_STATE_DIR`): `runtime presets show nope --json`
  → `PRESET_NOT_FOUND`, exit 1, id suggestions; `runtime presets delete <id>
  --dry-run --json` → `dryRun: true` and the preset still listed; `runtime
  presets list --json --fields id,enabled` narrows items.

## Known Failure Modes

- Parser-level usage errors still follow commander's default path until
  `runtime` is added to `AGENT_CONTRACT_DOMAINS` in `src/cli/index.ts` (file
  owned by the shared-contract wave, not this domain migration).
- The not-found mapping matches `^Model preset not found: ` exactly; the
  store's internal `not found after write` error is a consistency failure and
  must stay on the legacy error path, not become `PRESET_NOT_FOUND`.
- `runtime-presets.test.ts` mocks `../context.js`; the mock MUST export
  `hasContext` returning true or the contract helpers call `process.exit` in
  tests.
