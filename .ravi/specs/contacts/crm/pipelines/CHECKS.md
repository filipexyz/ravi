---
id: contacts/crm/pipelines
title: CRM Pipelines And Stages
kind: feature
domain: contacts
capability: crm
feature: pipelines
---

# Checks

## CLI Checks

- `ravi crm pipeline list --json` returns typed pipeline objects.
- `ravi crm pipeline show <pipeline> --json` returns configured stages in `sortOrder` order, including empty stages.
- `ravi crm pipeline stage topics <pipeline> <stage> --json` returns active stage topics in `sortOrder` order.
- `ravi crm board --pipeline <pipeline> --include-empty-stages --json` groups open opportunities by configured stage.

## Data Checks

- One default pipeline exists per `entity_type`.
- Stage keys are unique per pipeline.
- Stage `sort_order` values are unique per pipeline.
- Stage topics are unique by `stage_id + key`.
- Terminal stages have explicit category mapping to won/lost or another closed outcome.

## Audit Checks

- Pipeline create/update/archive writes `crm_events`.
- Stage create/update/archive writes `crm_events`.
- Stage topic create/update/archive writes `crm_events`.
- Opportunity movement writes `crm.opportunity.stage_changed` with previous and next stage.
- Entering a terminal won/lost stage writes the corresponding status event.

## Regression Checks

- A WhatsApp group cannot be created as a pipeline item.
- A contact tag cannot be treated as authoritative stage state.
- Stage topics do not create contact facts unless a separate fact write with evidence occurs.
