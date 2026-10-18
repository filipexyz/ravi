/**
 * The person of the turn, for Console calls (`x-ravi-actor-contact`).
 *
 * Console calls go out with the operator's `ravi login` session. When the
 * agent turn running the CLI was written by someone else, the request also
 * names that person's local contact; Console resolves this installation's
 * `ravi link` binding for it and credits (and authorizes) the write to the
 * bound person, with the operator kept as executor. With no binding Console
 * refuses writes (`ACTOR_NOT_LINKED`), which starts the person's link
 * (`identity-link/turn-link.ts`); reads stay the operator's.
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
