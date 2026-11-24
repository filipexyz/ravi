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
  - src/automation
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

- Cron jobs MUST NOT mutate routing, sessions, agents, or channel state, beyond the execution sessions a job owns (its isolated session, its thread-mode run sessions).
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
  with that job's instructions. A NULL owner captures as `unknown`, not the operator.
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
  The meaning of operator and operator-bound contact stays unchanged; a legacy NULL
  owner is nobody (cli/connectors 13).
- An enabled shell job whose owner does not act as the operator MUST be disabled
  atomically and have its next run cleared. It MUST NOT execute, count as a run,
  overwrite past outcomes, be deleted, or automatically regain enabled state.
- The winning enabled-to-disabled transition MUST emit one high-severity log and
  send one notice, even without `onError`, by direct message with no model in the
  path (`src/cron/automation-notice.ts`, the delivery cron failures use). It goes
  to the operator alone: the owner does not act as the operator, so only the operator
  can recreate the job, and the owner (it can be a contact) is not messaged, because
  the message would reach a third party over the instance where Ravi last saw them,
  about something they cannot act on. When that message does not reach the operator
  (no contact, or more than one, is tagged as the operator, or the delivery fails)
  the notice MUST fall back to one diagnostic prompt to the default agent's main
  session, which is the operator's, so the operator is never left without it. It MUST
  omit command text, env, output, the owner's id and other secret-bearing data.
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
- A job that keeps failing MUST NOT message its owner once per run. Failures found at start MUST go out as one digest per owner, one line per job with its count, the last failure time and reason; a live failure sends at most one message per job per 24 h window, and later failed runs of the job in that window join it (inbox event `cron.failure.aggregated`). The window is read from every inbox item of the job, whatever its status (an owner who marks the notice done does not reopen it) and however many other items exist; the next message counts every failure since the last one. A digest lists at most 20 jobs and sums up the rest in one line. A failure older than the window found at start is history: it stays in the inbox and settles without a message (`cron.failure.stale`).
- Delivery MUST NOT prefer an owner chat known to be offline: chats are ordered connected first, then unknown (the setting `knowledge.owner.target` first among them, then WhatsApp, then the rest), and chats known to be offline are skipped. With no reachable chat of the owner (none resolves, or all are offline) the report MUST fail closed at once as undeliverable with the reason (`no_owner_chat`, `owner_chats_offline`) and MUST NOT be replayed at every start; a delivery that errors is retried at most 3 times across starts, then settled the same way. The inbox item stays open.
- The existing local inbox MUST retain failed work, including when no owner delivery target resolves or delivery fails. Do not fall back to unrelated sessions or the operator for a contact-owned job. A delivered notification MUST be deduplicated per job/run, including after runner recreation.
- Agent one-shots MUST remain inspectable on failure; delete-after applies only after a successful terminal turn. The scheduler MUST NOT replay a partially executed job merely because it was interrupted.
- Persisted failures predating this change MUST remain discoverable through cron list/show; deployment MUST NOT re-run them or change owners/providers automatically. Reconcile each pending run with its owner before repeating side effects.

- The owner MAY settle unreported failures without receiving them (`ravi cron ack-failures`, dry-run by default, `--execute` to apply), for when the owner's direct channel is gone for good. Settling MUST only mark the run reported: nothing is sent, the run stays `error`, and its diagnostics and inbox item stay. The caller settles only runs of jobs it may modify (owner from the stored notice; unreadable notices count as the default agent's); the rest stay pending and are counted as denied.

### Durable execution correlation

- Each admitted agent execution MUST have a unique run id, persisted with its target session, admission time and notification owner before publication. The runtime MUST preserve that identity through queued turns, continuations and failures before startup; adjacent cron runs MUST NOT coalesce into one physical turn.
- Terminal outcomes MUST match run id, job id and target session, and settle the run at most once. Session names or timestamps alone MUST NOT attribute an unmarked failure. Missing legacy run provenance stays unassigned rather than guessing an owner.
- Older outcomes MUST NOT overwrite the newest admitted job status. A one-shot MUST NOT be removed while any admitted run is pending; deletion requires the newest admitted run to have succeeded. Earlier failures remain in the run ledger and inbox even if a later successful retry removes the job.
- Job edits, transfers and deletion MUST NOT change a run's notification recipient. Failure notices MUST deduplicate by run id, including admissions in the same millisecond. Unreported durable failures MUST be reconciled on runner startup.
- Startup failure reconciliation MUST run in the background: a backlog or an unavailable delivery channel MUST NOT delay daemon readiness, and reports that settle locally MUST yield the event loop between them. A report whose stored notice cannot be parsed is bad data: it MUST be recorded once in the inbox (no message is sent, because its recipient lives only in that notice) and settled, so it is neither retried nor raised at shutdown. A report that fails unexpectedly (a refused write, say) MUST NOT stop the reports behind it: it stays pending. Stopping the runner MUST stop admitting further reports and wait for the report in flight for about a second at most, because the daemon stops its components one after another inside a single shutdown guard; unsuccessful, unattempted and unfinished reports stay pending for the next start (an unconfirmed send may be sent again). Reconciliation errors MUST remain observable to shutdown (a bounded number are kept for it; every one is logged). A stop that raised stays failed: a later stop of that runner raises again, and the module runner is kept for the same reason, because retrying cannot certify success after a failed shutdown (the latch in `quality/state-boundary`).

