/**
 * The private-chat side of linking, answered by the daemon itself.
 *
 * A person in the linking state (see `link-states-db.ts`) who writes to the
 * agent in private gets a fixed answer, with no agent turn: the approval
 * link, a reminder while that link is still valid, or a new link once it
 * expired. The link watcher finishes the flow on approval.
 */

import type { LinkRequester } from "../cloud-auth/link-identity.js";
import { canonicalChannelId } from "../channels/capabilities.js";
import { logger } from "../utils/logger.js";
import { ensureLinkedDmRoute, type LinkDmRouteDeps } from "./link-dm-route.js";
import {
  createChannelLinkMessenger,
  linkAlreadyLinkedDmText,
  linkPendingDmText,
  linkUnavailableDmText,
  type LinkChatTarget,
} from "./link-dm.js";
import { getLocalLinkRequest } from "./link-requests-db.js";
import { sendLinkRequest, type IdentityLinkDeps } from "./link-service.js";
import { clearContactLinkState, getContactLinkState, markLinkSent } from "./link-states-db.js";
import { wakeLinkRequestWatcher } from "./link-watcher.js";

const log = logger.child("identity:link-dm-flow");

/** A direct message from a resolved contact, as the inbound consumer saw it. */
export interface LinkingDirectMessage {
  contactId: string;
  channel: string;
  /** Instance (account) name that received the message. */
  accountId: string;
  /** The private chat, as the platform names it (WhatsApp JID). */
  chatId: string;
  /** Route pattern of this sender (phone or LID), for the route created on approval. */
  routePattern: string;
  platformUserId: string;
  platformIdentityId: string | null;
  displayName: string | null;
}

export type LinkingDmDeps = IdentityLinkDeps & LinkDmRouteDeps & { wakeWatcher?: () => void };

/** True when the person is in the linking flow on this chat's instance; the consumer then calls the handler. */
export function isLinkingDirectMessage(
  message: Pick<LinkingDirectMessage, "contactId" | "channel" | "accountId">,
  now = Date.now(),
) {
  const state = getContactLinkState(message.contactId, now);
  return (
    state !== null &&
    state.accountId === message.accountId &&
    canonicalChannelId(state.channel) === canonicalChannelId(message.channel)
  );
}

/**
 * Answer a private message of a person in the linking flow. Returns false
 * when the person is not in it (the message goes on to the agent as usual).
 */
export async function handleLinkingDirectMessage(
  message: LinkingDirectMessage,
  deps: LinkingDmDeps = {},
): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  if (!isLinkingDirectMessage(message, now)) return false;
  const state = getContactLinkState(message.contactId, now);
  if (!state) return false;
  const messenger = deps.messenger ?? createChannelLinkMessenger();
  const target: LinkChatTarget = { channel: message.channel, accountId: message.accountId, chatId: message.chatId };
  const reply = async (text: string) => {
    try {
      await messenger.send(target, text);
    } catch (error) {
      log.warn("Linking reply failed", { accountId: message.accountId, error: errorText(error) });
    }
  };

  if (state.status === "link_sent" && state.requestId && state.requestExpiresAt && state.requestExpiresAt > now) {
    if (getLocalLinkRequest(state.requestId)?.status === "pending") {
      await reply(linkPendingDmText(Math.max(1, Math.round((state.requestExpiresAt - now) / 60_000))));
      return true;
    }
  }

  const requester: LinkRequester = {
    contactId: message.contactId,
    actorPrincipal: `contact:${message.contactId}`,
    platformUserId: message.platformUserId,
    platformIdentityId: message.platformIdentityId,
    displayName: message.displayName ?? state.displayName,
    origin: state.origin,
    platformIdentity: {
      channel: message.channel,
      accountId: message.accountId,
      platformUserId: message.platformUserId,
      ...(message.platformIdentityId ? { platformIdentityId: message.platformIdentityId } : {}),
    },
  };

  try {
    const sent = await sendLinkRequest(
      requester,
      { channel: "whatsapp", accountId: message.accountId, recipient: message.chatId },
      deps,
      { answeringDm: true },
    );
    if (sent.status === "already_linked") {
      clearContactLinkState(message.contactId);
      ensureLinkedDmRoute({ ...state, routePattern: message.routePattern }, deps);
      await reply(linkAlreadyLinkedDmText());
      return true;
    }
    markLinkSent({
      contactId: message.contactId,
      requestId: sent.requestId,
      requestExpiresAt: sent.expiresAtMs,
      dmChatId: sent.dmChatId,
      routePattern: message.routePattern,
      now,
    });
    (deps.wakeWatcher ?? wakeLinkRequestWatcher)();
  } catch (error) {
    log.warn("Linking DM could not send the approval link", {
      accountId: message.accountId,
      error: errorText(error),
    });
    await reply(linkUnavailableDmText());
  }
  return true;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
