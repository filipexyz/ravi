---
id: contacts/crm/pipelines
title: CRM Pipelines And Stages
kind: feature
domain: contacts
capability: crm
feature: pipelines
---

# Runbook

## Inspect Current Board

Current implemented command:

```bash
ravi crm board --json
```

This shows open opportunities with `pipelineId`, `stageKey`, and `stageName`. It does not list empty stages or stage topics.

## Desired Pipeline Inspection

When implemented:

```bash
ravi crm pipeline list --json
ravi crm pipeline show <pipeline> --json
ravi crm pipeline stage topics <pipeline> <stage> --json
```

Use `pipeline show` when the operator asks "quais stages existem?" Use `board` when the operator asks "quais oportunidades estao em cada stage?"

## Debug Stage Moves

1. Show the opportunity:

```bash
ravi crm opportunity show <opportunity> --json
```

2. Show the pipeline:

```bash
ravi crm pipeline show <pipeline> --json
```

3. Move only to a stage in the same pipeline:

```bash
ravi crm opportunity move <opportunity> <stage> --json
```

4. Inspect CRM audit:

```bash
ravi contacts timeline <contact> --limit 20 --json
ravi crm opportunity show <opportunity> --json
```

## Debug Stage Topics

Stage topics are configuration. If an agent claims a customer has a topic, inspect CRM facts or activities for evidence instead of reading the topic list as proof.
