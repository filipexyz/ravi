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

## Visibility And Authority

Cron jobs follow `permissions/resource-visibility` for owned runtime resources:

- A job's effective owner is `job.agentId ?? defaultAgent`.
- `cron list --all-agents` / `--agent <id>` MUST include jobs of every agent the caller may read (own, `view agent:<owner>`, superadmin, operator) and MUST report `filters.visibility` (`scoped` | `full`).
- `cron show` of an unreadable existing job MUST look like a missing job (`CRON_JOB_NOT_FOUND`).
- `cron enable/disable/set/run/rm` on an existing job the caller may not modify MUST fail with `PERMISSION_DENIED` (exit 1), never `CRON_JOB_NOT_FOUND`; `modify agent:<owner>` or superadmin is required. The denial MUST NOT include job metadata and MUST NOT name the owner unless the caller can view that agent.
- Denied mutations MUST NOT write and MUST NOT emit `ravi.cron.refresh` / `ravi.cron.trigger`.
