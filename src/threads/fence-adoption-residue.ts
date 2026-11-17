import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { DurableResidue, DurableResidueSource } from "./fence-adoption.js";

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
    owner: "mail outbox (explicit retry)",
  },
  {
    table: "calendar_outbox",
    column: "status",
    terminal: ["sent", "acked", "failed", "dead"],
    pending: ["pending"],
    inFlight: [],
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
];

/** Every rule above lives in the router database (ravi.db) at v3.261113.2. */
export function legacyResidueRules(routerDatabasePath: string): ResidueRule[] {
  return LEGACY_ROUTER_RESIDUE_RULES.map((rule) => ({ ...rule, database: routerDatabasePath }));
}

const identifier = /^[a-z_][a-z0-9_]*$/;

/** Read-only classification. Never initializes, migrates or changes a journal mode. */
export function collectSqliteResidue(rules: readonly ResidueRule[]): DurableResidue {
  const sources: DurableResidueSource[] = [];
  const unknown: string[] = [];
  const handles = new Map<string, Database>();
  try {
    for (const rule of rules) {
      const label = `${rule.table}.${rule.column}`;
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
          database = new Database(rule.database, { readonly: true, create: false });
          handles.set(rule.database, database);
        }
        const exists = database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(rule.table);
        if (!exists) {
          // Tables are created on first use; an absent table persisted no work of this kind.
          sources.push({ source: label, pending: 0, inFlight: 0, detail: { table: "absent" } });
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
          else unknown.push(`${label}=${status} (${row.count})`);
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
