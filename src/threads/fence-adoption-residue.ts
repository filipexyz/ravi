import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { type DurableResidue, type DurableResidueSource, openStateReadOnly } from "./fence-adoption.js";

/**
 * Durable residue of a legacy (3.261113.2) runtime, read only after both
 * predecessors physically exited. Every accepted unit must be terminal, durably
 * pending or durably in flight with a named owner that resumes it in the
 * successor. A status outside the rule, or a table that cannot be read, is
 * unknown and blocks adoption.
 */
export type ResidueRule = {
  /** Database file, as listed by runtimeStateDatabasePaths. */
  database: string;
  table: string;
  column: string;
  terminal: readonly string[];
  pending: readonly string[];
  inFlight: readonly string[];
  /** Who resumes pending/in-flight rows in the successor. */
  owner: string;
  /** Known non-terminal statuses whose resumption was not verified: they block, with their own label. */
  blocking?: readonly string[];
  /** The schema itself defines the active set (a partial index); every other status is terminal. */
  terminalComplement?: boolean;
  /** Resumption in the successor was not verified: every non-terminal status blocks, labelled so. */
  unverified?: boolean;
  /** Searched in every runtime database; a database whose table lacks the column holds another table. */
  anyDatabase?: boolean;
  /** Where the tag declares every value this column may take; the inventory test reads it from the tag. */
  vocabulary?: LegacyVocabulary;
  /** Why each value in `pending` is at rest by design: who resumes it, or why nothing needs resuming. */
  restReasons?: Readonly<Record<string, string>>;
  /** Work expressed without a status: rows matching `where` (static SQL from this file) are pending or block. */
  condition?: { where: string; usesNow?: boolean; outcome: "pending" | "blocking"; deadline?: string };
};

/**
 * Status sets of v3.261113.2: CHECK constraints where the schema has them
 * (src/router/router-db.ts, jobs, mail/calendar outbox, cloud deliveries) and the
 * writers where the column is free text (decisions, signals).
 */
// Exits for blocking rows (seventh review). A value blocks only when neither release resumes or
// recomputes it; the coordinator never writes a row. The exit is the RUNBOOK settle step for that
// table: the same columns the tag's own writer sets, run by the operator with explicit
// authorization while the adoption is blocked and both runtimes are stopped (exits proven, so the
// row's writer is provably gone), then `retry`. That works for rows the stop itself creates; rows
// that already exist show in the adopt preview and can be settled the same way before the window.
const SETTLE_EXIT =
  "only its writer settles it, and that process is gone; exit: the RUNBOOK settle step for this table (operator-authorized, both runtimes stopped while the adoption is blocked), then retry";
const CALL_EXIT =
  "a call in progress, closed only by its own dial or webhook (no reconcile in either release); exit: let calls end before the window (the adopt preview lists them); a call the stop caught goes through the RUNBOOK settle step for calls, then retry";

