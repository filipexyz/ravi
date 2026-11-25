import { getDb } from "../router/router-db.js";
import { fromSubjectColumns, resolveSubjectForChat, toSubjectColumns, type SubjectRef } from "../identity/subject.js";
import type { PermissionGrantMetadata } from "./grant-metadata.js";

export type ApprovalRequestType = "plan" | "spec" | "permission" | "elicitation";
/** The request types that are decided on an approval card (reaction, reply or Slack button). */
export type ApprovalCardRequestType = Exclude<ApprovalRequestType, "elicitation">;
export type ElicitationApprovalAction = "accept" | "decline" | "cancel";
export type ElicitationApprovalMode = "form" | "url";

/**
 * What an `elicitation` row records about one MCP server question: which
 * server and tool asked, the mode, the names of the requested fields and the
 * final action. Never a value the person typed, never the URL of a URL-mode
 * request, never the server's message.
 */
export interface ElicitationApprovalDetail {
  readonly server: string;
  readonly tool: string;
  readonly mode: ElicitationApprovalMode;
  readonly fields: readonly string[];
  readonly action?: ElicitationApprovalAction;
}
export type ApprovalRequestStatus = "pending" | "decided" | "expired";
export type ApprovalDecisionValue = "approved" | "rejected";
export type ApprovalGrantOutcome = "applied" | "failed";

export interface ApprovalRequestRecord {
  readonly id: string;
  readonly type: ApprovalRequestType;
  readonly channel: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly instanceId: string | null;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly sessionName: string | null;
  readonly agentId: string | null;
  readonly permission: string | null;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly status: ApprovalRequestStatus;
  readonly decision: ApprovalDecisionValue | null;
  /** On whose behalf the approval was requested. Not the same as who asked for it (actor). */
  readonly subject?: SubjectRef;
  /** Grant choices a permission denial card may apply. Absent on legacy requests. */
  readonly grant?: PermissionGrantMetadata;
  /** Present on `elicitation` rows only: names, never values. */
  readonly elicitation?: ElicitationApprovalDetail;
  /** Set when the decision came from a grant card. */
  readonly grantIntent?: string | null;
  readonly grantScope?: string | null;
  /** Actual grant application result; a human approval alone does not prove it succeeded. */
  readonly grantOutcome?: ApprovalGrantOutcome;
  readonly decidedBy: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
}

export interface CreateApprovalRequestInput {
  readonly id: string;
  readonly type: ApprovalRequestType;
  readonly channel: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly instanceId?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly sessionName?: string;
  readonly agentId?: string;
  readonly permission?: string;
  readonly objectType?: string;
  readonly objectId?: string;
  readonly grant?: PermissionGrantMetadata;
  /** Required for, and only accepted on, an `elicitation` row. */
  readonly elicitation?: ElicitationApprovalDetail;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Where one approval card went. Slack cards go privately to each person who can
 * grant the request: an ephemeral card in the request's chat (only that person
 * sees it) or, when they are not in that chat, a card in their DM with the app.
 */
export type ApprovalDeliveryKind = "ephemeral" | "dm";

export interface ApprovalDeliveryRecord {
  readonly requestId: string;
  readonly userId: string;
  readonly kind: ApprovalDeliveryKind;
  readonly chatId: string;
  readonly messageId: string;
  readonly createdAt: number;
}

export interface ClaimApprovalDecisionInput {
  readonly id: string;
  readonly decision: ApprovalDecisionValue;
  readonly decidedBy: string;
  readonly reason?: string;
  /** Present when the click came from a grant card button. */
  readonly grantIntent?: string;
  readonly grantScope?: string;
  readonly now: number;
}

interface ApprovalRequestRow {
  id: string;
  type: string;
  channel: string;
  account_id: string;
  chat_id: string;
  instance_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  session_name: string | null;
  agent_id: string | null;
  permission: string | null;
  object_type: string | null;
  object_id: string | null;
  status: string;
  decision: string | null;
  decided_by: string | null;
  reason: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  subject_kind: string | null;
  subject_contact_id: string | null;
  subject_identity_id: string | null;
  subject_agent_id: string | null;
  subject_channel: string | null;
  subject_raw_id: string | null;
  grant_json: string | null;
  grant_intent: string | null;
  grant_scope: string | null;
  grant_outcome: string | null;
  elicitation_json: string | null;
}

