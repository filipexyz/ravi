---
id: cli/insights
title: "Insights agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - insights
tags:
  - cli
  - insights
  - agent-first
  - error-envelope
  - exit-taxonomy
applies_to:
  - src/cli/commands/insights.ts
  - src/cli/agent-contract.ts
  - src/insights/index.ts
  - src/insights/types.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Insights agent-first CLI contract

## Intent

Make `ravi insights` reliable for agent consumers under the agent-first
contract defined by `cli/crm`: typed error envelopes, the 0/1/2/3 exit
taxonomy and compact discovery. Insights is the "record what I learned"
surface — `create` writes only local, reversible rows, so the domain declares
NO braked op; the contract value is cheap reads (`--fields` on `list` and
`search`), a real not-found on `show`, and enum validation that exits 2
instead of a generic failure.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedValues?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy.
3. `insights show <id>` on an unknown id MUST exit 1 with `INSIGHT_NOT_FOUND`
   and up to 3 `suggestions` from real local insight ids.
4. Invalid `--kind`, `--confidence`, `--importance` (on `create` and `list`),
   invalid `--link-type` / missing `--link-id` (on `create`) and invalid
   `--limit` (on `list` and `search`) MUST exit 2 with `USAGE_ERROR`; enum
   failures carry `acceptedValues`. A usage failure on `create` MUST write
   nothing.
5. `insights list` (non-rich) and `insights search` MUST accept
   `--fields a,b,c` and project their array payloads (`items`/`insights`);
   text tables stay unprojected. Under `--rich`, `list` returns the overlay
   projection and `--fields` is ignored — declared in the flag description.
6. `insights create` MUST stay unbraked (no `--execute`): it writes ONLY
   local reversible rows (insight + optional comment + tag bindings in the
   local SQLite); nothing leaves the machine.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| list / show / search | pure reads | none |
| create | local reversible insert (insight, comment, tag bindings) | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| insight id not found | `INSIGHT_NOT_FOUND` + suggestions | 1 |
| invalid kind/confidence/importance/link-type/limit | `USAGE_ERROR` (+ acceptedValues on enums) | 2 |

## Internal consumers

No repo doc or shipped skill teaches `ravi insights` today (gap registered by
the CLI migration); the domain has no SKILL.md and none is created in this
wave. `src/whatsapp-overlay/insights.ts` consumes the store through
`buildOverlayInsightsPayload` (the `--rich` path), not through the CLI
contract. Parser-level usage errors (unknown flag → exit 2 envelope) require
adding `insights` to `AGENT_CONTRACT_DOMAINS` in `src/cli/index.ts` — owned by
the integrator wave, registered here as PENDING.

## Validation

- `bun test src/cli/commands/insights.test.ts` green (contract block
  included), pre-existing create/list tests untouched.
- Live checks (read-only): `ravi insights show ins-nope --json` → exit 1 +
  `INSIGHT_NOT_FOUND` + suggestions; `ravi insights list --kind bogus --json`
  → exit 2 + `acceptedValues`; `ravi insights list --json --fields id,kind`
  narrows items.

## Known Failure Modes

- The `list` payload exposes the SAME array under `items` and `insights`;
  projection MUST be applied to one array referenced by both keys, or the two
  views drift.
- Suggestion candidates come from `dbListInsights({limit: 40})`; if that call
  throws, the not-found envelope must still fire with empty suggestions
  (candidates are best-effort).
- `insights.test.ts` spreads the real `../context.js` module in its mock; it
  MUST override `hasContext` to true or the contract helpers call
  `process.exit` inside tests.