export const LEGACY_ROUTER_RESIDUE_RULES: readonly Omit<ResidueRule, "database">[] = [
  {
    table: "runtime_prompt_queue",
    column: "status",
    terminal: ["complete", "cancelled", "superseded", "failed"],
    pending: ["queued", "requeued", "deferred"],
    inFlight: ["leased", "starting", "delivered"],
    owner: "runtime recovery (runtime_recovery_candidates prompt_queue)",
  },
  {
    table: "runtime_turn_attempts",
    column: "status",
    terminal: ["complete", "failed", "interrupted", "timeout", "aborted"],
    pending: [],
    inFlight: ["running"],
    owner: "runtime recovery (runtime_recovery_candidates turn_attempt)",
  },
  {
    table: "channel_backend_ingress_receipts",
    column: "state",
    terminal: ["published"],
    pending: [],
    inFlight: ["accepted", "publishing"],
    owner: "channel runner ingress republication",
  },
  {
    table: "channel_backend_runtime_interrupts",
    column: "state",
    terminal: ["published"],
    pending: [],
    inFlight: ["accepted", "publishing"],
    owner: "channel runner interrupt republication",
  },
  {
    table: "runtime_recovery_runs",
    column: "status",
    terminal: ["complete", "failed"],
    pending: [],
    inFlight: ["running"],
    owner: "runtime recovery run at successor boot",
  },
  {
    table: "runtime_recovery_claims",
    column: "status",
    terminal: ["applied", "failed"],
    pending: [],
    inFlight: ["claimed"],
    owner: "runtime recovery claims",
  },
  {
    table: "runtime_recovery_candidates",
    column: "action_status",
    terminal: ["applied", "failed", "not_applied"],
    pending: ["pending"],
    inFlight: ["claimed"],
    owner: "runtime recovery candidates",
  },
  {
    table: "sync_outbox",
    column: "status",
    terminal: ["sent", "acked", "failed", "dead"],
    pending: ["pending"],
    inFlight: ["leased"],
    owner: "sync outbox dispatcher",
  },
  {
    table: "sync_inbox",
    column: "status",
    terminal: ["applied", "skipped", "failed", "dead"],
    pending: ["pending"],
    inFlight: [],
    owner: "sync inbox applier",
  },
  // src/channels/slack/inbound-inbox.ts (l.284): envelopes are recorded before
  // processing; socket-mode.ts (l.923-932, resumePendingInboundEnvelopes) resumes
  // accepted and expired processing claims when the successor connects.
  {
    table: "slack_inbound_envelopes",
    column: "state",
    terminal: ["processed"],
    pending: ["accepted"],
    inFlight: ["processing"],
    owner: "slack socket mode (resumePendingInboundEnvelopes)",
  },
  // The next three keep blocking (operator decision, risk A (a)); each has a settle step.
  // channel_outbound_receipts (tag outbound-receipts.ts): claimed l.251-262 (an expired claim is
  // taken over only when its job is redelivered from CHANNEL_OUTBOUND and resend_prohibited = 0,
  // outbound-consumer.ts l.455, l.552 in this release), sent l.322-331, persisted l.353-365,
  // complete l.392-408, suppressed l.432-440. A receipt whose job is no longer in the stream is
  // never touched again; telling the two apart needs the stream's content (risk A (b), its own PR).
  // channel_backend_runtime_state: upsert router-db.ts l.7710 (this release l.7718), read only by
  // turn_id (l.7595, l.7634; l.7603, l.7642, l.7759): nothing lists or reconciles it.
  // cron_runs: settled only by settleCronRun when its own session reports (cron/run-db.ts l.47-54);
  // a pending run also holds back the job's next run (l.61).
  {
    table: "channel_outbound_receipts",
    column: "state",
    terminal: ["complete", "suppressed"],
    pending: [],
    inFlight: [],
    blocking: ["claimed", "sent", "persisted"],
    owner: `channel outbound receipts: carried only while their job is in CHANNEL_OUTBOUND, which this read cannot tell; ${SETTLE_EXIT}`,
  },
  {
    table: "channel_backend_runtime_state",
    column: "state",
    terminal: ["completed", "failed", "interrupted"],
    pending: [],
    inFlight: [],
    blocking: ["accepted", "running", "waiting_approval"],
    owner: `channel backend runtime state of a turn the stop cut: nothing lists or reconciles it; ${SETTLE_EXIT}`,
  },
  {
    table: "cron_runs",
    column: "status",
    terminal: ["ok", "error"],
    pending: [],
    inFlight: [],
    blocking: ["pending"],
    owner: `cron runs: settled only when their session reports; ${SETTLE_EXIT}`,
  },
  // src/channels/outbound-publish-outbox.ts: pending jobs are selected for publication again (l.270).
  {
    table: "channel_outbound_publish_jobs",
    column: "status",
    terminal: ["published", "suppressed"],
    pending: ["pending"],
    inFlight: [],
    owner: "outbound publish outbox",
  },
  // src/cloud-agents/task-watcher.ts polls every run with state != 'acknowledged' (l.238, l.260).
  {
    table: "cloud_agent_task_runs",
    column: "state",
    terminal: ["acknowledged"],
    pending: [],
    inFlight: ["active", "delivered"],
    owner: "cloud task watcher (open runs)",
  },
  // Pending claims are retried by the watcher (task-runs-db.ts l.412); a started dispatch
  // is accounted for by its run in cloud_agent_task_runs.
  {
    table: "cloud_agent_task_dispatches",
    column: "state",
    terminal: ["started", "failed", "abandoned"],
    pending: ["pending"],
    inFlight: [],
    owner: "cloud task watcher (pending claims)",
  },
  // src/session-followups/db.ts claims pending rows and leased rows whose lease expired (l.392-393).
  {
    table: "session_followup_runs",
    column: "status",
    terminal: ["sent", "skipped", "failed", "dead"],
    pending: ["pending"],
    inFlight: ["leased"],
    owner: "session followup dispatcher (expired leases are claimed again)",
  },
  // src/decisions/delivery.ts: 'failed' and 'published' are claimed again; an expired
  // 'accepting' claim becomes 'uncertain', which only an explicit resolution settles.
  {
    table: "decision_deliveries",
    column: "status",
    terminal: ["delivered", "superseded"],
    pending: ["pending", "failed", "published"],
    inFlight: ["publishing", "accepting", "uncertain"],
    owner: "decision delivery worker; uncertain answers by explicit resolution",
  },
  // src/signals/signal-db.ts: claims are tokens on 'pending' rows with an expiry.
  {
    table: "signal_outbox",
    column: "status",
    terminal: ["sent", "failed"],
    pending: ["pending"],
    inFlight: [],
    owner: "signal outbox dispatcher",
  },
  // src/jobs/runner.ts reconciles orphaned running jobs when it starts.
  {
    table: "jobs",
    column: "status",
    terminal: ["succeeded", "failed", "killed"],
    pending: ["pending"],
    inFlight: ["running"],
    owner: "job runner orphan reconciliation",
  },
  // No dispatcher in the tag leases these rows ('leased'/'sending' have no writer there and no
  // owner that resumes them); the tag's own retry requeues a row (mailbox/db.ts l.868-880,
  // calendar/db.ts l.1069-1080).
  {
    table: "mail_outbox",
    column: "status",
    terminal: ["sent", "acked", "failed", "dead"],
    pending: ["pending"],
    inFlight: [],
    blocking: ["leased", "sending"],
    owner: `mail outbox: ${SETTLE_EXIT}`,
  },
  {
    table: "calendar_outbox",
    column: "status",
    terminal: ["sent", "acked", "failed", "dead"],
    pending: ["pending"],
    inFlight: [],
    blocking: ["leased", "sending"],
    owner: `calendar outbox: ${SETTLE_EXIT}`,
  },
  {
    table: "cloud_delivery_items",
    column: "state",
    terminal: ["done", "skipped", "failed"],
    pending: ["pending"],
    inFlight: [],
    owner: "cloud delivery worker",
  },
];

/**
 * Tables of v3.261113.2 that hold no unit of accepted work: they record a delivery
 * that already happened or trace a unit another table owns. Listed in the evidence.
 */
