// A direct message from anyone but the installation owner never lands in an
// agent's shared DM session (spec channels/owner-dm-guard).
//
// `dmScope: "main"` collapses every DM of an agent into one session,
// `agent:<id>:main`. On an operator's own agent that session carries the
// owner's history and the agent's instructions; before this guard any
// colleague who DMed the bot on an `open` instance landed in it (04/11).
//
// The guard runs after route matching and subscription rerouting, before the
// session row is committed, on the key the commit will produce
// (`previewCommittedSessionKey`): a route that forces a session redirects
// there, so the preliminary `matched.sessionKey` is not where the message
// lands. It admits only contacts tagged `permission-owner`, whatever a route
// or an attached chat says: everyone else is held for owner review, the same
// path a `pairing` DM takes. To let a person talk to an agent, the owner gives
// them a session of their own (a route with `--session <name>`, or an agent
// whose `dmScope` is not `main`).
//
// Since no one else's direct message can land there, the shared session is the
// owner's own direct session as long as nothing else writes in it either
// (`isSharedDmSessionPrivateToOwner`). That is what lets the owner's verified
// DM count as the operator's turn (src/link/connector-turn.ts).
//
// With no contact tagged `permission-owner` the guard admits everything
// (fail-open), and the shared session is never private.

import { findContactsByTag } from "../contacts.js";
import { dmContactForChat } from "../knowledge/contacts.js";
import { OWNER_CONTACT_TAG } from "../knowledge/owner.js";
import {
  dbGetChat,
  dbGetThreadParentChat,
  dbListRoutesBySessionName,
  dbListSessionChatSubscriptions,
} from "../router/router-db.js";
import { parseSessionKey } from "../router/session-key.js";
import { logger } from "../utils/logger.js";

const log = logger.child("channels:owner-dm-guard");

export interface OwnerDmGuardInput {
  /** Peer kind of the inbound conversation. Only direct messages are guarded. */
  peerKind: string;
  /** Session the inbound would land in, after route matching and any subscription reroute. */
  sessionKey: string;
  /** Contact the sender resolved to, when known. Unknown senders are never the owner. */
  senderContactId: string | null | undefined;
}

export interface OwnerDmGuardDeps {
  /** Contacts tagged `permission-owner`. */
  ownerContactIds?: () => string[];
}

export type OwnerDmGuardResult =
  | { blocked: false; reason: "not_dm" | "not_owner_session" | "owner" | "no_owner_configured" }
  | { blocked: true; reason: "non_owner_dm_to_owner_session"; ownerCount: number };

/** Whether the session key is an agent's shared DM session (`agent:<id>:main`) or a thread under it. */
export function isSharedOwnerSessionKey(sessionKey: string): boolean {
  return parseSessionKey(sessionKey)?.dmScope === "main";
}

/** Whether the key is exactly an agent's shared DM session, `agent:<id>:main`, and not a thread under it. */
export function isAgentSharedDmSessionKey(sessionKey: string | null | undefined): boolean {
  const parts = (sessionKey ?? "").split(":");
  return parts.length === 3 && parts[0] === "agent" && parts[1] !== "" && parts[2] === "main";
}

/**
 * Whether a route pattern reaches direct chats only: one literal peer id. A
 * glob (`*`, `5511*`) also matches group targets (`group:<id>`), and `group:`
 * and `thread:` patterns name conversations other people write in, which this
 * guard does not cover.
 */
export function isDirectPeerRoutePattern(pattern: string | null | undefined): boolean {
  const trimmed = pattern?.trim().toLowerCase();
  if (!trimmed || trimmed.includes("*")) return false;
  return !trimmed.startsWith("group:") && !trimmed.startsWith("thread:");
}

export function evaluateOwnerDmGuard(input: OwnerDmGuardInput, deps: OwnerDmGuardDeps = {}): OwnerDmGuardResult {
  if (input.peerKind !== "dm") return { blocked: false, reason: "not_dm" };
  if (!isSharedOwnerSessionKey(input.sessionKey)) return { blocked: false, reason: "not_owner_session" };

  const owners = readOwnerContactIds(deps);
  if (owners === null) {
    // The owner set could not be read: fail closed.
    return { blocked: true, reason: "non_owner_dm_to_owner_session", ownerCount: 0 };
  }
  if (owners.size === 0) {
    // No owner tagged yet (a fresh installation before its operator is
    // known). There is nobody to protect the session for and nobody to review
    // a held message, so the legacy behaviour stays: fail-open until an owner
    // contact is tagged. Nothing reports this state yet.
    return { blocked: false, reason: "no_owner_configured" };
  }
  const sender = input.senderContactId?.trim();
  if (sender && owners.has(sender)) return { blocked: false, reason: "owner" };
  return { blocked: true, reason: "non_owner_dm_to_owner_session", ownerCount: owners.size };
}

