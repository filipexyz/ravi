import { publishSessionPrompt } from "../omni/session-stream.js";
import { getSessionsByAgent, resolveSession } from "../router/sessions.js";
import type { SessionEntry } from "../router/types.js";
import { logger } from "../utils/logger.js";
import type { Relation } from "./relations.js";

const log = logger.child("permissions:grant-notifications");

export function notifyPermissionGrantCreated(relation: Relation): void {
  const sessions = resolveGrantSessions(relation);
  if (sessions.length === 0) return;

  for (const session of sessions) {
    publishGrantPrompt(session, buildGrantPrompt(relation), {
      subjectType: relation.subjectType,
      subjectId: relation.subjectId,
      relation: relation.relation,
      objectType: relation.objectType,
      objectId: relation.objectId,
      grantMode: relation.grantMode,
      expiresAt: relation.expiresAt,
      source: relation.source,
    });
  }
}

export function notifyPermissionGrantsCreated(relations: Relation[]): void {
  const uniqueRelations = relations.filter(
    (relation, index) => relations.findIndex((item) => item.id === relation.id) === index,
  );
  if (uniqueRelations.length === 0) return;

  const sessions = new Map<string, SessionEntry>();
  for (const relation of uniqueRelations) {
    for (const session of resolveGrantSessions(relation)) {
      sessions.set(session.sessionKey, session);
    }
  }
  if (sessions.size === 0) return;

  const preview = uniqueRelations
    .slice(0, 8)
    .map((relation) => `${relation.relation} ${relation.objectType}:${relation.objectId}`)
    .join("\n");
  const extra = uniqueRelations.length > 8 ? `\n... +${uniqueRelations.length - 8} grants` : "";
  const prompt = [
    `[Permission Grants Created: ${uniqueRelations.length}]`,
    "Novas permissões foram concedidas para esta sessão/agent.",
    `${preview}${extra}`,
    "Se alguma ação foi bloqueada por falta dessas permissões, tente novamente.",
  ].join("\n");

  for (const session of sessions.values()) {
    publishGrantPrompt(session, prompt, {
      count: uniqueRelations.length,
      grants: uniqueRelations.map((relation) => ({
        subjectType: relation.subjectType,
        subjectId: relation.subjectId,
        relation: relation.relation,
        objectType: relation.objectType,
        objectId: relation.objectId,
        grantMode: relation.grantMode,
        expiresAt: relation.expiresAt,
        source: relation.source,
      })),
    });
  }
}

function resolveGrantSessions(relation: Relation): SessionEntry[] {
  const byKey = new Map<string, SessionEntry>();
  const add = (session: SessionEntry | null | undefined) => {
    if (!session) return;
    byKey.set(session.sessionKey, session);
  };

  if (relation.subjectType === "agent") {
    for (const session of getSessionsByAgent(relation.subjectId)) add(session);
  }
  if (relation.subjectType === "session" && isConcreteSessionId(relation.subjectId)) {
    add(resolveSession(relation.subjectId));
  }
  if (relation.objectType === "session" && isConcreteSessionId(relation.objectId)) {
    add(resolveSession(relation.objectId));
  }

  return Array.from(byKey.values());
}

function isConcreteSessionId(value: string): boolean {
  return value !== "*" && !value.includes("*");
}

function buildGrantPrompt(relation: Relation): string {
  const lifetime =
    relation.grantMode === "temporary" && relation.expiresAt
      ? `Grant temporário até ${new Date(relation.expiresAt * 1000).toISOString()}.`
      : "Grant permanente.";

  return [
    `[Permission Grant Created: ${relation.relation} ${relation.objectType}:${relation.objectId}]`,
    `Nova permissão concedida para ${relation.subjectType}:${relation.subjectId}.`,
    lifetime,
    "Se uma ação foi bloqueada por falta dessa permissão, tente novamente.",
  ].join("\n");
}

function publishGrantPrompt(session: SessionEntry, prompt: string, permissionGrant: Record<string, unknown>): void {
  const sessionName = session.name ?? session.sessionKey;
  publishSessionPrompt(sessionName, {
    event: "ravi.permissions.grant.created",
    prompt,
    permissionGrant,
  }).catch((error) => {
    log.warn("Failed to notify session about permission grant", {
      sessionName,
      error,
    });
  });
}