export const LEGACY_RESIDUE_EXCLUSIONS: readonly { table: string; reason: string }[] = [
  { table: "session_turns", reason: "trace of turns; the unit of work is runtime_turn_attempts" },
  { table: "daemon_restart_resume_deliveries", reason: "log of resumes already delivered (delivered_at NOT NULL)" },
  {
    table: "reaction_actions",
    reason:
      "claim and completion commit in one SQLite transaction (tag policy/reaction-actions.ts l.132-176, this release l.139-176): every committed row is complete, none is in progress",
  },
  {
    table: "calendar_event_reminders",
    reason:
      "no writer or reader outside tests, in the tag or this release (calendar/db.ts l.286-298 create the table and its index only): a row holds no work any code does",
  },
  {
    table: "daemon_restart_session_snapshots",
    reason:
      "read by restartSnapshotResidue: the stop's epoch from restart-reason.txt, the successor's own eligibility and its 60-minute window",
  },
  { table: "approval_request_deliveries", reason: "log of approval messages already sent" },
  { table: "observer_delivery_events", reason: "log of observer events already delivered" },
  { table: "inbox_items", reason: "human inbox, not runtime work in flight" },
  // human-bridge/bridge.db
  {
    table: "gateway_receipts",
    reason: "bridge.db: idempotency cache of gateway operations already answered (status is the HTTP result)",
  },
  { table: "receipts", reason: "bridge.db: idempotency cache of bridge requests already answered" },
  { table: "replays", reason: "bridge.db: replay-protection ids with expiry, no work" },
  { table: "delegation_heads", reason: "bridge.db: delegation revisions, configuration" },
  { table: "conversations", reason: "bridge.db: conversation history" },
  { table: "messages", reason: "bridge.db: conversation history" },
  { table: "events", reason: "bridge.db: conversation event log" },
  { table: "audit", reason: "bridge.db: audit log" },
  { table: "enrollments", reason: "bridge.db: device enrollments, configuration" },
  { table: "state_schema_versions", reason: "bridge.db: schema bookkeeping" },
  {
    table: "approvals",
    reason:
      "bridge.db: decision records; an open approval belongs to an awaiting_approval turn, which the successor's bridge closes as interrupted_unknown, invalidating the approval (bridge/service.ts l.31-38, store.ts l.120-135)",
  },
  // Configuration, entity lifecycle and logs with a status column: no unit of accepted runtime
  // work lives in them; the unit that does (outbox, run, delivery) has its own rule.
  ...[
    "calendar_accounts",
    "calendar_calendars",
    "calendar_event_attendees",
    "calendar_events",
    "calendar_sync_cursors",
    "console_inbox_subscriptions",
    "contact_policies",
    "credential_connections",
    "credential_connections_file_backend",
    "mail_accounts",
    "mail_mailboxes",
    "mail_sync_cursors",
    "watches",
    "workflows",
    "runtime_credentials",
    "specs_index",
  ].map((table) => ({ table, reason: "configuration or definition state, not work in flight" })),
  ...[
    "artifacts",
    "artifact_versions",
    "knowledge_items",
    "crm_account_contacts",
    "crm_facts",
    "crm_opportunities",
    "crm_pipeline_stage_topics",
    "crm_pipeline_stages",
    "crm_pipelines",
    "crm_tasks",
    "chat_participants",
    "chat_messages",
    "contact_link_states",
    "threads",
    "tasks",
    "task_assignments",
    "session_goals",
    "session_goals_next",
    "decisions",
    "calendar_sync_conflicts",
  ].map((table) => ({
    table,
    reason: "durable entity lifecycle (people, records, long-lived tasks); a stop does not change it",
  })),
  ...[
    "artifact_events",
    "call_events",
    "cost_events",
    "credential_audit_events",
    "session_events",
    "pr_publication_events",
    "slack_automatic_output_decisions",
    "mail_attachments",
  ].map((table) => ({ table, reason: "append-only log or record metadata" })),
  { table: "mail_messages", reason: "message records; the delivery unit is mail_outbox, which has a rule" },
  { table: "signals", reason: "signal lifecycle; the delivery unit is signal_outbox, which has a rule" },
  { table: "cron_jobs", reason: "job definitions (last_status); the run unit is cron_runs, which has a rule" },
  {
    table: "session_followup_cadences",
    reason: "cadence definitions (last_status); the run unit is session_followup_runs, which has a rule",
  },
  { table: "task_observer_state", reason: "observer bookkeeping (last_status)" },
  // Work-like tables without a status column (read in the tag's writers).
  {
    table: "task_launch_plans",
    reason: "launch plans of tasks; execution is the task's session turn, which has rules",
  },
  { table: "task_operation_receipts", reason: "idempotency receipts of task operations already answered" },
  { table: "channel_outbound_publish_suppressions", reason: "suppression decisions of the publish outbox, records" },
  { table: "workflow_node_run_tasks", reason: "links between workflow node runs and tasks; the runs have rules" },
  { table: "runtime_turn_progress", reason: "progress trace of turns; the unit of work is runtime_turn_attempts" },
  // Owner or expiry columns that describe ownership of records or credentials, not work in flight.
  ...["crm_accounts", "crm_contact_profiles", "platform_identities", "session_participants", "chat_reading_lists"].map(
    (table) => ({ table, reason: "owner_id names who owns a record, not a process holding work" }),
  ),
  ...["contexts", "contexts_new"].map((table) => ({
    table,
    reason: "context keys with an expiry; a credential, not work",
  })),
  { table: "calendar_members", reason: "calendar membership with an expiry; configuration" },
  { table: "knowledge_marked_pages", reason: "pages marked for customers with an expiry; configuration" },
  {
    table: "slack_interaction_response_urls",
    reason: "Slack response URLs kept until they expire; a stop only lets them expire, as Slack does",
  },
  { table: "migrated", reason: "fixture of src/db/fixtures/schema-lock-worker.ts, never in a runtime database" },
  {
    table: "observer_bindings",
    reason: "observer binding configuration (last_delivered_at is a cursor); deliveries are observer_delivery_events",
  },
  {
    table: "runtime_boot_epochs",
    reason: "runtime incarnation bookkeeping; a stale active epoch of the stopped legacy is expected",
  },
  ...[
    "knowledge_gaps",
    "knowledge_write_approvals",
    "cloud_chat_questions",
    "cloud_link_requests",
    "credential_intake_requests",
    "approval_requests",
  ].map((table) => ({
    table,
    reason: "human-in-the-loop request: a pending one waits for a person, durably, and a stop does not change it",
  })),
];

/** A status union or `as const` list in the tag's source: every member must be classified by its rule. */
export type LegacyVocabulary = { file: string; declaration: string };

const NO_PROCESS_HOLDS_IT =
  "no claim or lease column: the row is the whole state, no process holds it, and nothing is lost when processes stop";

/**
 * Work tables of v3.261113.2 searched in every runtime database. Terminal values
 * come from the tag's own types; a value at rest by design carries its reason; a
 * value listed as blocking is labelled "resumption not verified" and has a
 * settle step in the RUNBOOK; a value outside the vocabulary blocks, labelled
 * "owner not verified". For each blocking value the comment names who writes
 * it, who resumes it (nobody), and the exit, in the tag and in this release.
 */