export interface SharedDmSessionPrivacyInput {
  /** The session the turn runs in. */
  sessionKey: string;
  sessionName: string;
  /** The speaker's contact. */
  contactId: string;
  /** The chat the turn came from: the speaker's own direct chat, already verified. */
  chatId: string;
}

export interface SharedDmSessionPrivacyDeps {
  /** Contacts tagged `permission-owner`. */
  ownerContactIds?: () => string[];
  /** Patterns of the active routes that send chats into the session by name. */
  routePatternsForSessionName?: (sessionName: string) => string[];
  /** Chats attached to the session. */
  attachedChatIds?: (sessionKey: string) => string[];
  /** Whether the chat is the contact's own direct chat, or a thread inside it. */
  isContactsDirectChat?: (chatId: string, contactId: string) => boolean;
}

/**
 * Whether an agent's shared DM session (`agent:<id>:main`) is the speaker's
 * alone, so what their accounts return stays in a transcript only they read.
 * The guard above lets only owners' direct messages land there. On top of it:
 * - the speaker is the one contact tagged `permission-owner`. With two tagged
 *   owners both land there; with none, the guard admits everyone;
 * - every route that sends chats into the session by name reaches one direct
 *   peer (`isDirectPeerRoutePattern`): a group, a thread or a glob would bring
 *   conversations the guard does not cover;
 * - every chat attached to the session is the speaker's own direct chat or a
 *   thread inside it. An attached chat can also receive the session's answers.
 * Anything that cannot be read is not private.
 */
export function isSharedDmSessionPrivateToOwner(
  input: SharedDmSessionPrivacyInput,
  deps: SharedDmSessionPrivacyDeps = {},
): boolean {
  const contactId = input.contactId?.trim();
  if (!contactId || !input.sessionName?.trim() || !isAgentSharedDmSessionKey(input.sessionKey)) return false;
  try {
    const owners = new Set(
      (deps.ownerContactIds ?? defaultOwnerContactIds)()
        .map((id) => id.trim())
        .filter(Boolean),
    );
    if (owners.size !== 1 || !owners.has(contactId)) return false;
    const patterns = (deps.routePatternsForSessionName ?? defaultRoutePatternsForSessionName)(input.sessionName);
    if (!patterns.every(isDirectPeerRoutePattern)) return false;
    const isOwn = deps.isContactsDirectChat ?? isContactsOwnDirectChat;
    for (const chatId of (deps.attachedChatIds ?? defaultAttachedChatIds)(input.sessionKey)) {
      if (chatId === input.chatId) continue;
      if (!isOwn(chatId, contactId)) return false;
    }
    return true;
  } catch (error) {
    log.warn("shared session privacy unreadable; the owner's turn there is not private", {
      sessionKey: input.sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Whether a chat is the contact's own direct chat, or a thread inside one: a
 * thread of a direct chat has the same two people in it. Thread chats are
 * stored as `<container-id>#<thread-id>` next to their container
 * (`dbGetThreadParentChat`).
 */
export function isContactsOwnDirectChat(chatId: string, contactId: string): boolean {
  if (dmContactForChat({ chatId, channel: null }) === contactId) return true;
  const chat = dbGetChat(chatId);
  if (chat?.chatType !== "thread") return false;
  const parent = dbGetThreadParentChat(chat);
  if (!parent || parent.chatType !== "dm") return false;
  return dmContactForChat({ chatId: parent.id, channel: null }) === contactId;
}

function defaultOwnerContactIds(): string[] {
  return findContactsByTag(OWNER_CONTACT_TAG).map((contact) => contact.id);
}

function defaultRoutePatternsForSessionName(sessionName: string): string[] {
  return dbListRoutesBySessionName(sessionName).map((route) => route.pattern);
}

function defaultAttachedChatIds(sessionKey: string): string[] {
  return dbListSessionChatSubscriptions(sessionKey).map((subscription) => subscription.chatId);
}

function readOwnerContactIds(deps: OwnerDmGuardDeps): Set<string> | null {
  try {
    const ids = deps.ownerContactIds ? deps.ownerContactIds() : defaultOwnerContactIds();
    return new Set(ids.map((id) => id.trim()).filter(Boolean));
  } catch (error) {
    log.warn("owner contacts unreadable; non-owner DM to the shared session is held", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