## Thread mode

The contract below is shared by cron jobs and agent triggers (`triggers add --thread`, the core in `src/automation/child-runs.ts`); trigger specifics are at the end of the section.

- An agent job MAY run in thread mode (`cron add --thread [--report-to <session>]`, `cron set <id> session thread`). Each run MUST open a fresh child session `agent:<agent>:cron:<job>:run:<runId>`, named after the whole run id (never truncated), so no run takes the name or the history of an earlier one. Only that run enters it.
- The run reports to the job's reply session, else the agent's main session. That parent MUST be a lasting session of the job's agent: never a trigger's own session, an automation run's own session (pruned after it closes) or an ephemeral session. A job created inside a run reports where that run reports. These are refused  by `cron add` and `cron set agent|reply-session`, and the runner fails the run (`THREAD_PARENT_MISSING`, `THREAD_PARENT_OTHER_AGENT`, `THREAD_PARENT_UNSTABLE`) without opening a child.
- The run's prompt MUST carry the same authority envelope as the other modes (`_cronAuthority`, `_cronRunId`) and no source: its replies reach no chat. The core surface is headless; a channel adapter MAY add a visible surface (a Slack thread) without changing this contract.
- The run's text reaches the parent quoted line by line under a label that it is data, not instruction: a run may have read untrusted data, and no line of it can pass for a line of the notice (a `[System]` one). Every line break counts (`\r\n`, `\r`, `\n`, NEL, LS, PS), and the job's or trigger's free-text name is JSON-quoted on the notice's first line.
- The run reaches its parent only through `sessions report` (progress) and `sessions close-thread [--return]` (once). A return on a closed run MUST fail (`THREAD_CLOSED`), never be dropped as delivered. A return is a `session.return` prompt carrying text only.
- When the run's turn ends and the run is still open, the runner MUST close it: the final reply, read from the run's own message history, reaches the parent once; `@@SILENT@@` or no reply closes silently; a failed or interrupted turn sends one error return with the classified reason, never raw provider text. The owner's failure notice comes first: a parent that cannot be reached never delays it.
- One run at a time per job: while the previous run is open, a scheduled run is skipped (next run advanced, last outcome untouched); a manual run still goes. A run open longer than 2 h is closed as failed, with one error return, so the job is never stuck behind it.
- After a run closes, the runner releases the child's runtime and keeps the job's 20 newest closed runs; older ones are deleted with their sessions and transcripts. A run whose return is still pending is kept.
- The leader reconciles runs in the background every 5 minutes (never on the readiness path): a return left `pending` because its publish failed is delivered again; one still undelivered 24 h after its run closed is given up (`error` without `parentNotifiedAt`), its owner told by direct message under the failure notice's rule (cron and trigger alike, through the owner's reachable chats): at most one message per cron or trigger every 24 h, a loss inside the window joins the last notice and the next one counts every loss since; an operator gets where to look (CLI), a contact gets the product sentence only (no command, no internal session name, the name on one line); the inbox item is the record, one per run. The run becomes prunable. Stopping the cron runner waits for the pass in flight, which stops between runs. A run open longer than 2 h (its job disabled since, its turn's end never seen) is closed as failed with one error return and its runtime released.
- Delivery to the parent is at least once: the publish is deduplicated by a fixed message id inside the stream's window; a crash between the publish and the `returned` mark followed by a retry after that window can deliver twice.
- `--isolated` (`session isolated`) is deprecated: still accepted and executed as before, with a warning pointing at `--thread`.
- Triggers: `triggers add --thread [--report-to <session>]` (agent triggers only; refused with `--session` or `--shell`; `--session thread` is refused in favour of `--thread`). Each fire opens `agent:<agent>:trigger:<id>:run:<runId>` with the trigger's authority snapshot and NO owner lending (`ownSessionKey` null): what a run reads goes back to its parent, so the owner's Bases access stays with `--session isolated`. One fire at a time: while the previous run is open a fire is skipped, as a cooldown would. The trigger runner closes a run when its turn ends (runtime events matched by the run session's name). A fire never falls back to the trigger's frozen creator chat: its replies reach no chat. CLI calls from a run session count as trigger-originated (no loop).
- A fire skipped because the trigger's previous run is still open is logged, not counted anywhere; a trigger whose events each matter should not use thread mode until the skip is counted (follow-up).
- The trigger runner's turn watch restarts when its subscription ends, with or without an error, while the runner runs.
- A job or trigger created inside an automation run, with or without `--thread`, takes the run's parent as its session/reply session: the run's own session is pruned.
- `--session isolated` on triggers is deprecated with an explicit exception: keep it only for a trigger that reads Bases as its owner.
