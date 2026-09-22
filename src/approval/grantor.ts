import { getContact, resolvePlatformIdentity, type PlatformIdentity } from "../contacts.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "../permissions/provider-runtime.js";

export interface ApprovalGrantorInput {
  readonly channel: string;
  readonly accountId?: string;
  readonly instanceId?: string | null;
  readonly senderId?: string | null;
  readonly permission?: string | null;
  readonly objectType?: string | null;
  readonly objectId?: string | null;
}

export interface ApprovalGrantorResult {
  readonly allowed: boolean;
  readonly reason: "authorized_grantor" | "missing_actor" | "unresolved_identity" | "unauthorized_grantor";
  readonly subjectType?: "contact" | "agent";
  readonly subjectId?: string;
}

/**
 * Server-side grantor gate. Reuses the live permission materializer + capability
 * matcher. Button values, emoji, and client claims are not consulted here.
 */
export function actorCanGrantRequestedPermission(input: ApprovalGrantorInput): ApprovalGrantorResult {
  const senderId = input.senderId?.trim();
  if (!senderId) {
    return { allowed: false, reason: "missing_actor" };
  }

  const identity = resolveGrantorIdentity(input.channel, senderId, [input.instanceId, input.accountId]);
  if (
    !identity?.ownerType ||
    !identity.ownerId ||
    (identity.ownerType !== "contact" && identity.ownerType !== "agent")
  ) {
    return { allowed: false, reason: "unresolved_identity" };
  }

  const capabilities = materializeSubjectCapabilities(identity.ownerType, identity.ownerId);
  const permission = input.permission?.trim();
  const objectType = input.objectType?.trim();
  const objectId = input.objectId?.trim();
  const allowed =
    permission && objectType && objectId
      ? canWithCapabilities(capabilities, permission, objectType, objectId)
      : canWithCapabilities(capabilities, "admin", "system", "*");

  return {
    allowed,
    reason: allowed ? "authorized_grantor" : "unauthorized_grantor",
    subjectType: identity.ownerType,
    subjectId: identity.ownerId,
  };
}

function resolveGrantorIdentity(
  channel: string,
  senderId: string,
  instanceCandidates: Array<string | null | undefined>,
): Pick<PlatformIdentity, "ownerType" | "ownerId"> | null {
  const seen = new Set<string>();
  for (const candidate of instanceCandidates) {
    const instanceId = candidate?.trim() ?? "";
    const key = `${channel}:${instanceId}:${senderId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const identity = resolvePlatformIdentity({
      channel,
      instanceId,
      platformUserId: senderId,
    });
    if (identity?.ownerType && identity.ownerId) return identity;
  }

  const contact = getContact(senderId);
  if (contact?.id) {
    return { ownerType: "contact", ownerId: contact.id };
  }
  return null;
}
