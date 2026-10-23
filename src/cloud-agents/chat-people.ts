/**
 * Who a cloud run's person is in chat. The Console names the run actor by its
 * Console user id; on this installation that person is the contact they linked
 * with `ravi link` (or, for the operator, the owner contact). Only that
 * contact's button click or reply counts as theirs; the Console still decides
 * whether the decision is allowed (contract F1 "Approvals from chat").
 *
 * Slack people resolve exactly like the approval grantors of #715: the
 * instance's configured aliases, then the legacy empty scope.
 */

import { resolveScopedSlackIdentity, resolveSlackInstanceAliases } from "../channels/slack/instance-alias.js";
import { resolveSlackThreadRequester } from "../channels/slack/thread-requester.js";
import { configStore } from "../config-store.js";
import {
  findContactsByTag,
  getContactById,
  isSlackHumanUserId,
  listOwnedPlatformIdentities,
  resolvePlatformIdentity,
} from "../contacts.js";
import { OWNER_CONTACT_TAG } from "../knowledge/owner.js";
import { resolveTurnForActiveLogin } from "../pages/read.js";
import { logger } from "../utils/logger.js";
import { dbListCloudThreadsForRun } from "./chat-db.js";
import type { CloudAgentsSession } from "./client.js";

const log = logger.child("cloud-agents:chat-people");

type AliasConfig = Parameters<typeof resolveSlackInstanceAliases>[0];

function routerConfig(): AliasConfig {
  try {
    return configStore.getConfig();
  } catch {
    return null;
  }
}

/** The owner contact (tagged `permission-owner`), when exactly one is. */
export function ownerContactId(): string | null {
  try {
    const owners = findContactsByTag(OWNER_CONTACT_TAG);
    return owners.length === 1 ? (owners[0]?.id ?? null) : null;
  } catch {
    return null;
  }
}

export function contactName(contactId: string | null | undefined): string | null {
  if (!contactId) return null;
  try {
    return getContactById(contactId)?.name?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The run's person on this installation: the contact recorded when the run
 * was bound to this chat, else the contact the Console user linked here, else
 * the owner contact when the run acts as the operator of this login. Null
 * when none is known: then nobody can decide in chat.
 */
export async function resolveRunActorContact(
  session: CloudAgentsSession,
  input: { runId: string; actorUserId: string | null },
): Promise<string | null> {
  const bound = dbListCloudThreadsForRun(input.runId).find((thread) => thread.actorContactId);
  if (bound?.actorContactId) return bound.actorContactId;
  if (!input.actorUserId) return null;
  try {
    const linked = await session.client.resolveLinkedContact(input.actorUserId);
    if (linked) return linked;
  } catch (error) {
    log.debug("Could not resolve the run actor's linked contact", {
      runId: input.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (session.userId && session.userId === input.actorUserId) return ownerContactId();
  return null;
}

/** The Slack user ids of a contact in this Slack instance (human users only). */
export function slackUserIdsForContact(contactId: string, instanceId: string): string[] {
  const aliases = resolveSlackInstanceAliases(routerConfig(), instanceId);
  const ids = new Set<string>();
  for (const identity of listOwnedPlatformIdentities({
    channel: "slack",
    instanceIds: [...aliases.scopedAliases, ""],
  })) {
    if (identity.ownerType !== "contact" || identity.ownerId !== contactId) continue;
    if (!isSlackHumanUserId(identity.platformUserId)) continue;
    ids.add(identity.platformUserId.trim().toUpperCase());
  }
  return [...ids].sort();
}

/** The contact a Slack user is in this instance, resolved like a message author. */
export function slackUserContactId(userId: string, instanceId: string | null | undefined): string | null {
  const aliases = resolveSlackInstanceAliases(routerConfig(), instanceId);
  const resolution = resolveScopedSlackIdentity(
    aliases,
    (scope) => resolvePlatformIdentity({ channel: "slack", instanceId: scope, platformUserId: userId }),
    (identity) => (identity.ownerType && identity.ownerId ? `${identity.ownerType}:${identity.ownerId}` : null),
  );
  const identity = resolution.identity;
  return identity?.ownerType === "contact" && identity.ownerId ? identity.ownerId : null;
}

/**
 * The person of the turn running a command, from the daemon's own record of
 * the turn (never from values the agent's shell could change): their contact
 * (the owner contact for the operator) and their name. A run started in this
 * turn acts as them, so they are the run's person in a bound thread.
 */
export function currentTurnPerson(): { contactId: string | null; name: string | null } {
  let contactId: string | null = null;
  try {
    const result = resolveTurnForActiveLogin();
    const turn = result.ok ? result.turn : (result.relay ?? result.candidate);
    const speaker = turn?.speaker;
    if ((speaker?.kind === "contact" || speaker?.kind === "owner") && speaker.contactId) contactId = speaker.contactId;
    else if (speaker?.kind === "owner" || speaker?.kind === "terminal") contactId = ownerContactId();
  } catch (error) {
    log.debug("Turn person unresolved", { error: error instanceof Error ? error.message : String(error) });
  }
  return { contactId, name: resolveSlackThreadRequester() ?? contactName(contactId) };
}