export const LEGACY_UNVERIFIED_RESIDUE_RULES: readonly Omit<ResidueRule, "database">[] = [
  // Writer: every status is the Devin API's (tag devin/client.ts l.1-10 type; upsert devin/store.ts
  // l.398-441, same in this release), written only by `ravi devin` commands (cli/commands/devin.ts
  // l.328-927 in both); no daemon loop reads or holds these rows. The session runs on Devin's side;
  // the row is a mirror that `ravi devin sessions sync <id>` refreshes in either release.
  {
    table: "devin_sessions",
    column: "status",
    vocabulary: { file: "src/devin/client.ts", declaration: "DevinSessionStatus" },
    terminal: ["exit", "error"],
    pending: ["suspended", "new", "creating", "claimed", "running", "resuming"],
    restReasons: {
      suspended: "paused on Devin's side; resuming is an explicit request, nothing runs meanwhile",
      new: "mirror of a Devin session; no daemon process holds it, `ravi devin sessions sync` refreshes it",
      creating: "mirror of a Devin session; no daemon process holds it, `ravi devin sessions sync` refreshes it",
      claimed: "mirror of a Devin session; no daemon process holds it, `ravi devin sessions sync` refreshes it",
      running:
        "runs on Devin's side; the row is a mirror no daemon process holds, `ravi devin sessions sync` refreshes it",
      resuming: "mirror of a Devin session; no daemon process holds it, `ravi devin sessions sync` refreshes it",
    },
    inFlight: [],
    anyDatabase: true,
    owner: "Devin sessions: mirror written only by `ravi devin` commands (cli/commands/devin.ts l.328-927)",
  },
  // Writer (tag automations.ts l.474-581): claimed, then finalized as skipped, spawned or failed in
  // the same flow. A `claimed` row outlives only a process that died between the two.
  {
    table: "task_automation_runs",
    column: "status",
    vocabulary: { file: "src/tasks/types.ts", declaration: "TaskAutomationRunStatus" },
    terminal: ["spawned", "skipped", "failed"],
    pending: [],
    inFlight: [],
    blocking: ["claimed"],
    unverified: true,
    anyDatabase: true,
    // Writer: claim tasks/automations.ts l.474, finalize tasks/automations-db.ts l.478-484 (status,
    // spawned_task_id, message, updated_at), same in this release; nothing re-reads a `claimed` row.
    owner: `task automations: a claim of a process that died before finalizing; ${SETTLE_EXIT}`,
  },
  {
    table: "call_requests",
    column: "status",
    vocabulary: { file: "src/prox/calls/types.ts", declaration: "CallRequestStatus" },
    terminal: ["completed", "failed", "canceled"],
    pending: ["pending", "scheduled", "snoozed", "blocked"],
    restReasons: {
      pending: `waiting for the call dispatcher; ${NO_PROCESS_HOLDS_IT}`,
      scheduled: `waiting for its due time; ${NO_PROCESS_HOLDS_IT}`,
      snoozed: `waiting for its snooze time; ${NO_PROCESS_HOLDS_IT}`,
      blocked: `waiting for an operator or a rule to allow it; ${NO_PROCESS_HOLDS_IT}`,
    },
    inFlight: [],
    blocking: ["running"],
    unverified: true,
    anyDatabase: true,
    // Writer: prox/calls/index.ts l.291-323 (running for the dial, closed by its result), status
    // writer calls-db.ts l.831-834 (status, updated_at); same in this release.
    owner: `prox calls: ${CALL_EXIT}`,
  },
  {
    table: "call_runs",
    column: "status",
    vocabulary: { file: "src/prox/calls/types.ts", declaration: "CallRunStatus" },
    terminal: ["completed", "no_answer", "busy", "voicemail", "failed", "canceled"],
    pending: [],
    inFlight: [],
    blocking: ["queued", "dialing", "ringing", "in_progress"],
    unverified: true,
    anyDatabase: true,
    // Writer: calls-db.ts l.872-899 (status, started_at/answered_at/ended_at, failure_reason), from
    // the dial (agora.ts l.482, provider.ts l.148) and the provider's webhooks; same in this release.
    owner: `prox call runs: ${CALL_EXIT}`,
  },
  // Writer (tag tool-bridge.ts l.400-429): a policy refusal creates the row `blocked`, records the
  // reason, emits tool.blocked and returns; nothing writes `blocked` again. It is final.
  {
    table: "call_tool_runs",
    column: "status",
    vocabulary: { file: "src/prox/calls/types.ts", declaration: "CallToolRunStatus" },
    terminal: ["completed", "failed", "timeout", "blocked"],
    pending: [],
    inFlight: [],
    blocking: ["pending", "running"],
    unverified: true,
    anyDatabase: true,
    // Writer: calls-db.ts l.1665-1681 (status, completed_at, duration_ms, error_message), from the
    // tool bridge of a live call (tool-bridge.ts); same in this release.
    owner: `prox call tools: ${CALL_EXIT}`,
  },
  {
    table: "workflow_runs",
    column: "status",
    vocabulary: { file: "src/workflows/types.ts", declaration: "WorkflowRunStatus" },
    terminal: ["done", "failed", "cancelled", "archived"],
    pending: ["draft", "waiting", "blocked"],
    restReasons: {
      draft: `not started; ${NO_PROCESS_HOLDS_IT}`,
      waiting: `waiting for an event or a person; ${NO_PROCESS_HOLDS_IT}`,
      blocked: `waiting to be unblocked; ${NO_PROCESS_HOLDS_IT}`,
    },
    inFlight: ["ready", "running"],
    anyDatabase: true,
    owner:
      "workflow runs: derived from their tasks and recomputed by this release (workflows/service.ts l.243-265, l.341-360, l.442-497); the tasks carry the work",
  },
  {
    table: "workflow_node_runs",
    column: "status",
    vocabulary: { file: "src/workflows/types.ts", declaration: "WorkflowNodeRunStatus" },
    terminal: ["done", "failed", "skipped", "cancelled", "archived"],
    pending: ["pending", "awaiting_release", "blocked"],
    restReasons: {
      pending: `waiting for its predecessors; ${NO_PROCESS_HOLDS_IT}`,
      awaiting_release: `waiting for a manual release; ${NO_PROCESS_HOLDS_IT}`,
      blocked: `waiting to be unblocked; ${NO_PROCESS_HOLDS_IT}`,
    },
    inFlight: ["ready", "running"],
    anyDatabase: true,
    owner:
      "workflow node runs: derived from their tasks and recomputed by this release (workflows/service.ts l.243-265, l.341-360, l.442-497); the tasks carry the work",
  },
  {
    table: "cloud_thread_runs",
    column: "status",
    vocabulary: { file: "src/cloud-agents/types.ts", declaration: "CLOUD_RUN_STATUSES" },
    terminal: ["completed", "failed", "stopped", "budget_exceeded"],
    pending: ["waiting_approval", "waiting_input"],
    restReasons: {
      waiting_approval: "the cloud run waits for a person's approval; the run lives in the Console, not in this daemon",
      waiting_input: "the cloud run waits for a person's input; the run lives in the Console, not in this daemon",
    },
    inFlight: ["starting", "running"],
    anyDatabase: true,
    // Writer: cloud-agents/delivery-runner.ts l.514-533 applies each status event of the run
    // (chat-db.ts l.655-690); events arrive as Console inbox items recorded before they are
    // acknowledged (delivery-runner.ts l.150-170), so the successor applies what came during the stop.
    owner:
      "cloud thread runs: the Console keeps the run; this release's delivery runner applies its next status events",
  },
  // Writer (tag credential-store.ts l.552 reserved, l.582 started, completed by the same process).
  {
    table: "runtime_credential_attempts",
    column: "status",
    vocabulary: { file: "src/runtime/credential-store.ts", declaration: "RuntimeCredentialAttemptStatus" },
    terminal: ["succeeded", "failed", "abandoned"],
    pending: ["reserved", "started"],
    restReasons: {
      reserved:
        "a record of an attempt, not work: the turn it belongs to is carried by runtime_turn_attempts and the restart snapshots; an open row only biases the pool's order (credential-pool.ts l.52)",
      started:
        "a record of an attempt, not work: the legacy stop does not wait for the turn's finally that abandons it (bot.ts l.192, l.212-223), so every stop with a turn in flight leaves one; the turn is carried elsewhere, and an open row only biases the pool's order (credential-pool.ts l.52)",
    },
    inFlight: [],
    anyDatabase: true,
    owner:
      "runtime credential attempts: records; the RUNBOOK cleanup closes them as the tag's abandon writer does (optional)",
  },
  // Writer (tag apply-grant.ts l.383-398 and l.504-541): `applying` on begin, `done` on success,
  // in the same call; the key comes from an approval click (approval/service.ts l.958). Nothing in
  // the tag or the successor settles an `applying` row whose process died.
  {
    table: "permission_grant_applications",
    column: "status",
    terminal: ["done"],
    pending: [],
    inFlight: [],
    blocking: ["applying"],
    unverified: true,
    anyDatabase: true,
    owner: `permission grants: a grant whose process died before done; ${SETTLE_EXIT}`,
  },
  // Writers (tag): `sessions send --thread` inserts `queued` before the send (sessions.ts
  // l.4906-4908, threads/service.ts l.611-650) and marks delivered or failed only after waiting for
  // the reply (sessions.ts ~l.4945-5046); task dispatch (tasks/dispatch-admission.ts l.45-97) marks
  // delivered after publishing and never failed. Nothing else settles a `queued` row, in the tag or
  // in the successor (recoverActiveTasksAfterRestart has no caller).
  {
    table: "thread_handoffs",
    column: "status",
    terminal: ["delivered", "failed"],
    pending: [],
    inFlight: [],
    blocking: ["queued"],
    unverified: true,
    anyDatabase: true,
    owner: `thread handoffs: a handoff whose command or dispatch died has an unknown outcome; ${SETTLE_EXIT}`,
  },
  // Writers (tag): requests.ts l.240-248 `open` (sent); request-runner.ts l.445-452 `queued`,
  // l.514-522 `running`, l.531 `answered`, l.386/536/561-566 `failed`/`closed`, l.409-425 Console
  // statuses answered/failed/expired. Successor (HEAD request-runner.ts l.321-323, 353-354): its
  // first run after a restart fails every received request left `queued` or `running`.
  {
    table: "library_agent_requests",
    column: "status",
    terminal: ["answered", "failed", "closed", "expired"],
    pending: ["open"],
    restReasons: {
      open: "a sent request waits for its reply; the successor's request runner pulls replies from the Console (request-runner.ts l.325-329)",
    },
    inFlight: ["queued", "running"],
    anyDatabase: true,
    owner: "library request runner: interrupted received requests are failed on its first run after a restart",
  },
  // Writer (tag cloud-agents/chat-db.ts l.369-386, same in dev): a click claims the row `deciding`
  // with decided_at; the open-approval query of both releases treats a claim older than
  // CLOUD_CHAT_APPROVAL_CLAIM_TTL_MS (2 min, l.278) as open again. A claim of a stopped process is
  // therefore an approval that waits for a person; blocking on it would block for good.
  {
    table: "cloud_chat_approvals",
    column: "status",
    terminal: ["approved", "denied", "closed"],
    pending: ["pending", "deciding"],
    restReasons: {
      pending: "waits for a person's decision; nothing runs until then",
      deciding:
        "a click's claim; its process stopped, and the open-approval query reopens the approval 2 min after decided_at (chat-db.ts l.369), so it waits for a person",
    },
    inFlight: [],
    anyDatabase: true,
    owner: "cloud chat approvals (chat-db.ts l.369-386): open approvals wait for a person",
  },
  // A clean legacy stop keeps `running` by design (tag session-adapter-bus.ts l.801, daemon.ts
  // l.323-324). The successor's startDaemon (HEAD daemon.ts l.593) starts the adapter bus, whose
  // start() lists every adapter and restarts those left `running`; a missing session marks it
  // `broken` (HEAD session-adapter-bus.ts l.705-778).
  {
    table: "session_adapters",
    column: "status",
    terminal: ["configured", "stopped", "broken"],
    pending: [],
    inFlight: ["running"],
    anyDatabase: true,
    owner: "session adapter bus start() of the successor restarts adapters left running",
  },
  // Restart snapshots are not a rule: restartSnapshotResidue (below) reads the stop's own epoch from
  // restart-reason.txt and applies the successor's eligibility and its 60-minute window.
  // Writer of `queued`: thread-lifecycle-store.ts l.157 (insert, both releases); it becomes
  // `root_delivered` when the outbound consumer delivers the root (outbound-consumer.ts l.1266 →
  // store l.234-266), and that job is counted in the outbound residue. `root_delivered`, and
  // `starting` once its 60 s creation claim expires (store l.269-299), are resumed by this release's
  // gateway reconciliation at boot and every 30 s (gateway.ts l.84, l.436, l.441 →
  // thread-lifecycle.ts l.213-231 → listPendingSlackThreadCreations, store l.391-410 →
  // finalizeSlackThreadCreation l.154-159). Tag: thread-lifecycle.ts l.220, gateway.ts l.1057.
  {
    table: "slack_thread_lifecycle",
    column: "status",
    terminal: ["open", "closed", "failed"],
    pending: [],
    inFlight: ["queued", "root_delivered", "starting"],
    anyDatabase: true,
    owner:
      "slack thread creation: queued waits for its root's outbound delivery; root_delivered and starting (claim expired) are resumed by the gateway reconciliation (thread-lifecycle.ts l.213-231)",
  },
  // A derived observation, not work. Its only writer is the gateway reconciliation, at boot and every
  // 30 s, which recomputes each candidate (thread-lifecycle.ts l.283-300 →
  // saveThreadTurnHealth(observeThreadTurn(...)), candidates thread-turn-health-store.ts l.138-150;
  // tag: store l.44-74, thread-lifecycle.ts l.251-252, l.283-291). The turn it observes is carried by
  // runtime_turn_attempts and the restart snapshots.
  {
    table: "slack_thread_turn_health",
    column: "state",
    terminal: ["idle", "interrupted", "attention", "closed"],
    pending: [],
    inFlight: ["running"],
    anyDatabase: true,
    owner: "slack thread turn health: recomputed by the gateway reconciliation of this release at boot and every 30 s",
  },
  // Writer: thread-attention-admission.ts (tag l.109-155, this release l.112-170). Admission takes a
  // `pending` or `refused` row (l.132), writes `accepting`, and closes it as admitted, refused or
  // uncertain only `WHERE admission_status = 'accepting'` in the same process; no lease replays it.
  // `pending` is sent again by the turn-health notice claim while its turn stays in attention
  // (thread-turn-health-store.ts l.79-103); `refused` (capacity) is admitted again when its prompt is
  // delivered again. `accepting` of a dead process has no owner in either release: settle step
  // (`uncertain`, the tag's own value for an outcome nobody can know).
  {
    table: "slack_thread_attention_notices",
    column: "admission_status",
    terminal: ["admitted", "uncertain"],
    pending: ["pending", "refused"],
    restReasons: {
      pending:
        "sent again by the turn-health notice claim while its turn stays in attention (thread-turn-health-store.ts l.79-103); moot once the turn leaves attention",
      refused: "a capacity refusal; admission takes it again when its prompt is delivered again (l.132)",
    },
    inFlight: [],
    blocking: ["accepting"],
    anyDatabase: true,
    owner: `slack attention notices: an admission whose process died has an unknown outcome; ${SETTLE_EXIT}`,
  },
  // Tables whose work is expressed without a status column (read in the tag's writers).
  {
    table: "pr_publication_leases",
    column: "expires_at",
    terminal: [],
    pending: [],
    inFlight: [],
    condition: { where: "expires_at > ?", usesNow: true, outcome: "blocking", deadline: "expires_at" },
    anyDatabase: true,
    owner:
      "pr publish lease (src/pr/journal.ts l.52-54): an unexpired lease may belong to a running publication, an expired one is taken over; exit: wait for expires_at, then retry",
  },
  {
    table: "console_inbox_poll_locks",
    column: "expires_at",
    terminal: [],
    pending: [],
    inFlight: [],
    condition: { where: "expires_at > ?", usesNow: true, outcome: "blocking", deadline: "expires_at" },
    anyDatabase: true,
    owner:
      "console inbox poll lock (src/inbox/inbox-db.ts l.239-257): an unexpired lock may be held, an expired one is taken over; exit: wait for expires_at, then retry",
  },
  {
    table: "console_inbox_items",
    column: "delivered_at",
    terminal: [],
    pending: [],
    inFlight: [],
    condition: { where: "delivered_at IS NULL", outcome: "pending" },
    anyDatabase: true,
    owner: "console inbox delivery: an undelivered item is a row with no holder (holding is console_inbox_poll_locks)",
  },
];

