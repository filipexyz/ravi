---
id: contacts/crm/pipelines
title: CRM Pipelines And Stages
kind: feature
domain: contacts
capability: crm
feature: pipelines
---

# Why

The previous CRM shape had `crm_pipelines` and `crm_pipeline_stages`, but the operator-facing contract was only `ravi crm board`. That shows opportunities already in stages, but it does not answer "what stages exist?" or "what should happen in this stage?"

Configurable stages are needed because commercial workflows vary by business. A reactivation funnel, a high-ticket sales funnel, and a support-to-upsell funnel should not share one hard-coded stage set.

Stage topics are separated from customer facts because playbook configuration is not evidence. "Discuss price objection in negotiation" is different from "this customer objected to price on a specific message."

The core design keeps stage truth on the opportunity so forecast and board queries have a single operational source. Tags and AI signals remain useful as suggestions and triggers, but they do not silently move work across the funnel.

## Alternatives Rejected

- Tags as stages: rejected because tags are many-to-many labels and do not provide ordered, exclusive stage state.
- Hard-coded enum stages: rejected because operators need to change funnels without code changes.
- Stage topics as contact metadata: rejected because the topic belongs to a pipeline/stage playbook, not to every contact.
- Raw chat threads as funnel items: rejected because chats are channel containers, not CRM work items.
