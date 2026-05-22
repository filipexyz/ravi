---
id: contacts/crm/forecast
title: CRM Forecast Simulation
kind: feature
domain: contacts
capability: crm
feature: forecast
---

# Runbook

## Simulate Explicit Example

```bash
ravi crm forecast simulate \
  --pipeline vendas \
  --stage stage1 \
  --count 100 \
  --conversion 0.10 \
  --avg-ticket 100 \
  --currency BRL \
  --month 2026-05 \
  --json
```

Expected core result:

```json
{
  "expectedRevenueCents": 100000
}
```

## Simulate Current Pipeline

```bash
ravi crm pipeline show <pipeline> --json
ravi crm board --pipeline <pipeline> --json
ravi crm forecast simulate --pipeline <pipeline> --month 2026-05 --json
```

If rows fail because assumptions are missing, set stage or pipeline forecast metadata, or pass explicit assumptions.

## Debug Bad Forecast

Check:

1. Does the pipeline exist?
2. Does the stage exist in that pipeline?
3. Which stages have open opportunities?
4. Does each row have a conversion rate?
5. Does each row have an average ticket and currency?
6. Are paused, archived, won, and lost opportunities intentionally excluded?

## Operator Explanation

When explaining a forecast, include the formula and assumptions:

```text
100 items * 10% conversion * BRL 100 average ticket = BRL 1,000 expected revenue.
```

Do not present this as guaranteed revenue.
