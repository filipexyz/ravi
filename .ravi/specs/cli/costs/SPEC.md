---
id: cli/costs
title: "Costs agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - costs
tags:
  - cli
  - costs
  - agent-first
  - error-envelope
  - exit-taxonomy
applies_to:
  - src/cli/commands/costs.ts
  - src/cli/agent-contract.ts
  - src/costs/pricing-catalog.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Costs agent-first CLI contract

## Intent

Make `ravi costs` reliable for agent consumers under the agent-first contract
defined by `cli`: typed error envelopes, the 0/1/2/3 exit taxonomy and
compact discovery. Costs is a read domain — its value for agents is CHEAP
reads: `--fields` on every array payload so a budget check does not cost more
tokens than the tokens it audits. The single mutating path
(`pricing --recompute`) keeps its pre-existing `--dry-run` preview flag as the
documented equivalent of the write brake.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedValues?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy.
3. `costs agent <id>` MUST exit 1 with `AGENT_NOT_FOUND` and up to 3
   `suggestions` from local agent ids/names ONLY when the id resolves to
   nothing locally: no router config entry AND no cost event ever (all-time).
   A deleted agent that still has cost history keeps returning its numbers.
4. `costs session <nameOrKey>` MUST exit 1 with `SESSION_NOT_FOUND` and
   suggestions from local session names/keys ONLY when the input neither
   resolves via `resolveSession` NOR has any cost history under the raw key.
   The raw-key fallback for pruned sessions with history is preserved.
5. `costs agents`, `costs top-sessions` and `costs pricing` MUST accept
   `--fields a,b,c` and project their array payloads (`agents`, `sessions`,
   `rows`) in `--json`; text tables stay unprojected. `costs summary` and
   `costs agent|session` return object payloads — no `--fields` (declared).
6. `costs pricing --recompute --dry-run` MUST report the recompute preview
   (`dryRun: true`, `updated: 0`, per-row results) and MUST NOT call
   `dbUpdateCostEventPricing`. `--dry-run` is the documented brake-equivalent
   and MUST NOT be renamed to `--execute`.
7. Numeric flags (`--hours`, `--limit`) keep their lenient legacy
   normalization (invalid values fall back to defaults) — declared, not a
   usage error.
8. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| summary / agents / top-sessions / agent / session | pure reads | none |
| pricing (without --recompute) | pure read | none |
| pricing --recompute | rewrites derived pricing metadata on cost_events (recomputable) | pre-existing `--dry-run` documented as equivalent; not renamed |

`pricing` is declared `kind: "read"` in `CommandAccess` although the
`--recompute` path mutates — registered here as MISDECLARED and deliberately
NOT flipped in this wave to avoid changing the permission surface.

## Official error cases

| case | code | exit |
|---|---|---|
| agent id with no config entry and no cost history | `AGENT_NOT_FOUND` + suggestions | 1 |
| session input with no record and no cost history | `SESSION_NOT_FOUND` + suggestions | 1 |

## Internal consumers

No repo doc or shipped skill teaches `ravi costs` today (gap registered by the
CLI migration); the domain has no SKILL.md and none is created in this wave.
Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
`costs` is registered in `AGENT_CONTRACT_DOMAINS`.

## Validation

- `bun test src/cli/commands/costs.test.ts` green (contract block included).
- Live checks (read-only): `ravi costs agent ghost-xyz --json` → exit 1 +
  `AGENT_NOT_FOUND` + suggestions; `ravi costs agents --json --fields
  agentId,total_cost` narrows items; `ravi costs pricing --recompute --dry-run
  --json` → `recompute.updated: 0` and unchanged `pricing_status` on re-read.

## Known Failure Modes

- Checking only the window summary for existence would flag any quiet agent as
  not-found: the all-time query (`sinceMs: 0`) is what separates "quiet" from
  "nonexistent".
- Mapping `resolveSession` null directly to not-found would break the
  legacy raw-key fallback used to audit pruned sessions that still have cost
  events.
- `costs.test.ts` mocks `../context.js` without spreading the real module; the
  mock MUST export `hasContext` or the contract helpers crash in tests.
