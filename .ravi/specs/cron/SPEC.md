---
id: cron
title: "Cron"
kind: domain
domain: cron
capabilities:
  - scheduling
  - shell-execution
  - agent-prompting
  - target-resolution
tags:
  - cron
  - scheduling
  - runners
applies_to:
  - src/cron
  - src/cli/commands/cron.ts
  - src/cli/cron-show-output.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Cron

## Intent

Cron jobs are scheduled tasks that fire prompts to agents or execute shell
commands at specified times. The cron subsystem covers scheduling, execution,
target resolution, and operational inspection.

## Invariants

- Cron jobs MUST NOT mutate routing, sessions, agents, or channel state.
- Shell jobs and agent jobs are distinct execution modes with different target semantics.
- Target resolution MUST be read-only and computed at inspection time.
- `cron add --idempotency-key <key>` MUST create at most one normalized action for that key and MUST reject reuse with different action content.
- Cron creation from an observer turn with source turn ids MUST automatically derive durable idempotency from `(ruleId, sourceTurnIds, cron.add, action fingerprint)`.
- Reaction idempotency MUST survive deletion of the target cron, including `--delete-after` one-shots, so replaying the source observation cannot recreate it.
