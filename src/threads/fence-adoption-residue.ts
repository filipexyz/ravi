import { existsSync } from "node:fs";
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
};

/**
 * Status sets of v3.261113.2: CHECK constraints where the schema has them
 * (src/router/router-db.ts, jobs, mail/calendar outbox, cloud deliveries) and the
 * writers where the column is free text (decisions, signals).
 */
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
  // The next three are closed by their CHECK constraints and nothing reconciles
  // them at boot, in the tag or in the successor. cron_runs moves only through
  // settleCronRun when its own session reports (cron/run-db.ts l.47-54);
  // channel_backend_runtime_state is written per turn (router-db.ts ~l.7595-7640).
  // channel_outbound_receipts: a claimed receipt whose lease expired is taken by
  // another owner (pid:uuid, outbound-consumer.ts l.455) when resend_prohibited = 0
  // (outbound-receipts.ts l.251-262), driven by the job's redelivery from the
  // CHANNEL_OUTBOUND stream; with resend_prohibited = 1 it is never resent.
  // Decision (operator): these non-terminal rows block. A stale-row criterion may
  // only come in its own change, backed by a read-only collection over a copy of
  // the production database.
  {
    table: "channel_outbound_receipts",
    column: "state",
    terminal: ["complete", "suppressed"],
    pending: [],
    inFlight: [],
    blocking: ["claimed", "sent", "persisted"],
    owner: "channel outbound claim owner (non-terminal receipts block)",
  },
  {
    table: "channel_backend_runtime_state",
    column: "state",
    terminal: ["completed", "failed", "interrupted"],
    pending: [],
    inFlight: [],
    blocking: ["accepted", "running", "waiting_approval"],
    owner: "channel backend runtime (non-terminal turns block)",
  },
  {
    table: "cron_runs",
    column: "status",
    terminal: ["ok", "error"],
    pending: [],
    inFlight: [],
    blocking: ["pending"],
    owner: "cron run settled by its own session outcome (unfinished runs block)",
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
  // No dispatcher in the legacy daemon leases these rows, so 'leased' and 'sending'
  // have no owner that resumes them here: they stay outside the rule and block.
  {
    table: "mail_outbox",
    column: "status",
    terminal: ["sent", "acked", "failed", "dead"],
    pending: ["pending"],
    inFlight: [],
    blocking: ["leased", "sending"],
    owner: "mail outbox (explicit retry)",
  },
  {
    table: "calendar_outbox",
    column: "status",
    terminal: ["sent", "acked", "failed", "dead"],
    pending: ["pending"],
    inFlight: [],
    blocking: ["leased", "sending"],
    owner: "calendar outbox (explicit retry)",
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
    reason: "bridge.db: decision records; an open approval belongs to an awaiting_approval turn, which blocks",
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

/** Statuses read as terminal for work tables whose resumption was not verified; anything else blocks. */
const UNVERIFIED_TERMINAL = [
  "complete",
  "completed",
  "done",
  "succeeded",
  "success",
  "ok",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "aborted",
  "abandoned",
  "expired",
  "closed",
  "dead",
  "rejected",
  "denied",
  "superseded",
  "skipped",
  "sent",
  "delivered",
  "applied",
  "resolved",
] as const;

/**
 * Work tables of v3.261113.2 whose resumption in the successor was not verified.
 * Each is searched in every runtime database; a row in any status outside its
 * terminal set blocks, labelled "owner not verified".
 */
export const LEGACY_UNVERIFIED_RESIDUE_RULES: readonly Omit<ResidueRule, "database">[] = [
  ...[
    "call_requests",
    "call_runs",
    "call_tool_runs",
    "task_automation_runs",
    "workflow_runs",
    "workflow_node_runs",
    "cloud_thread_runs",
    "devin_sessions",
    "library_agent_requests",
    "thread_handoffs",
    "permission_grant_applications",
    "runtime_credential_attempts",
    "calendar_event_reminders",
  ].map((table) => ({
    table,
    column: "status",
    terminal: UNVERIFIED_TERMINAL,
    pending: [],
    inFlight: [],
    unverified: true,
    anyDatabase: true,
    owner: "not verified: non-terminal rows block",
  })),
  {
    table: "cloud_chat_approvals",
    column: "status",
    terminal: ["approved", "denied", "closed"],
    pending: ["pending"],
    inFlight: [],
    blocking: ["deciding"],
    anyDatabase: true,
    owner: "cloud chat approvals: pending waits for a person; a decision in progress blocks",
  },
  {
    table: "session_adapters",
    column: "status",
    terminal: ["configured", "stopped", "broken"],
    pending: [],
    inFlight: [],
    blocking: ["running"],
    anyDatabase: true,
    owner: "session adapters: a running adapter at stop blocks (restart by the successor not verified)",
  },
  {
    table: "slack_thread_lifecycle",
    column: "status",
    terminal: ["open", "closed", "failed"],
    pending: [],
    inFlight: [],
    blocking: ["queued", "root_delivered", "starting"],
    anyDatabase: true,
    owner: "slack thread creation: a thread being created blocks (claim resumption not verified)",
  },
  {
    table: "slack_thread_turn_health",
    column: "state",
    terminal: ["idle", "interrupted", "attention", "closed"],
    pending: [],
    inFlight: [],
    blocking: ["running"],
    anyDatabase: true,
    owner: "slack thread turn health: a running turn blocks (resumption not verified)",
  },
  {
    table: "slack_thread_attention_notices",
    column: "admission_status",
    terminal: ["admitted", "refused", "uncertain"],
    pending: [],
    inFlight: [],
    blocking: ["pending", "accepting"],
    anyDatabase: true,
    owner: "slack attention notices: an admission in progress blocks (resumption not verified)",
  },
];

/** human-bridge/bridge.db of v3.261113.2 (src/bridge/store.ts), a separate database. */
export const LEGACY_BRIDGE_RESIDUE_RULES: readonly Omit<ResidueRule, "database">[] = [
  // turns.status is free text; the schema's own partial index `active_turn` in
  // src/bridge/store.ts (status IN ('queued','running','awaiting_approval')) defines what is active.
  // Who resumes an active turn after a stop was not verified: active turns block.
  {
    table: "turns",
    column: "status",
    terminal: [],
    pending: [],
    inFlight: [],
    blocking: ["queued", "running", "awaiting_approval"],
    terminalComplement: true,
    owner: "human bridge (active turns block)",
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
