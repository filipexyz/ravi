/**
 * Who asked for a thread an agent opens (`ravi sessions create-thread`), by
 * name, for the thread's root card.
 *
 * The person comes from the daemon's own record of the turn running the
 * command (`resolveTurnForActiveLogin`, the classification Console calls use),
 * never from values the agent's shell could change. The display needs only
 * who wrote the turn, so a turn that is refused for Console calls (a group, a
 * contact without a link) still names its writer. The operator (the owner's
 * own chat or relay, or the terminal) is named by the owner contact, the one
 * tagged `permission-owner`, when their own contact has no name. An agent,
 * a routine or an unknown speaker names nobody.
 */

import { findContactsByTag, getContactById } from "../../contacts.js";
import { OWNER_CONTACT_TAG } from "../../knowledge/owner.js";
import type { ConnectorTurnResult } from "../../link/connector-turn.js";
import { resolveTurnForActiveLogin } from "../../pages/read.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("channels:slack:thread-requester");
const NAME_MAX_LENGTH = 80;

export interface SlackThreadRequesterDeps {
  resolveTurn?: () => ConnectorTurnResult;
  contactName?: (contactId: string) => string | null | undefined;
  ownerName?: () => string | null | undefined;
}

export function resolveSlackThreadRequester(deps: SlackThreadRequesterDeps = {}): string | undefined {
  let result: ConnectorTurnResult;
  try {
    result = (deps.resolveTurn ?? resolveTurnForActiveLogin)();
  } catch (error) {
    log.debug("Thread requester unresolved", { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
  const turn = result.ok ? result.turn : (result.relay ?? result.candidate);
  const speaker = turn?.speaker;
  const contactId =
    speaker?.kind === "contact" || speaker?.kind === "owner"
      ? speaker.contactId
      : contactIdOfPrincipal(result.ok ? result.turn.actorPrincipal : result.actorPrincipal);
  const named = contactId ? cleanName((deps.contactName ?? defaultContactName)(contactId)) : undefined;
  if (named) return named;
  const operator =
    speaker?.kind === "owner" || speaker?.kind === "terminal" || (!result.ok && result.speakerIsOwner === true);
  return operator ? cleanName((deps.ownerName ?? defaultOwnerName)()) : undefined;
}

function contactIdOfPrincipal(principal: string): string | undefined {
  return principal.startsWith("contact:") ? principal.slice("contact:".length).trim() || undefined : undefined;
}

function cleanName(raw: string | null | undefined): string | undefined {
  const name = raw?.replace(/\s+/g, " ").trim();
  if (!name) return undefined;
  return name.length > NAME_MAX_LENGTH ? `${name.slice(0, NAME_MAX_LENGTH - 1).trimEnd()}…` : name;
}

function defaultContactName(contactId: string): string | null {
  try {
    return getContactById(contactId)?.name ?? null;
  } catch {
    return null;
  }
}

function defaultOwnerName(): string | null {
  try {
    const owners = findContactsByTag(OWNER_CONTACT_TAG);
    return owners.length === 1 ? (owners[0]?.name ?? null) : null;
  } catch {
    return null;
  }
}
