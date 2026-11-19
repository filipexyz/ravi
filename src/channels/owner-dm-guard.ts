// A direct message from someone who is not the installation owner never
// resolves into the owner's shared session (spec channels/owner-dm-guard).
//
// `dmScope: "main"` collapses every DM of an agent into one session,
// `agent:<id>:main`. On an operator's own agent that session carries the
// owner's history and, in an ungoverned chat, the agent's whole ceiling
// (spec permissions/agent-identity). Before this guard, any colleague who
// DMed the bot on an `open` instance landed in it: the 04/11 incident.
//
// The guard runs after route matching and subscription rerouting, before the
// session row is committed, on the key the commit will produce
// (`previewCommittedSessionKey`): a route that forces a session redirects
// there, so the preliminary `matched.sessionKey` is not where the message
// lands. When it blocks, the inbound is held for owner review, the same path a
// `pairing` DM takes: the owner decides by adding a route whose pattern is that
// person's literal id.
//
// With no contact tagged `permission-owner` the guard admits everything
// (fail-open), so an installation is protected only once its owner is tagged.

import { findContactsByTag } from "../contacts.js";
import { OWNER_CONTACT_TAG } from "../knowledge/owner.js";
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
  /**
   * The operator chose this destination for this conversation: a route whose
   * pattern is a literal id (see `isPeerNamingRoutePattern`), or a chat
   * attached by a person or agent. A glob is a wildcard, and routing's own
   * bookkeeping attach is not a choice.
   */
  explicit: boolean;
}

export interface OwnerDmGuardDeps {
  /** Contacts tagged `permission-owner`. */
  ownerContactIds?: () => string[];
}

export type OwnerDmGuardResult =
  | { blocked: false; reason: "not_dm" | "not_owner_session" | "explicit" | "owner" | "no_owner_configured" }
  | { blocked: true; reason: "non_owner_dm_to_owner_session"; ownerCount: number };

/**
 * Whether a route pattern names one conversation. Route patterns only know the
 * `*` glob (`matchPattern`); any pattern with it, `*` itself or a prefix such as
 * `U0*`, matches people the operator never named, so it is a wildcard here.
 */
export function isPeerNamingRoutePattern(pattern: string | null | undefined): boolean {
  const trimmed = pattern?.trim();
  if (!trimmed) return false;
  return !trimmed.includes("*");
}

/**
 * Whether the operator chose the session this DM lands in. Each choice vouches
 * only for the destination it names:
 * - a route whose pattern is a literal id, when the message lands where that
 *   route sends it. A chat subscription can reroute the message elsewhere, for
 *   example routing's own attach of an earlier DM to the shared session;
 * - a chat attached by a person or an agent, when the message lands in the
 *   attached session.
 * The session keys are the ones the commit will produce
 * (`previewCommittedSessionKey`).
 */
export function isOperatorChosenDestination(input: {
  /** Pattern of the route `matchRoute` found, before any subscription reroute. */
  routePattern: string | null | undefined;
  /** Where that route sends the message on its own. */
  routeSessionKey: string | null | undefined;
  /** The chat's subscription was honored and was made by a person or an agent. */
  attachExplicit: boolean;
  /** Session the chat is attached to. */
  attachSessionKey: string | null | undefined;
  /** Session the message will land in. */
  landingSessionKey: string;
}): boolean {
  if (isPeerNamingRoutePattern(input.routePattern) && input.routeSessionKey === input.landingSessionKey) return true;
  return input.attachExplicit && input.attachSessionKey === input.landingSessionKey;
}

/** Whether the session key is an agent's shared DM session (`agent:<id>:main`). */
export function isSharedOwnerSessionKey(sessionKey: string): boolean {
  return parseSessionKey(sessionKey)?.dmScope === "main";
}

export function evaluateOwnerDmGuard(input: OwnerDmGuardInput, deps: OwnerDmGuardDeps = {}): OwnerDmGuardResult {
  if (input.peerKind !== "dm") return { blocked: false, reason: "not_dm" };
  if (!isSharedOwnerSessionKey(input.sessionKey)) return { blocked: false, reason: "not_owner_session" };
  if (input.explicit) return { blocked: false, reason: "explicit" };

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

function readOwnerContactIds(deps: OwnerDmGuardDeps): Set<string> | null {
  try {
    const ids = deps.ownerContactIds
      ? deps.ownerContactIds()
      : findContactsByTag(OWNER_CONTACT_TAG).map((contact) => contact.id);
    return new Set(ids.map((id) => id.trim()).filter(Boolean));
  } catch (error) {
    log.warn("owner contacts unreadable; non-owner DM to the shared session is held", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
