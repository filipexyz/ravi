---
id: contacts/crm/pipelines
title: CRM Pipelines And Stages
kind: feature
domain: contacts
capability: crm
feature: pipelines
tags:
  - contacts
  - crm
  - pipelines
  - stages
  - playbooks
applies_to:
  - src/contacts.ts
  - src/cli/commands/crm.ts
  - packages/ravi-os-sdk/src/client.ts
  - extensions/whatsapp-overlay/content.js
owners:
  - ravi-dev
status: draft
normative: true
---

# CRM Pipelines And Stages

## Intent

CRM pipelines define configurable commercial workflows above contacts.

A pipeline is an ordered set of stages. A stage is the current workflow position of a CRM work item, initially an opportunity. Stage topics describe the commercial subjects, objections, criteria, and playbook prompts expected in that stage.

This feature exists so operators can inspect and change the funnel without editing seed code, and so agents can reason about stage-specific next actions, topics, and forecast assumptions.

## Boundaries

- A stage MUST be a first-class CRM configuration item, not only a hard-coded enum or seed array.
- A stage MUST belong to exactly one pipeline.
- A stage key MUST be unique inside its pipeline.
- Stage order MUST be explicit and stable.
- Stage truth MUST live on the CRM entity being moved, initially `crm_opportunities.stage_id`.
- A contact is not "in a stage" by itself. A contact appears in a stage through a CRM work item such as an opportunity, or through a future explicit stage membership model.
- A chat/group/thread MUST NOT become a pipeline item. It may appear only as provenance or evidence for the CRM item.
- Tags, AI signals, facts, and message analysis MAY suggest a stage move, but they MUST NOT silently become stage truth.
- Stage topics are playbook/context configuration. They MUST NOT be used as identity, policy status, or contact lifecycle.
- Stage config changes MUST write CRM audit events, but they MUST NOT create contact timeline events unless a specific contact-related CRM item changed.

## Core Model

The existing `crm_pipelines` and `crm_pipeline_stages` tables are the base model.

### `crm_pipelines`

Required semantics:

- `id`: stable pipeline id.
- `name`: human-facing label.
- `entity_type`: initially `opportunity`; future values MAY include `contact`, `account`, or `campaign_item` only when a first-class entity model exists.
- `is_default`: one default pipeline per entity type.
- `status`: `active`, `archived`, or future explicit state.
- `metadata_json`: configuration that does not deserve first-class columns yet.

Pipeline `metadata_json` MAY contain:

```json
{
  "currency": "BRL",
  "description": "Default sales workflow",
  "forecast": {
    "defaultAvgTicketCents": 10000,
    "defaultMonthlyConversionRate": 0.1
  }
}
```

### `crm_pipeline_stages`

Required semantics:

- `id`: stable stage id.
- `pipeline_id`: owning pipeline.
- `key`: stable slug used in CLI, SDK, and config.
- `name`: human-facing label.
- `sort_order`: ordering inside the pipeline.
- `category`: `new`, `active`, `waiting`, `terminal_won`, `terminal_lost`, or future explicit category.
- `probability`: optional default win probability, represented as a number from `0` to `1`.
- `is_terminal`: true only when entering the stage should close or finish the CRM work item.
- `metadata_json`: stage configuration and assumptions.

Stage `metadata_json` MAY contain:

```json
{
  "entryCriteria": ["Customer has a concrete need"],
  "exitCriteria": ["Proposal sent or next meeting scheduled"],
  "forecast": {
    "monthlyConversionRate": 0.1,
    "avgTicketCents": 10000,
    "avgCycleDays": 14
  }
}
```

Rules:

- `probability` and `metadata_json.forecast.monthlyConversionRate` are different assumptions.
- `probability` is the generic chance of winning from this stage.
- `monthlyConversionRate` is the chance that an item in this stage becomes won inside the forecast period.
- Terminal won/lost stages SHOULD map to opportunity status changes when an opportunity enters them.
- Moving an opportunity into a stage from another pipeline MUST fail unless the command explicitly migrates the opportunity to that pipeline.
- Archiving a stage MUST fail while open, non-archived opportunities reference it; operators must move or close those opportunities first.

## Stage Topics