/** human-bridge/bridge.db of v3.261113.2 (src/bridge/store.ts), a separate database. */
export const LEGACY_BRIDGE_RESIDUE_RULES: readonly Omit<ResidueRule, "database">[] = [
  // turns.status is free text; the schema's own partial index `active_turn` in
  // src/bridge/store.ts (status IN ('queued','running','awaiting_approval')) defines what is active.
  // Owner, the same code in the tag and this release (bridge/service.ts l.31-66): start() closes
  // every `running` and `awaiting_approval` turn as `interrupted_unknown` and never replays it, as
  // any restart of the tag already does (the pending approval is invalidated, store.ts l.120-135);
  // the 250 ms tick starts a `queued` turn whose authority is still valid, or closes it as
  // `authorization_expired`.
  {
    table: "turns",
    column: "status",
    terminal: [],
    pending: [],
    inFlight: ["queued", "running", "awaiting_approval"],
    terminalComplement: true,
    owner:
      "human bridge of this release: start() closes running and awaiting_approval as interrupted_unknown, the tick starts or expires queued (bridge/service.ts l.31-66)",
  },
];

/** `human-bridge/bridge.db` next to the router database, as src/bridge/store.ts places it. */
export function legacyBridgeDatabasePath(routerDatabasePath: string): string {
  return join(dirname(routerDatabasePath), "human-bridge", "bridge.db");
}

