import { getContactDetails } from "../contacts.js";
import { dbGetContext, type ContextRecord } from "../router/router-db.js";
import { AGENT_IDENTITY_AUTHORITY_MODE } from "../permissions/agent-identity-permissions-provider.js";
import { TURN_SCOPED_AUTHORITY_KIND } from "../permissions/delegation.js";
import type { RuntimeLaunchPrompt, RuntimeTurnOriginMetadata } from "./message-types.js";
import { resolveRuntimeTurnOrigin } from "./turn-origin.js";

export interface HumanRequestCaller {
  caller: ContextRecord;
  contactId: string;
  originContextId: string;
}

const COMPLETED_TURN_REASONS = new Set([
  "turn_context_rotated",
  "turn_context_completed",
  "stale_turn_context_reclaimed",
]);

/** Work handoffs preserve a human request; notifications and returns do not. */
export function isWorkHandoff(origin: RuntimeTurnOriginMetadata): boolean {
  return (
    (origin.producer === "channel" && origin.action === "session.bootstrap") ||
    (origin.producer === "session-relay" && ["send", "ask", "execute"].includes(origin.action))
  );
}

/**
 * The trusted prompt producer captures the authenticated caller context when
 * dispatching. Resolve that exact immutable turn, never the session's latest
 * speaker or a contact supplied in the new prompt. The internal prompt bus is
 * the authentication boundary for callerContextId (see turn-origin.ts).
 * Ordinary completion/rotation does not cancel admitted queued work; authority
 * revocation, missing ancestry and CLI-issued lookalikes fail closed.
 */
export function resolveHumanRequestCaller(prompt: Pick<RuntimeLaunchPrompt, "_turnOrigin">): HumanRequestCaller | null {
  let origin = resolveRuntimeTurnOrigin(prompt._turnOrigin);
  let first: ContextRecord | undefined;
  let contactId: string | undefined;
  const seen = new Set<string>();
  while (origin && isWorkHandoff(origin) && origin.principal.type === "agent" && origin.callerContextId) {
    if (seen.has(origin.callerContextId) || seen.size >= 32) return null;
    seen.add(origin.callerContextId);
    const caller = dbGetContext(origin.callerContextId);
    const meta = caller?.metadata;
    if (
      !caller ||
      caller.kind !== TURN_SCOPED_AUTHORITY_KIND ||
      !meta ||
      meta.authorityMode !== AGENT_IDENTITY_AUTHORITY_MODE ||
      meta.parentContextId !== undefined ||
      meta.bridgeTurnId !== undefined ||
      meta.actorResolution !== "resolved" ||
      caller.agentId !== origin.principal.id ||
      (origin.producer === "session-relay" && origin.session?.key && origin.session.key !== caller.sessionKey) ||
      typeof meta.permissionProfileRevokedAt === "number" ||
      (caller.revokedAt && !COMPLETED_TURN_REASONS.has(String(meta.revocationReason)))
    )
      return null;

    const principal = typeof meta.actorPrincipal === "string" ? meta.actorPrincipal : "";
    const id = principal.startsWith("contact:") ? principal.slice(8).trim() : "";
    const actor = meta.actor as Record<string, unknown> | undefined;
    if (!id || actor?.actorType !== "contact" || actor.contactId !== id || (contactId && contactId !== id)) return null;
    first ??= caller;
    contactId = id;

    // A handoff may chain, but every hop must still resolve to the same human
    // inbound. A routine carrying a contact is not a new human request.
    if (meta.turnOrigin) {
      origin = resolveRuntimeTurnOrigin(meta.turnOrigin);
      continue;
    }
    const provenance = meta.turnProvenance as Record<string, unknown> | undefined;
    if (provenance?.origin !== "human") return null;
    const contact = getContactDetails(id, { includeDuplicateCandidates: false });
    if (!contact || contact.policy?.status === "blocked" || contact.policy?.optOut) return null;
    return { caller: first, contactId: id, originContextId: caller.contextId };
  }
  return null;
}
