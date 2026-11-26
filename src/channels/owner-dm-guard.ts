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
// them a session of their own: a route or agent whose `dmScope` is not `main`.
// A forced session name alone does not isolate them: until that session
// exists, the commit names the shared key after it.
//
// The owner's own turn counts wherever they write (src/link/connector-turn.ts);
// what this guard keeps is the routing: no one else's DM shares the owner's
// session.
//
// With no contact tagged `permission-owner` the guard admits everything
// (fail-open).

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

function defaultOwnerContactIds(): string[] {
  return findContactsByTag(OWNER_CONTACT_TAG).map((contact) => contact.id);
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