/** Router rules read `ravi.db`; bridge rules read `human-bridge/bridge.db` (absent database: no work). */
export function legacyResidueRules(
  routerDatabasePath: string,
  bridgeDatabasePath?: string,
  otherDatabasePaths: readonly string[] = [],
): ResidueRule[] {
  const everyDatabase = [
    ...new Set([routerDatabasePath, ...(bridgeDatabasePath ? [bridgeDatabasePath] : []), ...otherDatabasePaths]),
  ];
  return [
    ...LEGACY_ROUTER_RESIDUE_RULES.map((rule) => ({ ...rule, database: routerDatabasePath })),
    ...(bridgeDatabasePath
      ? LEGACY_BRIDGE_RESIDUE_RULES.map((rule) => ({ ...rule, database: bridgeDatabasePath }))
      : []),
    ...LEGACY_UNVERIFIED_RESIDUE_RULES.flatMap((rule) => everyDatabase.map((database) => ({ ...rule, database }))),
  ];
}

const identifier = /^[a-z_][a-z0-9_]*$/;

/** Read-only classification. Never initializes, migrates or changes a journal mode. */
export function collectSqliteResidue(rules: readonly ResidueRule[]): DurableResidue {
  const sources: DurableResidueSource[] = [];
  const unknown: string[] = [];
  const handles = new Map<string, Database>();
  try {
    for (const rule of rules) {
      const label = rule.anyDatabase
        ? `${basename(rule.database)}:${rule.table}.${rule.column}`
        : `${rule.table}.${rule.column}`;
      if (!identifier.test(rule.table) || !identifier.test(rule.column)) {
        unknown.push(`${label}: invalid rule`);
        continue;
      }
      if (!existsSync(rule.database)) {
        // A database that was never created holds no accepted work of this kind.
        sources.push({ source: label, pending: 0, inFlight: 0, detail: { database: "absent" } });
        continue;
      }
      let database = handles.get(rule.database);
      try {
        if (!database) {
          database = openStateReadOnly(rule.database);
          handles.set(rule.database, database);
        }
        const exists = database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(rule.table);
        if (!exists) {
          // Tables are created on first use; an absent table persisted no work of this kind.
          sources.push({ source: label, pending: 0, inFlight: 0, detail: { table: "absent" } });
          continue;
        }
        if (rule.anyDatabase) {
          const columns = database.query(`PRAGMA table_info(${rule.table})`).all() as { name: string }[];
          if (!columns.some((column) => column.name === rule.column)) {
            // Same name, another table: the inventoried one has this column.
            sources.push({ source: label, pending: 0, inFlight: 0, detail: { column: "absent" } });
            continue;
          }
        }
        if (rule.condition) {
          const deadline = rule.condition.deadline;
          if (deadline && !identifier.test(deadline)) throw new Error(`invalid deadline column ${deadline}`);
          const statement = database.query(
            `SELECT COUNT(*) AS count${deadline ? `, MAX(${deadline}) AS deadline` : ""} FROM ${rule.table} WHERE ${rule.condition.where}`,
          );
          const { count, deadline: until } = (rule.condition.usesNow ? statement.get(Date.now()) : statement.get()) as {
            count: number;
            deadline?: number | null;
          };
          if (rule.condition.outcome === "blocking" && count > 0)
            unknown.push(
              typeof until === "number"
                ? `${label}: ${count} row(s) where ${rule.condition.where}: wait until ${new Date(until).toISOString()} (the latest ${deadline}), then retry; ${rule.owner}`
                : `${label}: ${count} row(s) where ${rule.condition.where}: ${rule.owner}`,
            );
          sources.push({
            source: label,
            pending: rule.condition.outcome === "pending" ? count : 0,
            inFlight: 0,
            detail: { owner: rule.owner, where: rule.condition.where, count },
          });
          continue;
        }
        const rows = database
          .query(`SELECT ${rule.column} AS status, COUNT(*) AS count FROM ${rule.table} GROUP BY ${rule.column}`)
          .all() as { status: unknown; count: number }[];
        let pending = 0;
        let inFlight = 0;
        const counts: Record<string, number> = {};
        for (const row of rows) {
          const status = typeof row.status === "string" ? row.status : String(row.status);
          counts[status] = row.count;
          if (rule.terminal.includes(status)) continue;
          if (rule.pending.includes(status)) pending += row.count;
          else if (rule.inFlight.includes(status)) inFlight += row.count;
          else if (rule.blocking?.includes(status))
            unknown.push(`${label}=${status} (${row.count}): resumption not verified`);
          else if (!rule.terminalComplement)
            unknown.push(`${label}=${status} (${row.count})${rule.unverified ? ": owner not verified" : ""}`);
        }
        sources.push({ source: label, pending, inFlight, detail: { owner: rule.owner, counts } });
      } catch (cause) {
        // no-cause: An unreadable table is recorded as unknown residue, which blocks adoption with this message.
        unknown.push(`${label}: unreadable (${cause instanceof Error ? cause.message : String(cause)})`);
      }
    }
  } finally {
    for (const database of handles.values()) database.close();
  }
  return { sources, unknown };
}

