import { resolveToolGroup } from "../cli/tool-registry.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { getDb } from "../router/router-db.js";
import { getSession } from "../router/sessions.js";
import { logger } from "../utils/logger.js";
import { matchPattern } from "./capability-context.js";
import type { Relation } from "./relations.js";

const log = logger.child("permissions:denials");
const MAX_REASON_LENGTH = 500;
const MAX_COMMAND_LENGTH = 500;
type PermissionDenialNotifier = typeof publishSessionPrompt;
let permissionDenialNotifier: PermissionDenialNotifier = publishSessionPrompt;

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

export interface ResolvedPermissionDenialsResult {
  matched: number;
  notified: number;
  sessions: string[];
}

export function setPermissionDenialNotifierForTest(notifier?: PermissionDenialNotifier): void {
  permissionDenialNotifier = notifier ?? publishSessionPrompt;
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

export function resolvePermissionDenialsForGrant(relation: Relation): ResolvedPermissionDenialsResult {
  if (relation.subjectType !== "agent") {
    return { matched: 0, notified: 0, sessions: [] };
  }

  const pending = listPendingPermissionDenials(relation.subjectType, relation.subjectId).filter((denial) =>
    relationCoversDenial(relation, denial),
  );
  if (pending.length === 0) {
    return { matched: 0, notified: 0, sessions: [] };
  }

  const now = Date.now();
  const ids = pending.map((denial) => denial.id);
  const placeholders = ids.map(() => "?").join(", ");
  getDb()
    .prepare(
      `
      UPDATE permission_denials
      SET resolved_at = ?, resolved_relation_id = ?
      WHERE id IN (${placeholders})
    `,
    )
    .run(now, relation.id, ...ids);

  const bySession = new Map<string, PermissionDenial[]>();
  for (const denial of pending) {
    const sessionName = resolveDenialSessionName(denial);
    if (!sessionName) continue;
    const bucket = bySession.get(sessionName) ?? [];
    bucket.push(denial);
    bySession.set(sessionName, bucket);
  }

  for (const [sessionName, denials] of bySession) {
    notifySessionPermissionGranted(sessionName, relation, denials, now);
  }

  if (bySession.size > 0) {
    getDb()
      .prepare(
        `
        UPDATE permission_denials
        SET notified_at = ?
        WHERE id IN (${placeholders})
          AND (session_name IS NOT NULL OR session_key IS NOT NULL)
      `,
      )
      .run(now, ...ids);
  }

  return {
    matched: pending.length,
    notified: bySession.size,
    sessions: [...bySession.keys()],
  };
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

function listPendingPermissionDenials(subjectType: string, subjectId: string): PermissionDenial[] {
  return listPermissionDenials({ subjectType, subjectId, resolved: false });
}

function relationCoversDenial(relation: Relation, denial: PermissionDenial): boolean {
  if (relation.subjectType !== denial.subjectType || relation.subjectId !== denial.subjectId) {
    return false;
  }

  if (relation.relation === "admin" && relation.objectType === "system" && relation.objectId === "*") {
    return true;
  }

  if (relation.relation === "use" && relation.objectType === "toolgroup") {
    if (denial.relation !== "use" || denial.objectType !== "tool") return false;
    return resolveToolGroup(relation.objectId)?.includes(denial.objectId) ?? false;
  }

  if (relation.relation !== denial.relation || relation.objectType !== denial.objectType) {
    return false;
  }

  if (relation.objectId === denial.objectId || relation.objectId === "*") {
    return true;
  }

  return relation.objectId.includes("*") && matchPattern(relation.objectId, denial.objectId);
}

function notifySessionPermissionGranted(
  sessionName: string,
  relation: Relation,
  denials: PermissionDenial[],
  now: number,
): void {
  const sample = denials[0];
  const deniedList = denials
    .map((denial) => `${denial.relation} ${denial.objectType}:${denial.objectId}`)
    .filter((value, index, list) => list.indexOf(value) === index)
    .slice(0, 5)
    .join(", ");
  const prompt = [
    `[Permission Granted: ${relation.relation} ${relation.objectType}:${relation.objectId} | Event: ravi.permissions.grant.resolved]`,
    `A permissão que tinha falhado nesta sessão foi concedida para agent:${relation.subjectId}.`,
    `Denial resolvido: ${deniedList || `${sample.relation} ${sample.objectType}:${sample.objectId}`}.`,
    "Tente novamente a ação bloqueada, se ela ainda for necessária.",
  ].join("\n");

  permissionDenialNotifier(sessionName, {
    prompt,
    event: "ravi.permissions.grant.resolved",
    permissionGrant: {
      subjectType: relation.subjectType,
      subjectId: relation.subjectId,
      relation: relation.relation,
      objectType: relation.objectType,
      objectId: relation.objectId,
      relationId: relation.id,
      resolvedDenialIds: denials.map((denial) => denial.id),
      timestamp: now,
    },
  }).catch((err) => {
    log.warn("Failed to publish permission grant event to session", { sessionName, error: err });
  });
}

function resolveDenialSessionName(denial: PermissionDenial): string | null {
  if (denial.sessionName) return denial.sessionName;
  if (!denial.sessionKey) return null;
  return getSession(denial.sessionKey)?.name ?? denial.sessionKey;
}

function getPermissionDenial(id: number): PermissionDenial | null {
  const row = getDb().prepare("SELECT * FROM permission_denials WHERE id = ?").get(id) as PermissionDenialRow | null;
  return row ? rowToPermissionDenial(row) : null;
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
