import { getDb } from "../router/router-db.js";
import { publish } from "../nats.js";
import type { AuditContextProvenance } from "./audit-provenance.js";

const MAX_REASON_LENGTH = 500;
const MAX_COMMAND_LENGTH = 500;
type PermissionAuditPublisher = (topic: string, data: Record<string, unknown>) => Promise<void> | void;

let permissionAuditPublisher: PermissionAuditPublisher = publish;
const pendingPermissionAuditPublishes: Promise<void>[] = [];

export interface PermissionDenialInput {
  subjectType?: string;
  subjectId?: string;
  relation: string;
  objectType: string;
  objectId: string;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionName?: string | null;
  contextId?: string | null;
  reason?: string | null;
  command?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface PermissionDenial {
  id: number;
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
  agentId: string | null;
  sessionKey: string | null;
  sessionName: string | null;
  contextId: string | null;
  reason: string | null;
  command: string | null;
  detail: Record<string, unknown> | null;
  createdAt: number;
  resolvedAt: number | null;
  resolvedRelationId: number | null;
  notifiedAt: number | null;
}

export interface PermissionDeniedAuditEvent {
  type: string;
  agentId: string;
  denied: string;
  reason: string;
  detail?: unknown;
  blockType?: string;
  missingPrincipals?: string[];
  missingPrincipalDetails?: unknown[];
  recommendedGrantSubjects?: string[];
  command?: string;
  denialId?: number;
  dedupeKey?: string;
  context?: AuditContextProvenance;
  [key: string]: unknown;
}

export interface RecordAndEmitPermissionDenialInput extends PermissionDenialInput {
  audit: PermissionDeniedAuditEvent;
}

interface PermissionDenialRow {
  id: number;
  subject_type: string;
  subject_id: string;
  relation: string;
  object_type: string;
  object_id: string;
  agent_id: string | null;
  session_key: string | null;
  session_name: string | null;
  context_id: string | null;
  reason: string | null;
  command: string | null;
  detail_json: string | null;
  created_at: number;
  resolved_at: number | null;
  resolved_relation_id: number | null;
  notified_at: number | null;
}

export function recordPermissionDenial(input: PermissionDenialInput): PermissionDenial | null {
  const subjectType = normalizeText(input.subjectType ?? (input.agentId ? "agent" : undefined));
  const subjectId = normalizeText(input.subjectId ?? input.agentId ?? undefined);
  if (!subjectType || !subjectId) return null;

  const relation = normalizeText(input.relation);
  const objectType = normalizeText(input.objectType);
  const objectId = normalizeText(input.objectId);
  if (!relation || !objectType || !objectId) return null;

  const detailJson = input.detail ? safeStringify(input.detail) : null;
  const now = Date.now();
  const result = getDb()
    .prepare(
      `
      INSERT INTO permission_denials (
        subject_type, subject_id, relation, object_type, object_id,
        agent_id, session_key, session_name, context_id, reason, command, detail_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      subjectType,
      subjectId,
      relation,
      objectType,
      objectId,
      normalizeNullableText(input.agentId ?? subjectId),
      normalizeNullableText(input.sessionKey),
      normalizeNullableText(input.sessionName),
      normalizeNullableText(input.contextId),
      truncate(normalizeNullableText(input.reason), MAX_REASON_LENGTH),
      truncate(normalizeNullableText(input.command), MAX_COMMAND_LENGTH),
      detailJson,
      now,
    );

  const id = Number(result.lastInsertRowid);
  return getPermissionDenial(id);
}

export function recordAndEmitPermissionDenial(input: RecordAndEmitPermissionDenialInput): PermissionDenial | null {
  const { audit, ...denialInput } = input;
  const denial = recordPermissionDenial(denialInput);
  emitPermissionDeniedAudit({
    ...audit,
    ...(denial?.id ? { denialId: denial.id } : {}),
  });
  return denial;
}

export function emitPermissionDeniedAudit(event: PermissionDeniedAuditEvent): void {
  if (process.env.RAVI_SUPPRESS_AUDIT_EVENTS === "1") return;
  const enriched = {
    ...event,
    dedupeKey: event.dedupeKey ?? buildAuditDeniedDedupeKey(event),
  };

  const p = Promise.resolve(permissionAuditPublisher("ravi.audit.denied", enriched as Record<string, unknown>))
    .then(() => {
      if (typeof enriched.denialId === "number") {
        markPermissionDenialNotified(enriched.denialId);
      }
    })
    .catch((err) => {
      console.error("[audit] emitPermissionDeniedAudit failed", err);
    });

  pendingPermissionAuditPublishes.push(p);
  p.finally(() => {
    const index = pendingPermissionAuditPublishes.indexOf(p);
    if (index >= 0) pendingPermissionAuditPublishes.splice(index, 1);
  }).catch(() => {});
}

export async function flushPermissionAuditEvents(): Promise<void> {
  if (pendingPermissionAuditPublishes.length === 0) return;
  await Promise.allSettled([...pendingPermissionAuditPublishes]);
}

export function setPermissionAuditPublisherForTest(publisher?: PermissionAuditPublisher): void {
  permissionAuditPublisher = publisher ?? publish;
}

export function listPermissionDenials(filter?: {
  subjectType?: string;
  subjectId?: string;
  resolved?: boolean;
}): PermissionDenial[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filter?.subjectType) {
    conditions.push("subject_type = ?");
    params.push(filter.subjectType);
  }
  if (filter?.subjectId) {
    conditions.push("subject_id = ?");
    params.push(filter.subjectId);
  }
  if (filter?.resolved === true) {
    conditions.push("resolved_at IS NOT NULL");
  } else if (filter?.resolved === false) {
    conditions.push("resolved_at IS NULL");
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM permission_denials ${where} ORDER BY id`)
    .all(...params) as PermissionDenialRow[];
  return rows.map(rowToPermissionDenial);
}

export function getPermissionDenial(id: number): PermissionDenial | null {
  const row = getDb().prepare("SELECT * FROM permission_denials WHERE id = ?").get(id) as PermissionDenialRow | null;
  return row ? rowToPermissionDenial(row) : null;
}

export function markPermissionDenialNotified(id: number, notifiedAt = Date.now()): PermissionDenial | null {
  getDb().prepare("UPDATE permission_denials SET notified_at = ? WHERE id = ?").run(notifiedAt, id);
  return getPermissionDenial(id);
}

function rowToPermissionDenial(row: PermissionDenialRow): PermissionDenial {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    relation: row.relation,
    objectType: row.object_type,
    objectId: row.object_id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    contextId: row.context_id,
    reason: row.reason,
    command: row.command,
    detail: parseDetail(row.detail_json),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedRelationId: row.resolved_relation_id,
    notifiedAt: row.notified_at,
  };
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function buildAuditDeniedDedupeKey(event: { type: string; agentId: string; denied: string; reason: string }): string {
  return ["audit.denied", event.type, event.agentId, event.denied, event.reason].map(normalizeDedupePart).join(":");
}

function normalizeDedupePart(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 240);
}

function normalizeNullableText(value: string | null | undefined): string | null {
  return normalizeText(value);
}

function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function safeStringify(value: Record<string, unknown>): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseDetail(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
