import type { ContextCapability } from "../router/router-db.js";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import { buildEffectiveCapabilities } from "../permissions/delegation.js";
import { BridgeError, type BridgeGrant } from "./protocol.js";
import { getBridgeStore, type BridgeStore, type Enrollment, type TurnRow } from "./store.js";

export function bridgeTurnAuthority(
  turnId: string,
  store: BridgeStore = getBridgeStore(),
): { turn: TurnRow; enrollment: Enrollment; grant: BridgeGrant } | null {
  const turn = store.turn(turnId);
  if (
    !turn ||
    !["queued", "running", "awaiting_approval"].includes(turn.status) ||
    turn.cancel_requested ||
    turn.lease_until <= Date.now()
  )
    return null;
  const grant = JSON.parse(turn.authority) as BridgeGrant;
  const enrollment = store.enrollment(grant.enrollmentId);
  if (!enrollment?.active || enrollment.epoch !== grant.epoch || grant.exp * 1000 <= Date.now() || !grant.canSend)
    return null;
  const c = store.conversation(turn.conversation_id);
  if (
    !c ||
    !store.hasParticipant(c, grant.sub) ||
    c.project_id !== grant.projectId ||
    c.enrollment_id !== enrollment.id ||
    !grant.agents.some((a) => a.id === (store.turnAgent(turnId) ?? c.agent_id))
  )
    return null;
  return { turn, enrollment, grant };
}
export function bridgeContextLive(metadata: Record<string, unknown> | null | undefined): boolean {
  const id = metadata?.bridgeTurnId;
  return id === undefined || (typeof id === "string" && bridgeTurnAuthority(id) !== null);
}
export function bridgeCapabilityAllowed(
  metadata: Record<string, unknown> | null | undefined,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  if (metadata?.bridgeTurnId === undefined) return true;
  if (typeof metadata.bridgeTurnId !== "string") return false;
  const authority = bridgeTurnAuthority(metadata.bridgeTurnId);
  if (!authority) return false;
  const c = getBridgeStore().conversation(authority.turn.conversation_id)!;
  if (permission === "access" && objectType === "session" && ![c.session_name, c.session_key].includes(objectId))
    return false;
  return canWithCapabilities(
    authority.grant.agents.find((a) => a.id === (getBridgeStore().turnAgent(authority.turn.id) ?? c.agent_id))!
      .capabilities,
    permission,
    objectType,
    objectId,
  );
}
/** A root bridge turn follows the current signed Console decision. Child attenuation remains binding. */
export function bridgeContextCapabilities(
  context: { kind?: string | null; capabilities: ContextCapability[]; metadata?: Record<string, unknown> | null },
  store?: BridgeStore,
): ContextCapability[] {
  const id = context.metadata?.bridgeTurnId;
  if (id === undefined) return context.capabilities;
  store ??= getBridgeStore();
  const authority = typeof id === "string" ? bridgeTurnAuthority(id, store) : null;
  if (!authority) return [];
  const c = store.conversation(authority.turn.conversation_id)!;
  const capabilities = authority.grant.agents.find(
    (a) => a.id === (store.turnAgent(authority.turn.id) ?? c.agent_id),
  )!.capabilities;
  return context.kind === "turn-runtime"
    ? capabilities
    : buildEffectiveCapabilities({ agentCapabilities: capabilities, actorCapabilities: context.capabilities });
}
export function resolveBridgeInvocation(turnId: string, sessionKey: string, agentId: string) {
  const store = getBridgeStore(),
    authority = bridgeTurnAuthority(turnId, store);
  if (!authority) throw new BridgeError("ACCESS_REVOKED");
  const c = store.conversation(authority.turn.conversation_id)!;
  if (c.session_key !== sessionKey || (store.turnAgent(turnId) ?? c.agent_id) !== agentId)
    throw new BridgeError("NOT_FOUND_OR_DENIED");
  const capabilities = authority.grant.agents.find((a) => a.id === agentId)!.capabilities;
  return {
    capabilities,
    source: { channel: "console", accountId: authority.enrollment.id, chatId: c.id },
    metadata: {
      authorityMode: "delegated",
      authorityResolver: "console-bridge-v2",
      actorAuthorizationMode: "console-bridge",
      actorPrincipal: `console:${authority.grant.iss}:${authority.grant.sub}`,
      actorResolution: "resolved",
      consoleUserId: authority.grant.sub,
      consoleOrgId: authority.grant.orgId,
      bridgeTurnId: turnId,
      bridgeConversationId: c.id,
      executorAgentId: agentId,
      turnCapabilities: capabilities,
      effectiveCapabilityCount: capabilities.length,
    },
  };
}
