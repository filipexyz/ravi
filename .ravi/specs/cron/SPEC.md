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
- Cron timer delays MUST stay within the signed 32-bit millisecond limit.
  Jobs further in the future MUST be rechecked and re-armed without dispatching
  before their persisted due time.
- Shell jobs and agent jobs are distinct execution modes with different target semantics.
- Target resolution MUST be read-only and computed at inspection time.
- `cron add --idempotency-key <key>` MUST create at most one normalized action for that key and MUST reject reuse with different action content.
- Cron creation from an observer turn with source turn ids MUST automatically derive durable idempotency from `(ruleId, sourceTurnIds, cron.add, action fingerprint)`.
- Reaction idempotency MUST survive deletion of the target cron, including `--delete-after` one-shots, so replaying the source observation cannot recreate it.

## Visibility And Authority

### Reconcile shell ownership

- An entry guard without reconciliation of existing state leaves dead capability
  appearing active. Reviews of new guards MUST cover persisted state, scheduler
  load/cycles, manual execution and operator-visible status, not only creation.
- Before arming timers (including load and config refresh), and immediately before
  execution, the scheduler MUST check shell ownership with `cronOwnerActsAsOperator`.
  The existing meaning of operator, operator-bound contact and legacy NULL stays unchanged.
- An enabled shell job whose owner does not act as the operator MUST be disabled
  atomically and have its next run cleared. It MUST NOT execute, count as a run,
  overwrite past outcomes, be deleted, or automatically regain enabled state.
- The winning enabled-to-disabled transition MUST emit one high-severity log and
  attempt one diagnostic prompt to the default agent's main session, even without
  `onError`. It MUST omit command text, env, output and other secret-bearing data.
- Repeated cycles, competing runners and reloads MUST NOT repeat the notice. An
  explicit re-enable starts a new transition if ownership is still invalid.
  Notice delivery is best effort: failure is logged and MUST NOT re-enable or retry
  the job. This is at-most-once notice submission, not guaranteed delivery.
- Read-only list/show MUST derive `ownershipError=CRON_SHELL_NOT_OPERATOR` for
  ineligible shell jobs (null otherwise). Text list MUST display `invalid-owner`
  before reconciliation and `disabled-owner` afterwards, not an active status.
- This policy MUST NOT apply to agent jobs or change creation, approval or owner
  classification rules. Target-resolution failures remain diagnostic only.

Cron jobs follow `permissions/resource-visibility` for owned runtime resources:

- A job's effective owner is `job.agentId ?? defaultAgent`.
- `cron list --all-agents` / `--agent <id>` MUST include jobs of every agent the caller may read (own, `view agent:<owner>`, superadmin, operator) and MUST report `filters.visibility` (`scoped` | `full`).
- `cron show` of an unreadable existing job MUST look like a missing job (`CRON_JOB_NOT_FOUND`).
- `cron enable/disable/set/run/rm` on an existing job the caller may not modify MUST fail with `PERMISSION_DENIED` (exit 1), never `CRON_JOB_NOT_FOUND`; `modify agent:<owner>` or superadmin is required. The denial MUST NOT include job metadata and MUST NOT name the owner unless the caller can view that agent.
- Denied mutations MUST NOT write and MUST NOT emit `ravi.cron.refresh` / `ravi.cron.trigger`.