/** Where both releases keep the restart reason (tag daemon.ts l.131, this release l.134). */
export const RESTART_REASON_FILE = join(homedir(), ".ravi", "restart-reason.txt");
/** The successor resumes a stop's sessions only this long after the stop (daemon.ts l.135, l.686). */
export const RESTART_RESUME_WINDOW_MS = 60 * 60 * 1000;
/**
 * Time the successor may still need, after its own residue read, to reach the resume
 * (`notifyRestartReason`): its boot, including this release's schema migrations on the legacy
 * database. Not measured on a production-size database; chosen to cover a slow boot.
 */
export const RESTART_RESUME_MARGIN_MS = 10 * 60 * 1000;

/** The epoch the successor will resume, read as `readRestartReasonInfo` does; null when it would start a new one. */
export function readRestartEpoch(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { reason?: unknown; restartEpoch?: unknown };
    if (!parsed.reason || typeof parsed.restartEpoch !== "string" || !parsed.restartEpoch) return null;
    return parsed.restartEpoch;
  } catch {
    // no-cause: Text that is not JSON gets a new epoch from the daemon (daemon.ts readRestartReasonInfo), which resumes nothing.
    return null;
  }
}

/**
 * Sessions the legacy stop left for the successor's restart resume (tag daemon.ts l.249-272 writes
 * the epoch to restart-reason.txt first and synchronously; bot.ts l.179-185 then snapshots every
 * non-idle session, inside bot.stop, after an await).
 * The successor resumes only the epoch named in that file, only rows it finds eligible, and only
 * within 60 minutes of the stop (router-db.ts l.7123-7152, daemon.ts l.660-700). This applies the
 * same eligibility: within the window, minus the margin, the sessions are in flight with that
 * owner; past it they are unknown, because nobody would resume them. Without a readable epoch the
 * successor starts a new one and resumes nothing: every undelivered snapshot written by this stop is
 * unknown, whatever its age. This stop's snapshots are those at or after the start of the daemon
 * process the adoption stopped (`stoppedProcessStartedAt`, from the adoption record): a process
 * writes snapshots only when it stops. Without that time (no adoption record yet) the last 60 minutes
 * stand in for it.
 */
