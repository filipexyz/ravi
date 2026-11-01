/**
 * A Console write refused for the person of the turn (`ACTOR_NOT_LINKED`)
 * starts their `ravi link` right away, so the agent only has to tell them
 * what to do next instead of running the link itself.
 *
 * - WhatsApp from a group: the person enters the linking state and must write
 *   to the agent in private (the agent never starts the conversation); the
 *   daemon answers that message with the approval link.
 * - Slack, or a WhatsApp private chat: the approval link goes out now.
 * - A cron run acting for the contact who created the job: nothing is sent,
 *   since nobody is asking (`routine`).
 */

import { CloudAuthError } from "../cloud-auth/errors.js";
import { currentConnectorRuntimeContext } from "../link/connector-turn.js";
import type { ContextRecord } from "../router/router-db.js";
import { listPendingLocalLinkRequestsForContact } from "./link-requests-db.js";
import { requestIdentityLink } from "./link-service.js";
import { wakeLinkRequestWatcher } from "./link-watcher.js";
import type { TurnLinkFlow } from "./turn-link-copy.js";

/** A link sent this recently is not sent again when the same turn is refused twice. */
const RECENT_LINK_MS = 2 * 60_000;

export interface TurnLinkDeps {
  context?: ContextRecord | null;
  requestLink?: typeof requestIdentityLink;
  now?: () => number;
  /** Whether this turn is a routine run acting for its creator (default: the turn classification). */
  isRoutineRun?: () => boolean | Promise<boolean>;
}

async function defaultIsRoutineRun(): Promise<boolean> {
  // Loaded lazily to keep the access classifier out of import cycles.
  const { resolveAccessActor } = await import("../access/actor.js");
  const decision = resolveAccessActor();
  return decision.kind === "contact" && decision.routine !== undefined;
}

export async function startTurnLink(contactId: string, deps: TurnLinkDeps = {}): Promise<TurnLinkFlow> {
  const now = (deps.now ?? Date.now)();
  try {
    // A scheduled run acting for the job's creator: nobody is asking, so
    // nobody is messaged.
    if (await (deps.isRoutineRun ?? defaultIsRoutineRun)()) return "routine";
    const recent = listPendingLocalLinkRequestsForContact(contactId).some(
      (request) => request.createdAt > now - RECENT_LINK_MS && request.expiresAt > now,
    );
    if (recent) return "dm_sent";
    const context = deps.context !== undefined ? deps.context : currentConnectorRuntimeContext().record;
    const result = await (deps.requestLink ?? requestIdentityLink)(context, {}, { refusedByConsole: true });
    if (result.status === "dm_sent") wakeLinkRequestWatcher();
    return result.status;
  } catch {
    return "unavailable";
  }
}

/** The refusal, carrying what was set in motion so every surface words it the same way. */
export function withTurnLinkFlow(error: CloudAuthError, flow: TurnLinkFlow): CloudAuthError {
  return new CloudAuthError(error.code, error.message, {
    ...(error.status !== undefined ? { status: error.status } : {}),
    details: { ...(error.details ?? {}), linkFlow: flow },
    ...(error.requestId ? { requestId: error.requestId } : {}),
    exitCode: error.exitCode,
    cause: error,
  });
}
