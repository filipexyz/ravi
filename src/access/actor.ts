/**
 * Who acts on a Console access call (`ravi pages share|unshare|access`,
 * `ravi invites ...`, `ravi access request`).
 *
 * Every call goes out with the operator's `ravi login` session. The body may
 * also name the chat author (`actor: { contactId }`); Console then resolves
 * that contact through this installation's `ravi link` binding and acts for
 * the bound person (writes need both the session user and that person to
 * pass the role check; an access request is made in that person's name).
 * With no binding Console answers `ACTOR_NOT_LINKED`.
 *
 * This side only says who wrote the turn, from the same classification the
 * connector calls use (`resolveConnectorTurn`):
 *
 * - The operator's own turn (the terminal, the owner's own chat, the owner's
 *   own `ravi sessions send|ask`, routines the owner owns): no `actor`, the
 *   session user acts. The owner speaking in a group or in a shared session
 *   is still the owner asking, so it is the operator too.
 * - A resolved contact who is not the owner (a direct chat or a group):
 *   `actor: { contactId }`, so Console acts for that person, never for the
 *   operator.
 * - Anything else (an unresolved speaker, an agent relaying for another
 *   session, a routine someone else owns, a turn that already ended): refused
 *   here, and nothing is sent. A turn that cannot be attributed never falls
 *   back to the operator's authority.
 */

import { dbGetAgent } from "../router/router-db.js";
import type { ConnectorTurn, ConnectorTurnDeps, ConnectorTurnResult } from "../link/connector-turn.js";
import { resolveTurnForActiveLogin } from "../pages/read.js";
import type { PagesClientDeps } from "../pages/client.js";

export type AccessActorDecision =
  | {
      kind: "operator";
      /** Agent running the turn, when the turn names one. */
      agent?: AccessAgent;
    }
  | {
      kind: "contact";
      contactId: string;
      agent?: AccessAgent;
    }
  | {
      kind: "refused";
      message: string;
      actorPrincipal: string;
    };

export interface AccessAgent {
  id: string;
  name?: string;
}

export interface AccessActorDeps {
  turn?: ConnectorTurnDeps;
  readCredentials?: PagesClientDeps["readCredentials"];
  /** Overrides the classification (tests). */
  actor?: AccessActorDecision;
  /** An agent's display name (default: the agents table). */
  getAgentName?: (agentId: string) => string | null | undefined;
}

/** Body field Console reads to act for the chat author. Absent for the operator. */
export interface AccessActorBody {
  actor?: { contactId: string };
}

export function resolveAccessActor(deps: AccessActorDeps = {}): AccessActorDecision {
  if (deps.actor) return deps.actor;
  return accessActorFromTurn(resolveTurnForActiveLogin(deps), deps);
}

export function accessActorFromTurn(result: ConnectorTurnResult, deps: AccessActorDeps = {}): AccessActorDecision {
  if (result.ok) {
    const turn = result.turn;
    if (turn.speaker.kind === "contact" && turn.speaker.contactId) {
      return { kind: "contact", contactId: turn.speaker.contactId, ...agentOf(turn, deps) };
    }
    if (turn.speaker.kind === "agent") return refused(turn.actorPrincipal);
    return { kind: "operator", ...agentOf(turn, deps) };
  }
  // The operator's own relay, refused by the connector rule only for where
  // the session posts its answer.
  if (result.relay?.speaker.kind === "owner") return { kind: "operator", ...agentOf(result.relay, deps) };
  const candidate = result.candidate;
  // The owner, refused only for where they asked (a group, a shared session).
  if (result.speakerIsOwner || candidate?.speaker.kind === "owner") {
    return { kind: "operator", ...(candidate ? agentOf(candidate, deps) : {}) };
  }
  // A routine the owner owns, refused only because it answers into a chat
  // that is not the owner's.
  if (candidate?.speaker.kind === "automation") return { kind: "operator", ...agentOf(candidate, deps) };
  if (candidate?.speaker.kind === "contact" && candidate.speaker.contactId) {
    return { kind: "contact", contactId: candidate.speaker.contactId, ...agentOf(candidate, deps) };
  }
  return refused(result.actorPrincipal);
}

/** `{ actor: { contactId } }` for a contact, nothing for the operator. */
export function accessActorBody(decision: Exclude<AccessActorDecision, { kind: "refused" }>): AccessActorBody {
  return decision.kind === "contact" ? { actor: { contactId: decision.contactId } } : {};
}

/** Who the dry-run plan says will act. */
export function describeAccessActor(decision: Exclude<AccessActorDecision, { kind: "refused" }>): string {
  return decision.kind === "contact"
    ? `contact ${decision.contactId} (their linked Console account; the operator's login must also allow it)`
    : "operator (the ravi login session)";
}

function agentOf(turn: ConnectorTurn, deps: AccessActorDeps): { agent?: AccessAgent } {
  const id = turn.agentId?.trim();
  if (!id) return {};
  const name = readAgentName(id, deps);
  return { agent: { id, ...(name ? { name } : {}) } };
}

function readAgentName(agentId: string, deps: AccessActorDeps): string | null {
  try {
    const raw = deps.getAgentName ? deps.getAgentName(agentId) : dbGetAgent(agentId)?.name;
    const name = typeof raw === "string" ? raw.trim() : "";
    return name && name.length <= 120 ? name : null;
  } catch {
    return null;
  }
}

function refused(actorPrincipal: string): AccessActorDecision {
  return {
    kind: "refused",
    actorPrincipal,
    message:
      "Ravi could not tell who is asking in this turn, so it will not share, invite or ask for access on anyone's behalf. Ask the person to send the request from their own chat, or the operator to run it in the terminal.",
  };
}