Stage topics are configured commercial subjects for one stage.

They answer questions like:

- what should the agent talk about in this stage?
- which objections are common here?
- which evidence confirms the item can advance?
- which next actions are normal here?

Ravi SHOULD persist stage topics in a first-class table when this feature is implemented:

```sql
CREATE TABLE IF NOT EXISTS crm_pipeline_stage_topics (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES crm_pipeline_stages(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  topic_type TEXT NOT NULL DEFAULT 'subject',
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(stage_id, key)
);
```

Common `topic_type` values:

- `subject`
- `objection`
- `qualification`
- `proposal`
- `pricing`
- `next_action`
- `risk`

Topic `metadata_json` MAY contain:

```json
{
  "promptHints": ["Ask for expected purchase date"],
  "advanceCriteria": ["Customer accepts price range"],
  "evidenceRequired": ["message_id or activity_id"],
  "suggestedTags": ["objection:price"]
}
```

Rules:

- Stage topics MUST be read as playbook/configuration, not as proof that a customer has that topic.
- A customer's actual objection, need, or preference SHOULD be stored as a CRM fact/activity with evidence.
- A stage topic MAY define suggested tags or fact keys, but applying those tags/facts is a separate audited write.

## CLI Contract

The core CLI SHOULD expose pipeline configuration separately from the opportunity board.

Required read commands:

```bash
ravi crm pipeline list [--json]
ravi crm pipeline show <pipeline> [--json]
ravi crm pipeline stage list <pipeline> [--json]
ravi crm pipeline stage show <pipeline> <stage> [--json]
ravi crm pipeline stage topics <pipeline> <stage> [--json]
```

Required write commands:

```bash
ravi crm pipeline create <name> --entity-type opportunity [--default] [--json]
ravi crm pipeline set <pipeline> <field> <value> [--json]
ravi crm pipeline stage add <pipeline> <key> --name <name> --order <n> [--json]
ravi crm pipeline stage set <pipeline> <stage> <field> <value> [--json]
ravi crm pipeline stage archive <pipeline> <stage> [--json]
ravi crm pipeline stage topic add <pipeline> <stage> <key> --title <title> [--json]
ravi crm pipeline stage topic set <pipeline> <stage> <topic> <field> <value> [--json]
ravi crm pipeline stage topic archive <pipeline> <stage> <topic> [--json]
```

Opportunity movement remains:

```bash
ravi crm opportunity move <opportunity> <stage> [--json]
```

Rules:

- `ravi crm board` SHOULD show opportunities grouped by configured stage.
- `ravi crm board --pipeline <pipeline> --include-empty-stages` SHOULD show empty configured stages.
- CLI `--json` responses MUST expose typed `pipeline`, `stages`, `topics`, and `opportunities` objects, not formatting-only strings.
- Write commands SHOULD accept an idempotency key when they can be retried.

## Audit Events

Pipeline configuration writes MUST create `crm_events` rows.

Required event types:

- `crm.pipeline.created`
- `crm.pipeline.updated`
- `crm.pipeline.archived`
- `crm.pipeline_stage.created`
- `crm.pipeline_stage.updated`
- `crm.pipeline_stage.archived`
- `crm.pipeline_stage_topic.created`
- `crm.pipeline_stage_topic.updated`
- `crm.pipeline_stage_topic.archived`

Opportunity movement MUST continue to use:

- `crm.opportunity.stage_changed`
- `crm.opportunity.status_changed` when entering terminal status

Audit payloads MUST include previous and next values for changes.

## Acceptance Criteria

- Operators can list all pipelines and their stages without reading SQLite directly.
- Operators can inspect stage topics for one stage from CLI.
- A configured stage can be empty and still appear in `pipeline show`.
- Moving an opportunity validates that the destination stage belongs to the opportunity pipeline.
- Terminal stages close or finish opportunities according to explicit category/status rules.
- Archiving a stage with open opportunities is rejected instead of hiding those opportunities from the board.
- Stage topics are visible to agents as playbook context, but customer-specific facts remain separately evidenced.
- Pipeline, stage, and topic changes write CRM audit events.
- The default seeded pipeline remains usable but is no longer the only way to define stages.
