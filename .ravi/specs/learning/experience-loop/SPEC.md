---
id: learning/experience-loop
title: "Experience Loop"
kind: capability
domain: learning
capability: experience-loop
capabilities:
  - post-task-review
  - incident-review
  - learning-routing
tags:
  - learning
  - experience
  - review
applies_to:
  - src/tasks
  - src/insights
  - src/artifacts
  - .ravi/specs
owners:
  - ravi-dev
status: draft
normative: true
---

# Experience Loop

## Intent

The Experience Loop is the post-work review that decides whether a completed task, incident, or repeated manual action should update Ravi's durable capabilities.

## Invariants

- The loop MUST run after high-impact incidents, repeated manual fixes, and completed tasks that changed runtime behavior.
- The loop SHOULD run after successful workflows that are likely to repeat.
- The loop MUST produce one of: no-op, memory, insight, spec, skill, routine, task/profile update, eval/check.
- The loop MUST NOT create automation or external side effects by itself.
- The loop SHOULD prefer updating an existing surface over creating a duplicate one.

## Minimum Output

When the loop does produce durable learning, it MUST record:

- source work reference
- learning summary
- destination surface
- validation or review status
- owner

## Examples

- Root cause fixed in `codex-provider.ts` -> update runtime/provider spec and add regression check.
- Repeated task setup procedure -> create or update a skill.
- Repeated cron with vague prompt -> promote to routine with output contract.
- Luis-specific working preference -> update memory.
