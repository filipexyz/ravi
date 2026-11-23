/**
 * Slack side of the grantor gate.
 *
 * `src/approval/grantor.ts` is channel-free: it asks a registered identity
 * resolver to turn a platform sender into a contact. This module is Slack's
 * resolver, plus the Slack-only lookups the legacy approval cards need (who in
 * a workspace could approve, which Slack user a contact is). Importing it
 * registers the resolver.
 */

import { registerGrantorIdentityResolver, actorCanGrantRequestedPermission } from "../../approval/grantor.js";
import { configStore } from "../../config-store.js";
import {
  isSlackHumanUserId,
  listOwnedPlatformIdentities,
  resolvePlatformIdentity,
  type PlatformIdentity,
} from "../../contacts.js";
import { logger } from "../../utils/logger.js";
import { resolveScopedSlackIdentity, resolveSlackInstanceAliases } from "./instance-alias.js";

const log = logger.child("slack:grantors");

type GrantorRouterConfig = Parameters<typeof resolveSlackInstanceAliases>[0];

const defaultLoadGrantorRouterConfig = (): GrantorRouterConfig => configStore.getConfig();
let loadGrantorRouterConfig = defaultLoadGrantorRouterConfig;

/** Without config the lookup stays on the received instance: narrower, never wider. */
function readGrantorRouterConfig(): GrantorRouterConfig {
  try {
    return loadGrantorRouterConfig();
  } catch (error) {
    log.warn("Slack grantor lookup could not read the router config", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function setApprovalGrantorRouterConfigForTest(loader?: () => GrantorRouterConfig): void {
  loadGrantorRouterConfig = loader ?? defaultLoadGrantorRouterConfig;
}

/** Upper bound on private approval cards sent for one request. */
export const MAX_SLACK_APPROVAL_GRANTORS = 20;

export interface SlackApprovalGrantorsInput {
  readonly instanceId: string;
  readonly permission?: string | null;
  readonly objectType?: string | null;
  readonly objectId?: string | null;
}

/**
 * Slack people who could approve this request: every human Slack identity of
 * the instance (its configured aliases plus the legacy empty scope) that is
 * owned by a contact and passes the same gate a click goes through. The card is
 * sent only to them, so nobody else sees a button they cannot use.
 */
export function listSlackApprovalGrantorUserIds(input: SlackApprovalGrantorsInput): string[] {
  const config = readGrantorRouterConfig();
  const aliases = resolveSlackInstanceAliases(config, input.instanceId);
  const candidates = new Set<string>();
  for (const identity of listOwnedPlatformIdentities({
    channel: "slack",
    instanceIds: [...aliases.scopedAliases, ""],
  })) {
    if (identity.ownerType !== "contact") continue;
    if (!isSlackHumanUserId(identity.platformUserId)) continue;
    candidates.add(identity.platformUserId.trim().toUpperCase());
  }

  const grantors: string[] = [];
  for (const userId of [...candidates].sort()) {
    const result = actorCanGrantRequestedPermission({
      channel: "slack",
      instanceId: input.instanceId,
      senderId: userId,
      permission: input.permission,
      objectType: input.objectType,
      objectId: input.objectId,
    });
    if (!result.allowed || result.subjectType !== "contact") continue;
    grantors.push(userId);
    if (grantors.length >= MAX_SLACK_APPROVAL_GRANTORS) break;
  }
  return grantors;
}

/**
 * The Slack user id of one contact in this instance, for card mentions. Display
 * names are never identity evidence; only a linked platform identity is.
 */
export function findSlackUserIdForContact(input: {
  readonly contactId: string;
  readonly instanceId?: string | null;
}): string | null {
  const contactId = input.contactId.trim();
  if (!contactId) return null;
  const config = readGrantorRouterConfig();
  const aliases = resolveSlackInstanceAliases(config, input.instanceId ?? null);
  for (const identity of listOwnedPlatformIdentities({
    channel: "slack",
    instanceIds: [...aliases.scopedAliases, ""],
  })) {
    if (identity.ownerType !== "contact" || identity.ownerId !== contactId) continue;
    if (!isSlackHumanUserId(identity.platformUserId)) continue;
    return identity.platformUserId.trim().toUpperCase();
  }
  return null;
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
  const config = readGrantorRouterConfig();
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

registerGrantorIdentityResolver("slack", (input) =>
  resolveSlackGrantorIdentity(input.senderId, input.instanceId ?? input.accountId),
);
