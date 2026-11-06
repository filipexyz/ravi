import { getContactById } from "../contacts.js";
import { currentConnectorRuntimeContext, type ConnectorTurnDeps } from "../link/connector-turn.js";
import { dbGetContext, type ContextRecord } from "../router/router-db.js";
import { resolveRuntimeTurnOrigin } from "../runtime/turn-origin.js";
import { isOrdinaryContextRetirement } from "../runtime/context-revocation.js";
import {
  formatContactGrantScope,
  resolveContactChatOverlay,
} from "../permissions/contact-policy-permissions-provider.js";

/**
 * Resolve the person behind an admitted handoff, without changing its agent
 * producer or borrowing the operator's login identity. Each edge must have
 * been admitted while its caller credential was valid, for this exact target.
 * Normal turn completion may happen before delivery; withdrawal of authority,
 * blocked contacts and an expired current credential still fail closed.
 * Console remains responsible for the person's current link and resource ACL.
 */
export function resolveDelegatedAccessContact(
  deps: ConnectorTurnDeps = {},
): { contactId: string; agentId: string } | null {
  const now = deps.now ?? Date.now();
  const runtime = deps.runtimeContext ?? currentConnectorRuntimeContext(deps.env);
  if (!runtime.present || !runtime.record || runtime.spawnedPrincipal) return null;
  const getById = deps.getContextById ?? dbGetContext;
  const seen = new Set<string>();
  let cursor: ContextRecord | null = runtime.record;

  // CLI children may provide metadata. Only a host-issued turn may establish
  // delegation; walk the live credential lineage instead of trusting those fields.
  while (cursor && cursor.kind !== "turn-runtime") {
    if (!visit(cursor, seen) || !live(cursor, now)) return null;
    const parent = cursor.metadata?.parentContextId;
    if (typeof parent !== "string") return null;
    const parentRecord = getById(parent);
    if (!parentRecord || parentRecord.agentId !== cursor.agentId || parentRecord.sessionKey !== cursor.sessionKey)
      return null;
    cursor = parentRecord;
  }
  if (!cursor || !live(cursor, now)) return null;
  const executorAgentId = cursor.agentId;
  if (!executorAgentId) return null;
  let hasHandoff = false;
  let latestAdmission = now;

  while (cursor && visit(cursor, seen)) {
    if (withdrawn(cursor)) return null;
    const metadata = cursor.metadata ?? {};
    const principal = typeof metadata.actorPrincipal === "string" ? metadata.actorPrincipal : "";
    if (principal.startsWith("contact:")) {
      if (!hasHandoff || metadata.actorResolution !== "resolved") return null;
      const contactId = principal.slice("contact:".length).trim();
      if (!contactId) return null;
      const actor = metadata.actor as { actorType?: unknown; contactId?: unknown } | undefined;
      if (
        actor &&
        ((actor.actorType !== undefined && actor.actorType !== "contact") ||
          (actor.contactId !== undefined && actor.contactId !== contactId))
      )
        return null;
      const contact = deps.getContactStatus
        ? { status: deps.getContactStatus(contactId), opt_out: false }
        : getContactById(contactId);
      // Recheck the original scope, including a removal whose invalidation
      // write failed. Reading a person's identity must not revive its grants.
      if (metadata.userOverlay === "active") {
        const chat = metadata.userOverlayChat;
        const admitted = metadata.userOverlayGrants;
        if (typeof chat !== "string" || !chat.startsWith("chat:") || !Array.isArray(admitted) || !admitted.length)
          return null;
        const overlay = resolveContactChatOverlay({ contactId, chatId: chat.slice("chat:".length) });
        const current = new Set(
          overlay.grants.map((grant) => `${grant.profile}@${formatContactGrantScope(grant.scope)}`),
        );
        if (!overlay.eligible || admitted.some((grant) => typeof grant !== "string" || !current.has(grant)))
          return null;
      }
      // Pending/discovered group members may hold explicit scoped grants. This
      // resolves identity only; the existing runtime ceiling/overlay still gates tools.
      return contact && ["allowed", "pending", "discovered"].includes(contact.status ?? "") && !contact.opt_out
        ? { contactId, agentId: executorAgentId }
        : null;
    }

    const origin = resolveRuntimeTurnOrigin(metadata.turnOrigin);
    const admission = origin?.delegation;
    if (
      !origin ||
      origin.producer === "signals" ||
      origin.principal.type !== "agent" ||
      !origin.callerContextId ||
      !admission ||
      admission.targetSessionKey !== cursor.sessionKey ||
      admission.admittedAt > latestAdmission ||
      admission.admittedAt > cursor.createdAt ||
      principal !== `agent:${origin.principal.id}`
    )
      return null;
    const caller = getById(origin.callerContextId);
    if (
      !caller ||
      caller.agentId !== origin.principal.id ||
      caller.sessionKey !== admission.callerSessionKey ||
      (origin.producer === "session-relay" && origin.session?.key !== caller.sessionKey) ||
      !validAtAdmission(caller, admission.admittedAt)
    )
      return null;
    latestAdmission = admission.admittedAt;
    let delegatedCaller: ContextRecord = caller;
    // A command may run under a derived CLI credential. Its live-at-admission
    // parent chain, not any caller-supplied actor fields, supplies the person.
    while (delegatedCaller.kind !== "turn-runtime") {
      if (!visit(delegatedCaller, seen) || !validAtAdmission(delegatedCaller, latestAdmission)) return null;
      const parentId: unknown = delegatedCaller.metadata?.parentContextId;
      const parent: ContextRecord | null = typeof parentId === "string" ? getById(parentId) : null;
      if (
        !parent ||
        parent.agentId !== delegatedCaller.agentId ||
        parent.sessionKey !== delegatedCaller.sessionKey ||
        !validAtAdmission(parent, latestAdmission)
      )
        return null;
      delegatedCaller = parent;
    }
    cursor = delegatedCaller;
    hasHandoff = true;
  }
  return null;
}

function visit(context: ContextRecord, seen: Set<string>): boolean {
  if (seen.has(context.contextId)) return false;
  seen.add(context.contextId);
  return true;
}

function withdrawn(context: ContextRecord): boolean {
  return (
    typeof context.metadata?.permissionProfileRevokedAt === "number" ||
    typeof context.metadata?.authorityRevokedAt === "number" ||
    context.metadata?.userOverlayEligible === false ||
    Boolean(context.revokedAt && !isOrdinaryContextRetirement(context.metadata?.revocationReason))
  );
}

function live(context: ContextRecord, now: number): boolean {
  return (
    context.createdAt <= now &&
    !(context.revokedAt && context.revokedAt <= now) &&
    !(context.expiresAt && context.expiresAt <= now) &&
    !withdrawn(context)
  );
}

function validAtAdmission(context: ContextRecord, at: number): boolean {
  return (
    context.createdAt <= at &&
    !(context.expiresAt && context.expiresAt <= at) &&
    !(context.revokedAt && context.revokedAt < at) &&
    !withdrawn(context)
  );
}
