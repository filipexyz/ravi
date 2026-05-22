---
id: contacts/crm/forecast
title: CRM Forecast Simulation
kind: feature
domain: contacts
capability: crm
feature: forecast
tags:
  - contacts
  - crm
  - forecast
  - simulation
  - pipelines
applies_to:
  - src/contacts.ts
  - src/cli/commands/crm.ts
  - packages/ravi-os-sdk/src/client.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# CRM Forecast Simulation

## Intent

CRM forecast simulation estimates expected revenue for a period from funnel state and explicit assumptions.

The core formula is:

```text
item_count * conversion_rate * average_ticket = expected_revenue
```

Example:

```text
100 customers * 10% conversion * BRL 100 average ticket = BRL 1,000 expected revenue
```

This feature is a read-only planning tool. It helps operators ask "given the current stage counts and assumptions, what revenue should this month produce?"

## Boundaries

- Forecast simulation MUST NOT mutate CRM state.
- Forecast simulation MUST NOT move opportunities, create tasks, create contacts, apply tags, or confirm facts.
- Forecast simulation MUST NOT use `contact_policy.status` as sales lifecycle or stage.
- Forecast simulation MUST read configured pipelines/stages, open opportunities, stage assumptions, historical won values, and explicit CLI assumptions.
- Forecast simulation MAY emit non-mutating telemetry or command audit outside `crm_events`, but it MUST NOT create CRM mutation events.
- Raw messages and chats are evidence only. They MUST NOT be counted directly unless they have been projected into CRM work items or an explicit segment/count input.

## Definitions

- `item_count`: number of customers, subjects, opportunities, or stage items included in one row of the simulation.
- `conversion_rate`: probability from `0` to `1` that an item in the row becomes won inside the forecast period.
- `average_ticket`: expected revenue per converted item, stored and computed in integer cents.
- `expected_revenue`: `item_count * conversion_rate * average_ticket`.
- `period`: the forecast horizon, usually a calendar month.
- `source`: where each input came from: explicit CLI flag, pipeline config, stage config, historical data, or current CRM count.

The word "subject" in operator language SHOULD be mapped to a typed source in output: opportunity count, contact count, segment member count, or explicit count. JSON MUST use `itemCount` rather than an ambiguous `subjects` key.

## Input Precedence

For each stage row, values MUST be resolved in this order.

### Count

1. Explicit `--count` for a single-stage simulation.
2. Explicit scenario JSON row count.
3. Current count of open opportunities in the requested pipeline/stage.
4. Future segment snapshot count, only when the scenario explicitly references a segment.

### Conversion Rate

1. Explicit `--conversion`.
2. Explicit scenario JSON row conversion rate.
3. Stage config `metadata_json.forecast.monthlyConversionRate`.
4. Pipeline config `metadata_json.forecast.defaultMonthlyConversionRate`.
5. Historical stage-to-won rate for the same period shape, when available and labeled as historical.

### Average Ticket

1. Explicit `--avg-ticket`.
2. Explicit scenario JSON row average ticket.
3. Stage config `metadata_json.forecast.avgTicketCents`.
4. Pipeline config `metadata_json.forecast.defaultAvgTicketCents`.
5. Historical closed-won average for the same pipeline/currency, when available and labeled as historical.

Rules:

- Missing conversion rate MUST fail the row unless `--allow-missing` is provided.
- Missing average ticket MUST fail the row unless `--allow-missing` is provided.
- Money MUST be computed in integer cents and formatted only at presentation boundaries.
- Conversion rates MUST be validated as `0 <= rate <= 1`.
- Counts MUST be non-negative integers.
- Currency MUST be explicit when average ticket is explicit.

## CLI Contract

Core command:

```bash
ravi crm forecast simulate --pipeline <pipeline> --month <YYYY-MM> [--json]
```

Single-stage explicit simulation:

```bash
ravi crm forecast simulate \
  --pipeline <pipeline> \
  --stage <stage> \
  --count 100 \
  --conversion 0.10 \
  --avg-ticket 100 \
  --currency BRL \
  --month 2026-05 \
  --json
```

Custom period:

```bash
ravi crm forecast simulate \
  --pipeline <pipeline> \
  --from 2026-05-01 \
  --to 2026-05-31 \
  --json
```

Scenario file:

```bash
ravi crm forecast simulate --scenario <file.json> --json
```

JSON output MUST include:

```json
{
  "period": {
    "from": "2026-05-01",
    "to": "2026-05-31",
    "timezone": "America/Sao_Paulo"
  },
  "pipeline": {
    "id": "crm_pipeline_default",
    "name": "Default Sales Pipeline"
  },
  "rows": [
    {
      "stageKey": "stage1",
      "stageName": "Stage 1",
      "itemCount": 100,
      "conversionRate": 0.1,
      "avgTicketCents": 10000,
      "currency": "BRL",
      "expectedRevenueCents": 100000,
      "sources": {
        "itemCount": "explicit",
        "conversionRate": "explicit",
        "avgTicket": "explicit"
      },
      "warnings": []
    }
  ],
  "totals": {
    "currency": "BRL",
    "expectedRevenueCents": 100000
  },
  "warnings": []
}
```

## Calculation Rules

For one row:

```text
expectedRevenueCents = round(itemCount * conversionRate * avgTicketCents)
```

Rounding MUST be deterministic. The default is nearest integer cent after multiplying the full row.

For totals:

- Totals MUST sum already-rounded row `expectedRevenueCents`.
- Rows with different currencies MUST NOT be collapsed into one numeric total.
- Terminal lost stages MUST be excluded unless explicitly included by scenario JSON.
- Terminal won stages SHOULD be excluded from future expected revenue unless the operator asks for realized revenue.
- Paused or archived opportunities MUST be excluded by default.

## Historical Sources

Historical averages and conversion rates are allowed only when their source window is disclosed.

Historical calculation SHOULD use:

- won opportunities for average ticket
- opportunities entering the stage and later won inside a comparable period for conversion
- the same pipeline and currency when possible

If historical data is sparse, the row MUST include a warning and identify the sample size.

## Display Rules

Human output SHOULD be compact and stage-oriented:

```text
Forecast 2026-05

- stage1: 100 items * 10% * BRL 100.00 = BRL 1,000.00
- proposal: 12 items * 55% * BRL 420.00 = BRL 2,772.00

Total: BRL 3,772.00
```

The CLI MUST show assumptions and warnings. It MUST NOT present forecast as guaranteed revenue.

## Acceptance Criteria

- The explicit example `100 * 0.10 * BRL 100` returns `BRL 1,000` expected revenue.
- Simulation can run with only explicit inputs and no existing opportunities.
- Simulation can run from current pipeline stage counts when assumptions exist.
- Every row identifies the source of count, conversion, and average ticket.
- Missing assumptions are surfaced as row errors or warnings, not silently replaced by zero.
- Forecast commands are read-only with respect to contacts, opportunities, tags, facts, tasks, and CRM events.
- JSON output is stable enough for another agent or UI to consume.
