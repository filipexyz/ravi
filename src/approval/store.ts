import { getDb } from "../router/router-db.js";

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
}

export function createApprovalRequest(input: CreateApprovalRequestInput): ApprovalRequestRecord {
  ensureApprovalRequestTable();
  getDb()
    .prepare(
      `INSERT INTO approval_requests (
        id, type, channel, account_id, chat_id, instance_id, thread_id, message_id,
        session_name, agent_id, permission, object_type, object_id,
        status, decision, decided_by, reason, created_at, expires_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, NULL)`,
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
