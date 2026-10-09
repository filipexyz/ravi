import type { ContextRecord } from "../router/router-db.js";
import { CloudAuthError } from "./errors.js";
import type { ActorPlatformIdentity } from "./types.js";

export type LinkRequesterFailureReason = "no_context" | "actor_not_human" | "missing_contact";

/** Where the request was made: the chat, thread and message the confirmation answers. */
export interface LinkOrigin {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
  sourceMessageId?: string;
}

/**
 * The author of the current chat message, as the daemon resolved it for the
 * turn. `ravi link` acts only for this person: there is no flag to name
 * another contact, and the private message goes to this sender only.
 */
export interface LinkRequester {
  contactId: string;
  actorPrincipal: string;
  /** Sender id on the chat platform (Slack user id, WhatsApp JID/phone). Null when the turn has none. */
  platformUserId: string | null;
  platformIdentityId: string | null;
  displayName: string | null;
  origin: LinkOrigin | null;
  platformIdentity: ActorPlatformIdentity | null;
}

/**
 * Resolve the person `ravi link` acts for from the runtime context of the
 * turn. Only a resolved human contact qualifies; agents, automations and
 * unknown senders fail with `CONTACT_REQUIRED` and a `details.reason`.
 * There is no fallback to other metadata fields.
 */
export function resolveLinkRequester(context: ContextRecord | null | undefined): LinkRequester {
  if (!context) {
    throw contactRequired(
      "no_context",
      "ravi link runs inside a chat turn and links the author of the current message.",
    );
  }

  const metadata = asRecord(context.metadata) ?? {};
  const actor = asRecord(metadata.actor) ?? {};
  const actorPrincipal = firstString(metadata.actorPrincipal);

  if (actorPrincipal && !actorPrincipal.startsWith("contact:") && actorPrincipal !== "unknown") {
    throw contactRequired(
      "actor_not_human",
      "The current turn was not started by a person, so there is no one to link.",
    );
  }

  const contactId = actorPrincipal?.startsWith("contact:") ? actorPrincipal.slice("contact:".length).trim() : "";
  const actorContactId = firstString(actor.contactId);
  if (
    !contactId ||
    metadata.actorResolution !== "resolved" ||
    (actor.actorType !== undefined && actor.actorType !== "contact") ||
    (actorContactId !== null && actorContactId !== contactId)
  ) {
    throw contactRequired(
      "missing_contact",
      "The author of the current message is not a resolved contact, so Ravi cannot tell who to link.",
    );
  }

  const source = context.source;
  const channel = firstString(actor.channel, source?.channel);
  const accountId = firstString(actor.accountId, source?.accountId);
  const chatId = firstString(actor.chatId, source?.chatId);
  const threadId = firstString(actor.threadId, source?.threadId);
  const sourceMessageId = firstString(actor.sourceMessageId);
  const platformUserId = firstString(actor.rawSenderId);
  const platformIdentityId = firstString(actor.platformIdentityId);

  const platformIdentity: ActorPlatformIdentity = {
    ...(channel ? { channel } : {}),
    ...(accountId ? { accountId } : {}),
    ...(platformUserId ? { platformUserId } : {}),
    ...(platformIdentityId ? { platformIdentityId } : {}),
  };

  return {
    contactId,
    actorPrincipal: `contact:${contactId}`,
    platformUserId,
    platformIdentityId,
    displayName: firstString(actor.senderName, metadata.actorDisplayName),
    origin:
      channel && accountId && chatId
        ? {
            channel,
            accountId,
            chatId,
            ...(threadId ? { threadId } : {}),
            ...(sourceMessageId ? { sourceMessageId } : {}),
          }
        : null,
    platformIdentity: Object.keys(platformIdentity).length > 0 ? platformIdentity : null,
  };
}

function contactRequired(reason: LinkRequesterFailureReason, message: string): CloudAuthError {
  return new CloudAuthError("CONTACT_REQUIRED", message, { details: { reason } });
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
