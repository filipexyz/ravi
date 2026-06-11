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
  - src/prompt-builder.ts
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
- Cron MAY execute deterministic shell jobs directly when the work requires no agent judgment. Shell cron jobs MUST preserve the same lifecycle/status tracking as agent cron jobs and MUST NOT invoke an agent on successful runs.
- Shell cron jobs MAY notify a session on failure, but the notification MUST be an explicit `on-error` policy.
- Agents MAY create background cron jobs silently for concrete time-based next steps when the task has enough context, permission, and operational value. This is a follow-through aid, not a replacement for explicit routine design.
- Background cron jobs that route replies through a chat/session MUST suppress interactive presence while they work; only an actual final response should appear in the target chat.
- Inactivity-based follow-up belongs to the sessions followups domain, not cron.

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
- An agent-created background cron MUST be inspected after creation with `ravi cron show <id>` and MUST verify agent, account, session/reply-session, schedule, and one-shot deletion policy when applicable.
- Agents MUST NOT create cron jobs for every task, vague reminders, duplicate existing jobs, or noisy checks.

## Acceptance Criteria

- A human can inspect a routine and know what it does without reading a long cron prompt.
- A failed or blind routine can be detected by Quality.
- A routine can be changed without losing its historical run lineage.
