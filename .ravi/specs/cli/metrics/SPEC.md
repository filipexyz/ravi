---
id: cli/metrics
title: "Metrics agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - metrics
tags:
  - cli
  - metrics
  - agent-first
  - error-envelope
  - exit-taxonomy
applies_to:
  - src/cli/commands/metrics.ts
  - src/cli/agent-contract.ts
  - src/metrics/rollup.ts
  - src/ephemeral/runner.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Metrics agent-first CLI contract

## Intent

Make `ravi metrics` reliable for agent consumers under the agent-first
contract defined by `cli/crm`. Metrics is a reporting domain over
`daily_metrics` roll-ups; its value for agents is cheap reads (`--fields` on
the row report) and a clean usage taxonomy. No op is braked: the only write,
`rollup`, produces derived, idempotent, fully recomputable rows.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, acceptedValues?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error · `2` usage
   error · `3` blocked by policy.
3. `metrics show --by <dim>` MUST accept only `agent|agent-model|date`; any
   other value MUST exit 2 with `USAGE_ERROR` and `acceptedValues`, before
   querying `daily_metrics`.
4. `metrics show` MUST accept `--fields a,b,c` and project the row array in
   `--json` (and in the returned tool payload); the text table stays
   unprojected. `metrics dates` returns an array of scalar date strings, so
   `--fields` does not apply there — declared.
5. `metrics rollup` MUST stay unbraked (no `--execute`): it writes ONLY
   derived `daily_metrics` rows, idempotent per day and recomputable from
   `cost_events`/`session_events`. The daemon calls `rollupDailyMetrics()`
   directly (`src/ephemeral/runner.ts`), so a CLI brake would not gate the
   write anyway.
6. No op resolves an entity by id: `--agent` on `show` is a filter and an
   empty window is a legitimate empty result, so no `*_NOT_FOUND` envelope
   applies — declared.
7. Numeric flags (`--days`) keep their lenient legacy normalization —
   declared, not a usage error. Date flags pass through to the rollup layer
   unchanged.
8. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| show / dates | pure reads | none |
| rollup | derived-data upsert, idempotent, recomputable; daemon-owned in practice | not braked (declared) |

`rollup` is declared `kind: "read"` in `CommandAccess` although it upserts
derived rows — registered here as MISDECLARED and deliberately NOT flipped in
this wave to avoid changing the permission surface.

## Official error cases

| case | code | exit |
|---|---|---|
| invalid `--by` dimension | `USAGE_ERROR` + acceptedValues | 2 |

## Internal consumers

No repo doc or shipped skill teaches `ravi metrics` today (gap registered by
the CLI migration); the domain has no SKILL.md and none is created in this
wave. The daemon consumer (`src/ephemeral/runner.ts`) uses the service layer,
not the CLI. The `metrics show` empty-state hint ("Run `ravi metrics rollup`
first.") stays valid because rollup is unbraked. Parser-level usage errors
(unknown flag → exit 2 envelope) require adding `metrics` to
`AGENT_CONTRACT_DOMAINS` in `src/cli/index.ts` — owned by the integrator wave,
registered here as PENDING.

## Validation

- `bun test src/cli/commands/metrics.test.ts` green (contract block included).
- Live checks (read-only): `ravi metrics show --by bogus --json` → exit 2 +
  `acceptedValues`; `ravi metrics show --json --fields agentId,totalCostUsd`
  narrows rows; `ravi metrics dates --json` returns the scalar date list.

## Known Failure Modes

- Before this wave, an invalid `--by` silently coerced to `agent-model` — the
  report answered a different question than the one asked. The usage error
  exists to make that visible; removing it regresses to silent coercion.
- Braking `rollup` would break the daemon-parity expectation and the
  empty-state hint in `show`, while protecting nothing (the write is derived
  and idempotent).
- `metrics.test.ts` mocks `../context.js`; the mock MUST export `hasContext`
  (true) or the contract helpers call `process.exit` inside tests.