export function restartSnapshotResidue(input: {
  databasePath: string;
  restartReasonPath?: string;
  now?: number;
  windowMs?: number;
  marginMs?: number;
  /** startedAt of the daemon process this adoption stopped (adoption.predecessors, name "ravi"). */
  stoppedProcessStartedAt?: number;
}): DurableResidue {
  const label = "daemon_restart_session_snapshots";
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? RESTART_RESUME_WINDOW_MS;
  const marginMs = input.marginMs ?? RESTART_RESUME_MARGIN_MS;
  if (!existsSync(input.databasePath))
    return { sources: [{ source: label, pending: 0, inFlight: 0, detail: { database: "absent" } }], unknown: [] };
  let database: Database | null = null;
  try {
    database = openStateReadOnly(input.databasePath);
    const exists = database
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daemon_restart_session_snapshots'")
      .get();
    if (!exists)
      return { sources: [{ source: label, pending: 0, inFlight: 0, detail: { table: "absent" } }], unknown: [] };
    const hasDeliveries = Boolean(
      database
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daemon_restart_resume_deliveries'")
        .get(),
    );
    const notDelivered = hasDeliveries
      ? `AND NOT EXISTS (SELECT 1 FROM daemon_restart_resume_deliveries d
           WHERE d.restart_epoch = s.restart_epoch AND d.session_key = s.session_key)`
      : "";
    // The successor's eligibility without the window (router-db.ts l.7135-7148).
    const eligible = `FROM daemon_restart_session_snapshots s
      JOIN sessions live ON live.session_key = s.session_key
      WHERE s.non_idle = 1
        AND (live.ephemeral = 0 OR live.expires_at IS NULL OR live.expires_at > ?)
        ${notDelivered}`;
    const epoch = readRestartEpoch(input.restartReasonPath ?? RESTART_REASON_FILE);
    const startedAt = input.stoppedProcessStartedAt;
    // Without an epoch the start time is the only bound; a record whose start time is not a positive
    // integer cannot tell this stop's snapshots from older ones, so it is refused, not guessed.
    if (!epoch && startedAt !== undefined && !(Number.isSafeInteger(startedAt) && startedAt > 0))
      return {
        sources: [],
        unknown: [
          `${label}: restart-reason.txt names no epoch and the adoption record gives the stopped daemon a start time that is not a positive integer (${String(startedAt)}): this stop's snapshots cannot be told from older ones`,
        ],
      };
    const row = (
      epoch
        ? database
            .query(
              `SELECT COUNT(*) AS sessions, COALESCE(SUM(s.pending_message_count), 0) AS messages,
                 MIN(s.stopped_at) AS stoppedAt ${eligible} AND s.restart_epoch = ?`,
            )
            .get(now, epoch)
        : database
            .query(
              `SELECT COUNT(*) AS sessions, COALESCE(SUM(s.pending_message_count), 0) AS messages,
                 MIN(s.stopped_at) AS stoppedAt ${eligible} AND s.stopped_at >= ?`,
            )
            .get(now, input.stoppedProcessStartedAt ?? now - windowMs)
    ) as { sessions: number; messages: number; stoppedAt: number | null };
    const detail = { epoch, sessions: row.sessions, pendingMessages: row.messages, stoppedAt: row.stoppedAt };
    if (row.sessions === 0) return { sources: [{ source: label, pending: 0, inFlight: 0, detail }], unknown: [] };
    if (!epoch)
      return {
        sources: [{ source: label, pending: 0, inFlight: 0, detail }],
        unknown: [
          `${label}: ${row.sessions} session(s) ${input.stoppedProcessStartedAt === undefined ? "stopped in the last 60 min" : "snapshotted by this adoption's stop"} and not resumed, but restart-reason.txt names no epoch: the successor would start a new epoch and resume none of them`,
        ],
      };
    const stoppedAt = row.stoppedAt ?? 0;
    if (stoppedAt + windowMs - marginMs < now)
      return {
        sources: [{ source: label, pending: 0, inFlight: 0, detail }],
        unknown: [
          `${label}: ${row.sessions} session(s) of epoch ${epoch} (${row.messages} pending message(s)), stopped at ${new Date(stoppedAt).toISOString()}, are past the ${windowMs / 60_000}-minute resume window less ${marginMs / 60_000} min of margin: the successor would not resume them`,
        ],
      };
    return {
      sources: [
        {
          source: label,
          pending: 0,
          inFlight: row.sessions,
          detail: {
            ...detail,
            owner: `restart resume of the successor (epoch ${epoch}), until ${new Date(stoppedAt + windowMs - marginMs).toISOString()}`,
          },
        },
      ],
      unknown: [],
    };
  } catch (cause) {
    // no-cause: An unreadable table is recorded as unknown residue, which blocks adoption with this message.
    return {
      sources: [],
      unknown: [`${label}: unreadable (${cause instanceof Error ? cause.message : String(cause)})`],
    };
  } finally {
    database?.close();
  }
}

/** Reads broker state; `null` means the stream or consumer does not exist. */
export type JetStreamResidueReader = {
  streamMessages(stream: string): Promise<number | null>;
  consumerPending(stream: string, consumer: string): Promise<{ pending: number; ackPending: number } | null>;
};

export type JetStreamResidueRule =
  | { kind: "workqueue-durable" | "workqueue-ephemeral"; stream: string; owner: string }
  | { kind: "consumer"; stream: string; consumer: string; owner: string };

/** Streams and consumers of v3.261113.2 (session-stream, outbound-stream, omni consumer). */
export const LEGACY_JETSTREAM_RESIDUE_RULES: readonly JetStreamResidueRule[] = [
  // Memory storage with a 60 s max age: a prompt left here when the daemon stops is not durable.
  { kind: "workqueue-ephemeral", stream: "SESSION_PROMPTS", owner: "daemon prompt subscription" },
  // File storage, 7 day max age: every remaining message is redelivered to the successor.
  { kind: "workqueue-durable", stream: "CHANNEL_OUTBOUND", owner: "channel outbound consumer" },
  { kind: "consumer", stream: "MESSAGE", consumer: "ravi-messages", owner: "omni consumer" },
  { kind: "consumer", stream: "INSTANCE", consumer: "ravi-instances", owner: "omni consumer" },
  { kind: "consumer", stream: "REACTION", consumer: "ravi-reactions", owner: "omni consumer" },
];

export async function collectJetStreamResidue(
  reader: JetStreamResidueReader,
  rules: readonly JetStreamResidueRule[] = LEGACY_JETSTREAM_RESIDUE_RULES,
): Promise<DurableResidue> {
  const sources: DurableResidueSource[] = [];
  const unknown: string[] = [];
  for (const rule of rules) {
    const label = rule.kind === "consumer" ? `jetstream:${rule.stream}/${rule.consumer}` : `jetstream:${rule.stream}`;
    try {
      if (rule.kind === "consumer") {
        const state = await reader.consumerPending(rule.stream, rule.consumer);
        if (!state) {
          sources.push({ source: label, pending: 0, inFlight: 0, detail: { consumer: "absent" } });
          continue;
        }
        // Ack-pending messages are redelivered after ack_wait: durable, owned by the successor's consumer.
        sources.push({
          source: label,
          pending: state.pending,
          inFlight: state.ackPending,
          detail: { owner: rule.owner },
        });
        continue;
      }
      const messages = await reader.streamMessages(rule.stream);
      if (messages === null) {
        sources.push({ source: label, pending: 0, inFlight: 0, detail: { stream: "absent" } });
        continue;
      }
      if (rule.kind === "workqueue-ephemeral" && messages > 0) {
        unknown.push(`${label}: ${messages} prompt(s) in memory storage expire in 60 s and are not durable`);
        continue;
      }
      sources.push({ source: label, pending: messages, inFlight: 0, detail: { owner: rule.owner } });
    } catch (cause) {
      // no-cause: An unreadable broker source is recorded as unknown residue, which blocks adoption with this message.
      unknown.push(`${label}: unreadable (${cause instanceof Error ? cause.message : String(cause)})`);
    }
  }
  return { sources, unknown };
}

export function mergeResidue(...parts: DurableResidue[]): DurableResidue {
  return {
    sources: parts.flatMap((part) => part.sources),
    unknown: parts.flatMap((part) => part.unknown),
  };
}
