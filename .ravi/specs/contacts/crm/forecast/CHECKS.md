---
id: contacts/crm/forecast
title: CRM Forecast Simulation
kind: feature
domain: contacts
capability: crm
feature: forecast
---

# Checks

## Calculation Checks

- `100 * 0.10 * 10000` returns `100000` cents.
- Conversion `0` returns zero expected revenue.
- Conversion `1` returns `count * avgTicketCents`.
- Conversion below `0` or above `1` is rejected.
- Negative counts are rejected.
- Money is calculated in integer cents.
- Totals sum row-level rounded cents.

## Source Checks

- Explicit CLI inputs are labeled `explicit`.
- Stage config assumptions are labeled `stage_config`.
- Pipeline defaults are labeled `pipeline_config`.
- Historical assumptions include sample size and source window.
- Missing count, conversion, or ticket values never become silent zeroes.

## Read-Only Checks

- Running `ravi crm forecast simulate` does not modify contacts.
- Running `ravi crm forecast simulate` does not modify opportunities.
- Running `ravi crm forecast simulate` does not create tasks.
- Running `ravi crm forecast simulate` does not apply tags.
- Running `ravi crm forecast simulate` does not create CRM mutation events.

## Integration Checks

- Pipeline/stage ids in output match `ravi crm pipeline show`.
- Current stage counts match `ravi crm board --pipeline <pipeline>`.
- Rows with different currencies are not collapsed into one total.
