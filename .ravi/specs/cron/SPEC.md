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

### Bind each run at admission

- Immediately before execution, the runner MUST read the current job once and
  capture its owner principal, operator eligibility and creator chat together
  with that job's instructions. Legacy NULL owners normalize to `operator` here.
- Agent prompts MUST carry this snapshot through durable queues, runtime context
  creation/refresh and host continuations. Shell commands and their error prompts
  MUST carry the same admission snapshot. It is trusted internal producer data,
  never model text or a CLI caller's replacement for a live runtime context.
- Owner-attributed calls (connectors, Bases, Pages access and Knowledge) MUST
  classify against the admitted owner, never reread `cron_jobs.owner_principal`.
  Creator-chat overlays MUST use the admitted contact/chat with current grants.
- Ownership transfers and edits MUST affect only the next admitted execution.
  Linking a contact to the operator later MUST NOT promote an admitted run's
  operator eligibility. Current identity checks MAY reduce that eligibility.
- `enabled=false` MUST prevent subsequent scheduled admission; it MUST NOT cancel
  an already admitted run. Deleting a job, including one-shot auto-deletion,
  MUST NOT invalidate its already admitted snapshot. Explicit manual run semantics
  remain unchanged; disabling is a scheduling action, not an emergency stop.
- Blocking or removing the admitted contact MUST refuse subsequent owner-attributed
  calls, even after the job transfers to a healthy owner. Refusal MUST NOT expose
  a contact fallback that Console could authorize. Checks do not undo effects
  already performed or terminate an already spawned OS process.
- A missing, malformed or mismatched snapshot MUST fail closed for owner-attributed
  calls. Old queued prompts without it MUST NOT recover authority from live jobs;
  let them fail and admit a new execution through the runner if still wanted.

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

## Failed agent runs

- Dispatch MUST NOT count as completed work. Register pending dispatch before publishing the prompt, so immediate launch failures cannot race the registration.
- Failed/interrupted agent runs MUST notify the job owner directly through outbound delivery, without requiring an LLM turn. Classify the reason as configuration, credential, timeout, interruption or execution; raw provider text MUST NOT enter the notification.
- The existing local inbox MUST retain failed work, including when no owner delivery target resolves or delivery fails. Do not fall back to unrelated sessions or the operator for a contact-owned job. A delivered notification MUST be deduplicated per job/run, including after runner recreation.
- Agent one-shots MUST remain inspectable on failure; delete-after applies only after a successful terminal turn. The scheduler MUST NOT replay a partially executed job merely because it was interrupted.
- Persisted failures predating this change MUST remain discoverable through cron list/show; deployment MUST NOT re-run them or change owners/providers automatically. Reconcile each pending run with its owner before repeating side effects.

### Durable execution correlation

- Each admitted agent execution MUST have a unique run id, persisted with its target session, admission time and notification owner before publication. The runtime MUST preserve that identity through queued turns, continuations and failures before startup; adjacent cron runs MUST NOT coalesce into one physical turn.
- Terminal outcomes MUST match run id, job id and target session, and settle the run at most once. Session names or timestamps alone MUST NOT attribute an unmarked failure. Missing legacy run provenance stays unassigned rather than guessing an owner.
- Older outcomes MUST NOT overwrite the newest admitted job status. A one-shot MUST NOT be removed while any admitted run is pending; deletion requires the newest admitted run to have succeeded. Earlier failures remain in the run ledger and inbox even if a later successful retry removes the job.
- Job edits, transfers and deletion MUST NOT change a run's notification recipient. Failure notices MUST deduplicate by run id, including admissions in the same millisecond. Unreported durable failures MUST be reconciled on runner startup.
