---
id: routines/composition
title: "Routine Composition"
kind: capability
domain: routines
capability: composition
capabilities:
  - trigger
  - context
  - skills
  - output
  - quality
tags:
  - routines
  - composition
  - skills
applies_to:
  - src/cron
  - src/triggers
  - src/skills
  - src/tasks
owners:
  - ravi-dev
status: draft
normative: true
---

# Routine Composition

## Intent

Routine Composition defines how a recurring loop combines triggers, context, skills, output policy, state, and quality checks.

## Invariants

- Trigger and context MUST be separate fields. A trigger starting a routine does not imply it has all needed context.
- Skills MUST be named explicitly when a routine depends on a specialized protocol.
- Output policy MUST define default silence or default speaking behavior.
- State writes MUST be explicit and durable.
- Quality modes SHOULD monitor user-visible routines.
- Routines SHOULD be decomposed when one trigger tries to drive unrelated outcomes.

## Composition Contract

```text
trigger
-> context acquisition
-> optional preflight commands
-> skill/protocol execution
-> durable state write
-> output decision
-> quality/watch update
```

## Non-Goals

- Routine Composition does not replace workflows.
- Routine Composition does not dispatch arbitrary projects by itself.
- Routine Composition does not grant permissions.
