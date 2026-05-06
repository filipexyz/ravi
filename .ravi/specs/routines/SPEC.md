---
id: routines
title: "Routines"
kind: domain
domain: routines
capabilities:
  - composition
  - scheduling
  - silence-policy
  - quality-watch
tags:
  - routines
  - cron
  - triggers
  - automation
  - hermes-pattern
applies_to:
  - src/cron
  - src/triggers
  - src/tasks
  - src/sessions
  - src/cli/commands/cron.ts
  - src/cli/commands/triggers.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Routines

## Intent

Routines are named recurring operational loops. They compose trigger, context acquisition, skills, output policy, owner, and quality watch into one durable contract.

This domain exists because a cron prompt is too weak as the source of truth for repeated behavior. A routine should explain what it observes, when it speaks, when it stays silent, and how failures are detected.

## Boundaries

- Cron is a scheduler. It MUST NOT be the full semantic definition of a recurring process.
- Trigger is an event subscription. It MUST NOT be the full semantic definition of a recurring process.
- Routine is the durable contract that may use cron, triggers, tasks, sessions, skills, and quality modes.

## Routine Shape

Each routine SHOULD define:

```yaml
id: life_review_snapshot
owner: life-review
trigger:
  type: cron
  schedule: "0 8,14,20 * * *"
context:
  read:
    - sessions
    - tasks
    - projects
    - health
    - journal
skills:
  - life-review
output:
  default: silent
  speak_when:
    - severity: watch
    - severity: act_now
quality:
  failure_modes:
    - cron_blind_repeated
    - output_contract_violation
```

## Invariants

- A routine MUST have an owner.
- A routine MUST define when to speak and when to stay silent.
- A routine MUST define its context sources.
- A routine MUST define its output contract.
- A routine SHOULD define quality failure modes that monitor it.
- A routine MUST NOT perform irreversible external action unless the routine policy explicitly allows it and approvals are satisfied.
- A routine SHOULD write durable state when it is expected to remember prior runs.

## Acceptance Criteria

- A human can inspect a routine and know what it does without reading a long cron prompt.
- A failed or blind routine can be detected by Quality.
- A routine can be changed without losing its historical run lineage.
