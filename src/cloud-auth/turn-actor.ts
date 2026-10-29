/**
 * The person of the turn, for Console calls (`x-ravi-actor-contact`).
 *
 * Console calls go out with the operator's `ravi login` session. When the
 * agent turn running the CLI was written by someone else, the request also
 * names that person's local contact; Console resolves this installation's
 * `ravi link` binding for it and credits (and authorizes) the write to the
 * bound person, with the operator kept as executor. With no binding Console
 * refuses writes (`ACTOR_NOT_LINKED`), which starts the person's link
 * (`identity-link/turn-link.ts`); Bases refuses reads too. A turn Ravi cannot
 * attribute sends no contact; Bases calls refuse it locally
 * (`isUnattributedTurn`) instead of reading or writing as the operator.
 *
 * The contact comes from the same turn classification the access calls use
 * (`resolveAccessActor`), which reads the daemon's own record of the turn
 * through `RAVI_CONTEXT_KEY` (or the context the daemon gateway runs the
 * command under), never from `RAVI_CONTACT_ID` or other values the agent's
 * shell could change. Outside a runtime turn (the terminal, the daemon's own
 * background calls) nothing is sent.
 */

import { resolveAccessActor, type AccessActorDeps } from "../access/actor.js";
import { getContext } from "../cli/context.js";
import { RAVI_CONTEXT_KEY_ENV } from "../runtime/context-registry.js";
import type { TurnRefusal } from "./turn-refusal.js";

export const ACTOR_CONTACT_HEADER = "x-ravi-actor-contact";

/** The contact who wrote the current turn when it is not the operator, else null. */
export function turnActorContactId(env: NodeJS.ProcessEnv = process.env, deps: AccessActorDeps = {}): string | null {
  if (!deps.actor && !inRuntimeTurn(env)) return null;
  try {
    const decision = resolveAccessActor({ ...deps, turn: { ...deps.turn, env } });
    return decision.kind === "contact" ? decision.contactId : null;
  } catch {
    return null;
  }
}

/**
 * A runtime turn is running this command: the CLI carries `RAVI_CONTEXT_KEY`,
 * or the daemon is running it for a turn (its gateway and in-process tools
 * set the context; the daemon's own environment has no key).
 */
export function inRuntimeTurn(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[RAVI_CONTEXT_KEY_ENV]?.trim()) return true;
  const transport = getContext({ localOnly: true })?.transport;
  return transport === "gateway" || transport === "tool";
}

/**
 * True when a runtime turn runs this command and Ravi cannot say who asked
 * (`resolveAccessActor` refused it: another agent's turn, an unresolved
 * speaker), or the classification fails. Such a turn sends no contact, so a
 * call that must act as the person of the turn refuses it instead of going
 * out as the operator. Outside a runtime turn, and for the operator or a
 * contact, false.
 */
export function isUnattributedTurn(env: NodeJS.ProcessEnv = process.env, deps: AccessActorDeps = {}): boolean {
  return unattributedTurnRefusal(env, deps) !== null;
}

/**
 * The refusal behind {@link isUnattributedTurn}, with its reason (a routine
 * someone else owns, another agent's relay, an ended turn, unknown), or null
 * when the turn may act.
 */
export function unattributedTurnRefusal(
  env: NodeJS.ProcessEnv = process.env,
  deps: AccessActorDeps = {},
): TurnRefusal | null {
  if (!deps.actor && !inRuntimeTurn(env)) return null;
  try {
    const decision = resolveAccessActor({ ...deps, turn: { ...deps.turn, env } });
    return decision.kind === "refused"
      ? { reason: decision.reason ?? { kind: "unknown" }, actorPrincipal: decision.actorPrincipal }
      : null;
  } catch {
    return { reason: { kind: "unknown" }, actorPrincipal: "unknown" };
  }
}