export function createApprovalRequest(input: CreateApprovalRequestInput): ApprovalRequestRecord {
  if ((input.type === "elicitation") !== Boolean(input.elicitation)) {
    throw new Error("An elicitation approval request needs its detail, and only it may carry one.");
  }
  if (input.type === "elicitation" && input.grant) {
    throw new Error("An elicitation approval request cannot carry a permission grant.");
  }
  const elicitation = input.elicitation ? normalizeElicitationDetail(input.elicitation, false) : null;
  ensureApprovalRequestTable();
  const subject = toSubjectColumns(resolveSubjectForChat(input.chatId));
  getDb()
    .prepare(
      `INSERT INTO approval_requests (
        id, type, channel, account_id, chat_id, instance_id, thread_id, message_id,
        session_name, agent_id, permission, object_type, object_id,
        subject_kind, subject_contact_id, subject_identity_id, subject_agent_id, subject_channel, subject_raw_id,
        grant_json, elicitation_json,
        status, decision, decided_by, reason, created_at, expires_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, NULL)`,
    )
    .run(
      input.id,
      input.type,
      input.channel,
      input.accountId,
      input.chatId,
      emptyToNull(input.instanceId),
      emptyToNull(input.threadId),
      emptyToNull(input.messageId),
      emptyToNull(input.sessionName),
      emptyToNull(input.agentId),
      emptyToNull(input.permission),
      emptyToNull(input.objectType),
      emptyToNull(input.objectId),
      subject.subjectKind,
      subject.subjectContactId,
      subject.subjectIdentityId,
      subject.subjectAgentId,
      subject.subjectChannel,
      subject.subjectRawId,
      input.grant ? JSON.stringify(input.grant) : null,
      elicitation ? JSON.stringify(elicitation) : null,
      input.createdAt,
      input.expiresAt,
    );
  const created = getApprovalRequest(input.id);
  if (!created) throw new Error(`Approval request was not persisted: ${input.id}`);
  return created;
}

export function attachApprovalRequestMessageId(id: string, messageId: string): ApprovalRequestRecord | null {
  ensureApprovalRequestTable();
  getDb()
    .prepare(
      `UPDATE approval_requests
        SET message_id = ?
        WHERE id = ? AND status = 'pending' AND (message_id IS NULL OR message_id = ?)`,
    )
    .run(messageId, id, messageId);
  return getApprovalRequest(id);
}

