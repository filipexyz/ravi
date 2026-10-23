/**
 * Local state of cloud runs in chat, in `ravi.db` (contract F1 "Console ->
 * OSS inbox events", F3 "Thread = run").
 *
 * - `cloud_delivery_items`: each Console inbox item of category `cloud_agents`
 *   this installation must render, once (deduped by item id), with its retry
 *   state. The inbox runner records it; the delivery runner works it off.
 * - `cloud_chat_approvals` / `cloud_chat_questions`: what was asked in chat,
 *   so a Slack button or a WhatsApp `aprovar <código>` reply finds its run and
 *   counts only from the run's person (their linked contact).
 * - `cloud_thread_runs`: a Slack thread or WhatsApp group bound to a run
 *   (`ravi cloud runs start --bind-thread`). One active binding per thread key;
 *   it ends when the run ends.
 *
 * Tables are created lazily, like `task-runs-db.ts`.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { getDb } from "../router/router-db.js";

const ensured = new WeakSet<Database>();

function db(): Database {
  const database = getDb();
  if (!ensured.has(database)) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS cloud_delivery_items (
        item_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_name TEXT,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','done','skipped','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        claimed_until INTEGER,
        informed_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_delivery_items_due ON cloud_delivery_items(state, next_attempt_at);
      CREATE TABLE IF NOT EXISTS cloud_chat_approvals (
        approval_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        code TEXT NOT NULL,
        session_name TEXT,
        agent_name TEXT,
        tool TEXT NOT NULL,
        actor_user_id TEXT,
        actor_contact_id TEXT,
        actor_name TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','deciding','approved','denied','closed')),
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_chat_approvals_code ON cloud_chat_approvals(code, status);
      CREATE TABLE IF NOT EXISTS cloud_chat_questions (
        question_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_name TEXT,
        actor_contact_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','answered')),
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_chat_questions_run ON cloud_chat_questions(run_id, status);
      CREATE TABLE IF NOT EXISTS cloud_thread_runs (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('slack','whatsapp')),
        account_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_ts TEXT,
        session_name TEXT,
        agent_name TEXT NOT NULL,
        prompt_summary TEXT,
        actor_user_id TEXT,
        actor_contact_id TEXT,
        actor_name TEXT,
        card_message_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_thread_runs_active_key
        ON cloud_thread_runs(thread_key) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_cloud_thread_runs_run ON cloud_thread_runs(run_id);
      CREATE INDEX IF NOT EXISTS idx_cloud_thread_runs_chat ON cloud_thread_runs(channel, chat_id, ended_at);
    `);
    ensured.add(database);
  }
  return database;
}

// ---------------------------------------------------------------------------
// Delivery items

export type CloudDeliveryItemState = "pending" | "done" | "skipped" | "failed";

export interface CloudDeliveryItem {
  itemId: string;
  eventType: string;
  runId: string;
  sessionName: string | null;
  payload: Record<string, unknown>;
  state: CloudDeliveryItemState;
  attempts: number;
  nextAttemptAt: number;
  /** When the session got its inform; a retry then only redoes the acknowledgement. */
  informedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DeliveryItemRow {
  item_id: string;
  event_type: string;
  run_id: string;
  session_name: string | null;
  payload_json: string;
  state: string;
  attempts: number;
  next_attempt_at: number;
  informed_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function toDeliveryItem(row: DeliveryItemRow): CloudDeliveryItem {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    itemId: row.item_id,
    eventType: row.event_type,
    runId: row.run_id,
    sessionName: row.session_name,
    payload,
    state: row.state as CloudDeliveryItemState,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    informedAt: row.informed_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Records an item once; false when this item id was already recorded. */
export function dbRecordCloudDeliveryItem(input: {
  itemId: string;
  eventType: string;
  runId: string;
  sessionName: string | null;
  payload: Record<string, unknown>;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const result = db()
    .prepare(
      `INSERT OR IGNORE INTO cloud_delivery_items (
        item_id, event_type, run_id, session_name, payload_json, state, attempts, next_attempt_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .run(input.itemId, input.eventType, input.runId, input.sessionName, JSON.stringify(input.payload), now, now, now);
  return result.changes === 1;
}

export function dbGetCloudDeliveryItem(itemId: string): CloudDeliveryItem | null {
  const row = db().prepare("SELECT * FROM cloud_delivery_items WHERE item_id = ?").get(itemId) as
    | DeliveryItemRow
    | undefined;
  return row ? toDeliveryItem(row) : null;
}

export function dbListDueCloudDeliveryItems(now = Date.now(), limit = 25): CloudDeliveryItem[] {
  const rows = db()
    .prepare(
      `SELECT * FROM cloud_delivery_items
        WHERE state = 'pending' AND next_attempt_at <= ? AND (claimed_until IS NULL OR claimed_until < ?)
        ORDER BY created_at ASC LIMIT ?`,
    )
    .all(now, now, limit) as DeliveryItemRow[];
  return rows.map(toDeliveryItem);
}

/** Takes one pending item for `leaseMs`; false when another process holds it or it is no longer pending. */
export function dbClaimCloudDeliveryItem(itemId: string, now = Date.now(), leaseMs = 60_000): boolean {
  const result = db()
    .prepare(
      `UPDATE cloud_delivery_items SET claimed_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE item_id = ? AND state = 'pending' AND (claimed_until IS NULL OR claimed_until < ?)`,
    )
    .run(now + leaseMs, now, itemId, now);
  return result.changes === 1;
}

export function dbMarkCloudDeliveryItemInformed(itemId: string, now = Date.now()): void {
  db()
    .prepare("UPDATE cloud_delivery_items SET informed_at = ?, updated_at = ? WHERE item_id = ?")
    .run(now, now, itemId);
}

export function dbFinishCloudDeliveryItem(
  itemId: string,
  state: Exclude<CloudDeliveryItemState, "pending">,
  error: string | null = null,
  now = Date.now(),
): void {
  db()
    .prepare(
      `UPDATE cloud_delivery_items SET state = ?, last_error = ?, claimed_until = NULL, updated_at = ?
        WHERE item_id = ?`,
    )
    .run(state, error ? error.slice(0, 500) : null, now, itemId);
}

/** Releases the claim and schedules another attempt. */
export function dbRetryCloudDeliveryItem(itemId: string, error: string, retryAt: number, now = Date.now()): void {
  db()
    .prepare(
      `UPDATE cloud_delivery_items SET next_attempt_at = ?, last_error = ?, claimed_until = NULL, updated_at = ?
        WHERE item_id = ? AND state = 'pending'`,
    )
    .run(retryAt, error.slice(0, 500), now, itemId);
}

// ---------------------------------------------------------------------------
// Approvals and questions asked in chat

/** `closed`: the run ended before anyone decided in chat. */
export type CloudChatApprovalStatus = "pending" | "deciding" | "approved" | "denied" | "closed";

export interface CloudChatApproval {
  approvalId: string;
  runId: string;
  /** First 6 characters of the approval id, lowercased: what a WhatsApp reply carries. */
  code: string;
  sessionName: string | null;
  agentName: string | null;
  tool: string;
  actorUserId: string | null;
  /** The run's person on this installation; only their answer counts. */
  actorContactId: string | null;
  actorName: string | null;
  status: CloudChatApprovalStatus;
  createdAt: number;
  /** When it was decided; while `deciding`, when it was claimed. */
  decidedAt: number | null;
}

/** A claim older than this was left by a Ravi that stopped mid-decision: the approval is open again. */
export const CLOUD_CHAT_APPROVAL_CLAIM_TTL_MS = 2 * 60_000;

/** Whether a person can still decide it here: pending, or a claim a stopped Ravi left behind. */
export function isCloudChatApprovalOpen(approval: CloudChatApproval, now = Date.now()): boolean {
  if (approval.status === "pending") return true;
  return (
    approval.status === "deciding" &&
    (approval.decidedAt === null || approval.decidedAt < now - CLOUD_CHAT_APPROVAL_CLAIM_TTL_MS)
  );
}

interface ApprovalRow {
  approval_id: string;
  run_id: string;
  code: string;
  session_name: string | null;
  agent_name: string | null;
  tool: string;
  actor_user_id: string | null;
  actor_contact_id: string | null;
  actor_name: string | null;
  status: string;
  created_at: number;
  decided_at: number | null;
}

function toApproval(row: ApprovalRow): CloudChatApproval {
  return {
    approvalId: row.approval_id,
    runId: row.run_id,
    code: row.code,
    sessionName: row.session_name,
    agentName: row.agent_name,
    tool: row.tool,
    actorUserId: row.actor_user_id,
    actorContactId: row.actor_contact_id,
    actorName: row.actor_name,
    status: row.status as CloudChatApprovalStatus,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/** The short code a person types to decide an approval in chat. */
export function cloudApprovalCode(approvalId: string): string {
  return approvalId
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 6)
    .toLowerCase();
}

/** Records an approval asked in chat once; false when it was already recorded. */
export function dbRecordCloudChatApproval(
  input: Omit<CloudChatApproval, "code" | "status" | "createdAt" | "decidedAt"> & { now?: number },
): boolean {
  const now = input.now ?? Date.now();
  const result = db()
    .prepare(
      `INSERT OR IGNORE INTO cloud_chat_approvals (
        approval_id, run_id, code, session_name, agent_name, tool, actor_user_id, actor_contact_id, actor_name,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      input.approvalId,
      input.runId,
      cloudApprovalCode(input.approvalId),
      input.sessionName,
      input.agentName,
      input.tool,
      input.actorUserId,
      input.actorContactId,
      input.actorName,
      now,
    );
  return result.changes === 1;
}

export function dbGetCloudChatApproval(approvalId: string): CloudChatApproval | null {
  const row = db().prepare("SELECT * FROM cloud_chat_approvals WHERE approval_id = ?").get(approvalId) as
    | ApprovalRow
    | undefined;
  return row ? toApproval(row) : null;
}

const OPEN_APPROVAL = "(status = 'pending' OR (status = 'deciding' AND (decided_at IS NULL OR decided_at < ?)))";

/** Open approvals with this short code (normally one). */
export function dbFindPendingCloudChatApprovals(code: string, now = Date.now()): CloudChatApproval[] {
  const rows = db()
    .prepare(`SELECT * FROM cloud_chat_approvals WHERE code = ? AND ${OPEN_APPROVAL} ORDER BY created_at DESC`)
    .all(code.toLowerCase(), now - CLOUD_CHAT_APPROVAL_CLAIM_TTL_MS) as ApprovalRow[];
  return rows.map(toApproval);
}

/** Takes an open approval for one decision; false when another answer took it first. */
export function dbClaimCloudChatApproval(approvalId: string, now = Date.now()): boolean {
  return (
    db()
      .prepare(
        `UPDATE cloud_chat_approvals SET status = 'deciding', decided_at = ? WHERE approval_id = ? AND ${OPEN_APPROVAL}`,
      )
      .run(now, approvalId, now - CLOUD_CHAT_APPROVAL_CLAIM_TTL_MS).changes === 1
  );
}

/**
 * The decision was recorded (`approved`/`denied`), the Console no longer has
 * it open (`closed`), or it failed and the approval is open again (`pending`).
 */
export function dbSettleCloudChatApproval(
  approvalId: string,
  status: "pending" | "approved" | "denied" | "closed",
  now = Date.now(),
): void {
  db()
    .prepare("UPDATE cloud_chat_approvals SET status = ?, decided_at = ? WHERE approval_id = ?")
    .run(status, status === "pending" ? null : now, approvalId);
}

export interface CloudChatQuestion {
  questionId: string;
  runId: string;
  sessionName: string | null;
  actorContactId: string | null;
  status: "pending" | "answered";
  createdAt: number;
}

export function dbRecordCloudChatQuestion(input: {
  questionId: string;
  runId: string;
  sessionName: string | null;
  actorContactId: string | null;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  return (
    db()
      .prepare(
        `INSERT OR IGNORE INTO cloud_chat_questions (question_id, run_id, session_name, actor_contact_id, status, created_at)
          VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.questionId, input.runId, input.sessionName, input.actorContactId, now).changes === 1
  );
}

/** The oldest question of a run still waiting for its person. */
export function dbPendingCloudChatQuestion(runId: string): CloudChatQuestion | null {
  const row = db()
    .prepare(
      `SELECT * FROM cloud_chat_questions WHERE run_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
    )
    .get(runId) as
    | {
        question_id: string;
        run_id: string;
        session_name: string | null;
        actor_contact_id: string | null;
        status: string;
        created_at: number;
      }
    | undefined;
  return row
    ? {
        questionId: row.question_id,
        runId: row.run_id,
        sessionName: row.session_name,
        actorContactId: row.actor_contact_id,
        status: row.status === "answered" ? "answered" : "pending",
        createdAt: row.created_at,
      }
    : null;
}

export function dbMarkCloudChatQuestionAnswered(questionId: string, now = Date.now()): void {
  db()
    .prepare("UPDATE cloud_chat_questions SET status = 'answered', answered_at = ? WHERE question_id = ?")
    .run(now, questionId);
}

/** Questions and approvals of a run that ended can no longer be answered. */
export function dbCloseCloudChatRun(runId: string, now = Date.now()): void {
  const database = db();
  database
    .prepare(
      "UPDATE cloud_chat_questions SET status = 'answered', answered_at = ? WHERE run_id = ? AND status = 'pending'",
    )
    .run(now, runId);
  database
    .prepare(
      "UPDATE cloud_chat_approvals SET status = 'closed', decided_at = ? WHERE run_id = ? AND status = 'pending'",
    )
    .run(now, runId);
}

// ---------------------------------------------------------------------------
// Thread = run

export type CloudThreadChannel = "slack" | "whatsapp";

export interface CloudThreadRun {
  id: string;
  /** `slack:<instanceId>:<channelId>:<threadTs>` or `whatsapp:<instanceId>:<groupId>`. */
  threadKey: string;
  runId: string;
  channel: CloudThreadChannel;
  accountId: string;
  instanceId: string;
  chatId: string;
  threadTs: string | null;
  sessionName: string | null;
  agentName: string;
  promptSummary: string | null;
  actorUserId: string | null;
  /** Only this contact's messages in the thread go to the run. */
  actorContactId: string | null;
  actorName: string | null;
  /** The run card's message id (Slack ts, WhatsApp message id). */
  cardMessageId: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

interface ThreadRow {
  id: string;
  thread_key: string;
  run_id: string;
  channel: string;
  account_id: string;
  instance_id: string;
  chat_id: string;
  thread_ts: string | null;
  session_name: string | null;
  agent_name: string;
  prompt_summary: string | null;
  actor_user_id: string | null;
  actor_contact_id: string | null;
  actor_name: string | null;
  card_message_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
}

function toThread(row: ThreadRow): CloudThreadRun {
  return {
    id: row.id,
    threadKey: row.thread_key,
    runId: row.run_id,
    channel: row.channel === "whatsapp" ? "whatsapp" : "slack",
    accountId: row.account_id,
    instanceId: row.instance_id,
    chatId: row.chat_id,
    threadTs: row.thread_ts,
    sessionName: row.session_name,
    agentName: row.agent_name,
    promptSummary: row.prompt_summary,
    actorUserId: row.actor_user_id,
    actorContactId: row.actor_contact_id,
    actorName: row.actor_name,
    cardMessageId: row.card_message_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}

export type CloudThreadRunInput = Omit<CloudThreadRun, "id" | "createdAt" | "updatedAt" | "endedAt"> & {
  now?: number;
};

/** Binds a thread to a run. An older binding of the same thread (its run ended unseen) ends first. */
export function dbBindCloudThreadRun(input: CloudThreadRunInput): CloudThreadRun {
  const now = input.now ?? Date.now();
  const id = randomUUID();
  const database = db();
  database.transaction(() => {
    database
      .prepare("UPDATE cloud_thread_runs SET ended_at = ?, updated_at = ? WHERE thread_key = ? AND ended_at IS NULL")
      .run(now, now, input.threadKey);
    database
      .prepare(
        `INSERT INTO cloud_thread_runs (
          id, thread_key, run_id, channel, account_id, instance_id, chat_id, thread_ts, session_name, agent_name,
          prompt_summary, actor_user_id, actor_contact_id, actor_name, card_message_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadKey,
        input.runId,
        input.channel,
        input.accountId,
        input.instanceId,
        input.chatId,
        input.threadTs,
        input.sessionName,
        input.agentName,
        input.promptSummary,
        input.actorUserId,
        input.actorContactId,
        input.actorName,
        input.cardMessageId,
        input.status,
        now,
        now,
      );
  })();
  return dbGetCloudThreadRun(id) as CloudThreadRun;
}

export function dbGetCloudThreadRun(id: string): CloudThreadRun | null {
  const row = db().prepare("SELECT * FROM cloud_thread_runs WHERE id = ?").get(id) as ThreadRow | undefined;
  return row ? toThread(row) : null;
}

export function dbGetActiveCloudThreadByKey(threadKey: string): CloudThreadRun | null {
  const row = db()
    .prepare("SELECT * FROM cloud_thread_runs WHERE thread_key = ? AND ended_at IS NULL")
    .get(threadKey) as ThreadRow | undefined;
  return row ? toThread(row) : null;
}

/**
 * The active binding of a Slack thread (`threadTs`) or a WhatsApp group (no `threadTs`), on the
 * instance the message came in on: two instances in the same group each have their own bindings.
 */
export function dbFindActiveCloudThread(input: {
  channel: CloudThreadChannel;
  /** The receiving instance; a binding made without an instance id stored the account instead. */
  instanceId: string;
  accountId?: string | null;
  chatId: string;
  threadTs?: string | null;
}): CloudThreadRun | null {
  const instances = [input.instanceId, input.accountId ?? input.instanceId];
  const row = (
    input.channel === "slack"
      ? db()
          .prepare(
            `SELECT * FROM cloud_thread_runs
              WHERE channel = 'slack' AND instance_id IN (?, ?) AND chat_id = ? AND thread_ts = ? AND ended_at IS NULL
              ORDER BY created_at DESC LIMIT 1`,
          )
          .get(...instances, input.chatId, input.threadTs ?? "")
      : db()
          .prepare(
            `SELECT * FROM cloud_thread_runs
              WHERE channel = 'whatsapp' AND instance_id IN (?, ?) AND chat_id = ? AND ended_at IS NULL
              ORDER BY created_at DESC LIMIT 1`,
          )
          .get(...instances, input.chatId)
  ) as ThreadRow | undefined;
  return row ? toThread(row) : null;
}

export function dbListCloudThreadsForRun(runId: string, options: { activeOnly?: boolean } = {}): CloudThreadRun[] {
  const rows = db()
    .prepare(
      `SELECT * FROM cloud_thread_runs WHERE run_id = ? ${options.activeOnly ? "AND ended_at IS NULL" : ""}
        ORDER BY created_at DESC`,
    )
    .all(runId) as ThreadRow[];
  return rows.map(toThread);
}

export function dbUpdateCloudThreadRun(
  id: string,
  changes: { status?: string; cardMessageId?: string | null },
  now = Date.now(),
): void {
  const current = dbGetCloudThreadRun(id);
  if (!current) return;
  db()
    .prepare("UPDATE cloud_thread_runs SET status = ?, card_message_id = ?, updated_at = ? WHERE id = ?")
    .run(
      changes.status ?? current.status,
      changes.cardMessageId !== undefined ? changes.cardMessageId : current.cardMessageId,
      now,
      id,
    );
}

/** Ends every active binding of a run; returns how many ended. */
export function dbEndCloudThreadRuns(runId: string, status?: string, now = Date.now()): number {
  return db()
    .prepare(
      `UPDATE cloud_thread_runs SET ended_at = ?, updated_at = ?, status = COALESCE(?, status)
        WHERE run_id = ? AND ended_at IS NULL`,
    )
    .run(now, now, status ?? null, runId).changes;
}
