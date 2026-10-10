import { resolveScopedSlackIdentity, resolveSlackInstanceAliases } from "../channels/slack/instance-alias.js";
import { configStore } from "../config-store.js";
import { getContact, getContactDetails, resolvePlatformIdentity, type PlatformIdentity } from "../contacts.js";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";

type GrantorRouterConfig = Parameters<typeof resolveSlackInstanceAliases>[0];

const defaultLoadGrantorRouterConfig = (): GrantorRouterConfig => configStore.getConfig();
let loadGrantorRouterConfig = defaultLoadGrantorRouterConfig;

export function setApprovalGrantorRouterConfigForTest(loader?: () => GrantorRouterConfig): void {
  loadGrantorRouterConfig = loader ?? defaultLoadGrantorRouterConfig;
}

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

  const identity =
    input.channel.trim().toLowerCase() === "slack"
      ? resolveSlackGrantorIdentity(senderId, input.instanceId ?? input.accountId)
      : resolveGrantorIdentity(input.channel, senderId, [input.instanceId, input.accountId, ""]);
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

/**
 * A Slack clicker resolves exactly like a Slack message author
 * (`resolveSlackActorIdentity`): only the receiving instance's configured
 * aliases, then the empty legacy scope. No cross-instance or cross-channel
 * fallback, so a sender who is "unknown" to the turn cannot be an owner here.
 */
function resolveSlackGrantorIdentity(
  senderId: string,
  instanceId: string | null | undefined,
): Pick<PlatformIdentity, "ownerType" | "ownerId"> | null {
  let config: GrantorRouterConfig = null;
  try {
    config = loadGrantorRouterConfig();
  } catch {
    // Without config the lookup stays on the received instance (and the empty
    // legacy scope): narrower, never wider.
  }
  // Only the request's own instance: the stored account id can be stale and name
  // another workspace, so it is never used as a fallback scope.
  const aliases = resolveSlackInstanceAliases(config, instanceId);
  const resolution = resolveScopedSlackIdentity(
    aliases,
    (scope) => resolvePlatformIdentity({ channel: "slack", instanceId: scope, platformUserId: senderId }),
    (identity) => (identity.ownerType && identity.ownerId ? `${identity.ownerType}:${identity.ownerId}` : null),
  );
  return resolution.identity;
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
    const identity =
      typeof resolvePlatformIdentity === "function"
        ? resolvePlatformIdentity({
            channel,
            instanceId,
            platformUserId: senderId,
          })
        : null;
    if (identity?.ownerType && identity.ownerId) return identity;
  }

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