export function getApprovalRequest(id: string): ApprovalRequestRecord | null {
  ensureApprovalRequestTable();
  const row = getDb().prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as ApprovalRequestRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function getApprovalRequestByMessageId(messageId: string): ApprovalRequestRecord | null {
  ensureApprovalRequestTable();
  const row = getDb()
    .prepare("SELECT * FROM approval_requests WHERE message_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(messageId) as ApprovalRequestRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function recordApprovalDeliveries(
  requestId: string,
  deliveries: readonly Omit<ApprovalDeliveryRecord, "requestId">[],
): void {
  ensureApprovalRequestTable();
  const insert = getDb().prepare(
    `INSERT OR REPLACE INTO approval_request_deliveries (
      request_id, user_id, kind, chat_id, message_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const delivery of deliveries) {
    insert.run(requestId, delivery.userId, delivery.kind, delivery.chatId, delivery.messageId, delivery.createdAt);
  }
}

export function listApprovalDeliveries(requestId: string): ApprovalDeliveryRecord[] {
  ensureApprovalRequestTable();
  const rows = getDb()
    .prepare("SELECT * FROM approval_request_deliveries WHERE request_id = ? ORDER BY created_at, user_id")
    .all(requestId) as ApprovalDeliveryRow[];
  return rows.map((row) => ({
    requestId: row.request_id,
    userId: row.user_id,
    kind: row.kind as ApprovalDeliveryKind,
    chatId: row.chat_id,
    messageId: row.message_id,
    createdAt: row.created_at,
  }));
}

export function claimApprovalDecision(input: ClaimApprovalDecisionInput): ApprovalRequestRecord | null {
  ensureApprovalRequestTable();
  const result = getDb()
    .prepare(
      `UPDATE approval_requests
        SET status = 'decided',
            decision = ?,
            decided_by = ?,
            reason = ?,
            grant_intent = ?,
            grant_scope = ?,
            decided_at = ?
        WHERE id = ?
          AND type != 'elicitation'
          AND status = 'pending'
          AND expires_at > ?`,
    )
    .run(
      input.decision,
      input.decidedBy,
      emptyToNull(input.reason),
      emptyToNull(input.grantIntent),
      emptyToNull(input.grantScope),
      input.now,
      input.id,
      input.now,
    );
  if (result.changes !== 1) return null;
  return getApprovalRequest(input.id);
}

/**
 * Settle one `elicitation` row with the action that was sent to the server.
 * `accept` and `decline` record who answered (the person's contact id);
 * `cancel` (timeout, send failure, nobody answered) expires the row. Only the
 * action is stored, never the answer. Returns null when the row is not a
 * pending elicitation.
 */
export function settleElicitationApprovalRequest(input: {
  readonly id: string;
  readonly action: ElicitationApprovalAction;
  readonly decidedBy?: string;
  readonly now: number;
}): ApprovalRequestRecord | null {
  if (input.action !== "accept" && input.action !== "decline" && input.action !== "cancel") {
    throw new Error("Invalid elicitation action.");
  }
  ensureApprovalRequestTable();
  const current = getApprovalRequest(input.id);
  if (!current || current.type !== "elicitation" || current.status !== "pending" || !current.elicitation) return null;
  const detail = JSON.stringify(normalizeElicitationDetail({ ...current.elicitation, action: input.action }, true));
  const status = input.action === "cancel" ? "expired" : "decided";
  const decision = input.action === "accept" ? "approved" : input.action === "decline" ? "rejected" : null;
  const result = getDb()
    .prepare(
      `UPDATE approval_requests
        SET status = ?, decision = ?, decided_by = ?, elicitation_json = ?, decided_at = ?
        WHERE id = ? AND type = 'elicitation' AND status = 'pending'`,
    )
    .run(
      status,
      decision,
      input.action === "cancel" ? null : emptyToNull(input.decidedBy),
      detail,
      input.now,
      input.id,
    );
  return result.changes === 1 ? getApprovalRequest(input.id) : null;
}

/** Persist only the trusted executor's terminal result, never provider errors or message text. */
export function recordApprovalGrantOutcome(id: string, outcome: ApprovalGrantOutcome): ApprovalRequestRecord | null {
  if (outcome !== "applied" && outcome !== "failed") throw new Error("Invalid approval grant outcome.");
  ensureApprovalRequestTable();
  const result = getDb()
    .prepare(
      `UPDATE approval_requests SET grant_outcome = ?
     WHERE id = ? AND status = 'decided' AND decision = 'approved'
       AND grant_json IS NOT NULL AND grant_outcome IS NULL`,
    )
    .run(outcome, id);
  return result.changes === 1 ? getApprovalRequest(id) : null;
}

export function expireApprovalRequest(id: string, now: number): ApprovalRequestRecord | null {
  ensureApprovalRequestTable();
  getDb()
    .prepare(
      `UPDATE approval_requests
        SET status = 'expired', decided_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(now, id);
  return getApprovalRequest(id);
}

export function isApprovalRequestOpen(record: ApprovalRequestRecord, now: number): boolean {
  return record.status === "pending" && record.expiresAt > now;
}

/** Pending permission requests on one chat, newest first. Used for card dedupe. */
export function listPendingApprovalRequestsForChat(chatId: string, now: number): ApprovalRequestRecord[] {
  ensureApprovalRequestTable();
  const rows = getDb()
    .prepare(
      `SELECT * FROM approval_requests
        WHERE chat_id = ? AND type = 'permission' AND status = 'pending' AND expires_at > ?
        ORDER BY created_at DESC`,
    )
    .all(chatId, now) as ApprovalRequestRow[];
  return rows.map(rowToRecord);
}

/**
 * Which scope a person picked on their own card. Slack sends the select change
 * as its own interaction, so the choice has to survive until the button click.
 */
export function setApprovalCardScope(input: {
  readonly requestId: string;
  readonly userId: string;
  readonly scope: string;
  readonly now?: number;
}): void {
  ensureApprovalRequestTable();
  const userId = input.userId.trim().toUpperCase();
  if (!userId) return;
  getDb()
    .prepare(
      `INSERT INTO approval_card_scopes (request_id, user_id, scope, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(request_id, user_id) DO UPDATE SET scope = excluded.scope, updated_at = excluded.updated_at`,
    )
    .run(input.requestId, userId, input.scope, input.now ?? Date.now());
}

export function getApprovalCardScope(requestId: string, userId: string | null | undefined): string | null {
  ensureApprovalRequestTable();
  const normalized = userId?.trim().toUpperCase();
  if (!normalized) return null;
  const row = getDb()
    .prepare("SELECT scope FROM approval_card_scopes WHERE request_id = ? AND user_id = ?")
    .get(requestId, normalized) as { scope: string } | undefined;
  return row?.scope?.trim() || null;
}

interface ApprovalDeliveryRow {
  request_id: string;
  user_id: string;
  kind: string;
  chat_id: string;
  message_id: string;
  created_at: number;
}

function ensureApprovalRequestTable(): void {
  const db = getDb();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      instance_id TEXT,
      thread_id TEXT,
      message_id TEXT,
      session_name TEXT,
      agent_id TEXT,
      permission TEXT,
      object_type TEXT,
      object_id TEXT,
      status TEXT NOT NULL,
      decision TEXT,
      decided_by TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER
    )`,
  ).run();
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_approval_requests_message
      ON approval_requests(message_id)`,
  ).run();
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_approval_requests_status_expires
      ON approval_requests(status, expires_at)`,
  ).run();
  const approvalColumns = new Set(
    (db.prepare("PRAGMA table_info(approval_requests)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const column of [
    "subject_kind",
    "subject_contact_id",
    "subject_identity_id",
    "subject_agent_id",
    "subject_channel",
    "subject_raw_id",
    "grant_json",
    "grant_intent",
    "grant_scope",
    "grant_outcome",
    "elicitation_json",
  ]) {
    if (!approvalColumns.has(column)) {
      db.exec(`ALTER TABLE approval_requests ADD COLUMN ${column} TEXT`);
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_approval_requests_subject_contact ON approval_requests(subject_contact_id)");
  db.prepare(
    `CREATE TABLE IF NOT EXISTS approval_card_scopes (
      request_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (request_id, user_id)
    )`,
  ).run();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS approval_request_deliveries (
      request_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (request_id, user_id)
    )`,
  ).run();
}

