import { getDb } from "../router/router-db.js";
import { fromSubjectColumns, resolveSubjectForChat, toSubjectColumns, type SubjectRef } from "../identity/subject.js";

export type ApprovalRequestType = "plan" | "spec" | "permission";
export type ApprovalRequestStatus = "pending" | "decided" | "expired";
export type ApprovalDecisionValue = "approved" | "rejected";

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
}

export function createApprovalRequest(input: CreateApprovalRequestInput): ApprovalRequestRecord {
  ensureApprovalRequestTable();
  const subject = toSubjectColumns(resolveSubjectForChat(input.chatId));
  getDb()
    .prepare(
      `INSERT INTO approval_requests (
        id, type, channel, account_id, chat_id, instance_id, thread_id, message_id,
        session_name, agent_id, permission, object_type, object_id,
        subject_kind, subject_contact_id, subject_identity_id, subject_agent_id, subject_channel, subject_raw_id,
        status, decision, decided_by, reason, created_at, expires_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, NULL)`,
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
            decided_at = ?
        WHERE id = ?
          AND status = 'pending'
          AND expires_at > ?`,
    )
    .run(input.decision, input.decidedBy, emptyToNull(input.reason), input.now, input.id, input.now);
  if (result.changes !== 1) return null;
  return getApprovalRequest(input.id);
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
  ]) {
    if (!approvalColumns.has(column)) {
      db.exec(`ALTER TABLE approval_requests ADD COLUMN ${column} TEXT`);
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_approval_requests_subject_contact ON approval_requests(subject_contact_id)");
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
