import { getContact, getContactDetails, resolvePlatformIdentity, type PlatformIdentity } from "../contacts.js";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";

/**
 * How one channel turns a verified platform sender into a contact. A channel
 * whose identities are scoped in a way the generic lookup cannot read (Slack
 * workspaces and their aliases) registers its own; every other channel uses the
 * generic platform-identity lookup below.
 */
export type GrantorIdentityResolver = (input: {
  readonly senderId: string;
  /** Other forms of the same verified sender id (for example a namespaced LID). */
  readonly senderAliases?: readonly string[];
  readonly instanceId?: string | null;
  readonly accountId?: string;
}) => Pick<PlatformIdentity, "ownerType" | "ownerId"> | null;

const identityResolvers = new Map<string, GrantorIdentityResolver>();

export function registerGrantorIdentityResolver(channel: string, resolver: GrantorIdentityResolver): void {
  identityResolvers.set(channel.trim().toLowerCase(), resolver);
}

export function unregisterGrantorIdentityResolver(channel: string): void {
  identityResolvers.delete(channel.trim().toLowerCase());
}

export interface ApprovalGrantorInput {
  /** Other forms of the same verified sender id; the channel's own lookup decides what they mean. */
  readonly senderAliases?: readonly string[];
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

  const channelResolver = identityResolvers.get(input.channel.trim().toLowerCase());
  const identity = channelResolver
    ? channelResolver({
        senderId,
        ...(input.senderAliases?.length ? { senderAliases: input.senderAliases } : {}),
        ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
      })
    : resolveGrantorIdentity(
        input.channel,
        [senderId, ...(input.senderAliases ?? [])],
        [input.instanceId, input.accountId, ""],
      );
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
  senderIds: readonly string[],
  instanceCandidates: Array<string | null | undefined>,
): Pick<PlatformIdentity, "ownerType" | "ownerId"> | null {
  const senderId = senderIds[0] ?? "";
  const seen = new Set<string>();
  const owners = new Map<string, Pick<PlatformIdentity, "ownerType" | "ownerId">>();
  for (const platformUserId of senderIds) {
    for (const candidate of instanceCandidates) {
      const instanceId = candidate?.trim() ?? "";
      const key = `${channel}:${instanceId}:${platformUserId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const identity =
        typeof resolvePlatformIdentity === "function"
          ? resolvePlatformIdentity({
              channel,
              instanceId,
              platformUserId,
            })
          : null;
      if (identity?.ownerType && identity.ownerId) {
        owners.set(`${identity.ownerType}:${identity.ownerId}`, identity);
      }
    }
  }
  // One verified sender, one owner. Forms of the same sender that resolve to different owners
  // (a bare number and its namespaced `lid:` form) are ambiguous, and ambiguity never authorizes.
  if (owners.size > 1) return null;
  const [only] = owners.values();
  if (only) return only;

  // A namespaced sender (`lid:...`) is only its own identity: its digits are not a phone number,
  // so they must never reach the phone-based contact fallback below.
  if (senderIds.some((id) => id.startsWith("lid:"))) return null;

  // Prefer the canonical details lookup. `getContact` is a thin export and is
  // sometimes replaced by leaked bun test mocks that return a dummy object.
  const details = typeof getContactDetails === "function" ? getContactDetails(senderId) : null;
  if (details?.contact?.id) {
    return { ownerType: "contact", ownerId: details.contact.id };
  }

  const contact = typeof getContact === "function" ? getContact(senderId) : null;
  if (contact?.id) {
    return { ownerType: "contact", ownerId: contact.id };
  }
  return null;
}