function rowToRecord(row: ApprovalRequestRow): ApprovalRequestRecord {
  const grant = parseGrantJson(row.grant_json);
  const elicitation = row.type === "elicitation" ? parseElicitationJson(row.elicitation_json) : null;
  return {
    id: row.id,
    type: row.type as ApprovalRequestType,
    channel: row.channel,
    accountId: row.account_id,
    chatId: row.chat_id,
    instanceId: row.instance_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    sessionName: row.session_name,
    agentId: row.agent_id,
    permission: row.permission,
    objectType: row.object_type,
    objectId: row.object_id,
    status: row.status as ApprovalRequestStatus,
    decision: (row.decision as ApprovalDecisionValue | null) ?? null,
    ...(fromSubjectColumns(row) ? { subject: fromSubjectColumns(row) } : {}),
    ...(grant ? { grant } : {}),
    ...(elicitation ? { elicitation } : {}),
    ...(row.grant_intent ? { grantIntent: row.grant_intent } : {}),
    ...(row.grant_scope ? { grantScope: row.grant_scope } : {}),
    ...(row.grant_outcome === "applied" || row.grant_outcome === "failed" ? { grantOutcome: row.grant_outcome } : {}),
    decidedBy: row.decided_by,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
  };
}

function emptyToNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseGrantJson(value: string | null): PermissionGrantMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as PermissionGrantMetadata;
    if (!parsed || typeof parsed !== "object" || !parsed.capability) return null;
    return parsed;
  } catch {
    return null;
  }
}

const ELICITATION_NAME_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}$/;
const MAX_ELICITATION_FIELDS = 64;

/**
 * Keep exactly the recorded keys, so nothing else (a value, a message, a URL)
 * can ride along into the row. Field names are names: short, with no spaces.
 */
function normalizeElicitationDetail(
  detail: ElicitationApprovalDetail,
  allowAction: boolean,
): ElicitationApprovalDetail {
  const server = typeof detail?.server === "string" ? detail.server.trim() : "";
  const tool = typeof detail?.tool === "string" ? detail.tool.trim() : "";
  if (!ELICITATION_NAME_PATTERN.test(server) || !ELICITATION_NAME_PATTERN.test(tool)) {
    throw new Error("Elicitation detail needs a server and a tool name.");
  }
  if (detail.mode !== "form" && detail.mode !== "url") throw new Error("Elicitation mode must be form or url.");
  if (!Array.isArray(detail.fields) || detail.fields.length > MAX_ELICITATION_FIELDS) {
    throw new Error("Elicitation fields must be a short list of names.");
  }
  const fields: string[] = [];
  for (const field of detail.fields) {
    if (typeof field !== "string" || !ELICITATION_NAME_PATTERN.test(field)) {
      throw new Error("Elicitation field names must be plain names.");
    }
    if (!fields.includes(field)) fields.push(field);
  }
  if (detail.mode === "url" && fields.length > 0) throw new Error("A URL-mode elicitation has no fields.");
  const action = detail.action;
  if (action !== undefined) {
    if (!allowAction) throw new Error("A new elicitation request has no action yet.");
    if (action !== "accept" && action !== "decline" && action !== "cancel") {
      throw new Error("Invalid elicitation action.");
    }
  }
  return { server, tool, mode: detail.mode, fields, ...(action ? { action } : {}) };
}

function parseElicitationJson(value: string | null): ElicitationApprovalDetail | null {
  if (!value) return null;
  try {
    return normalizeElicitationDetail(JSON.parse(value) as ElicitationApprovalDetail, true);
  } catch {
    // no-cause: A damaged detail column reads as absent; the row keeps its status and nothing is guessed.
    return null;
  }
}
