import { dbGetContext, dbGetOpenThreadHumanRequestTurns, type ContextRecord } from "../router/router-db.js";
import { isWorkHandoff, resolveHumanRequestCaller, type HumanRequestCaller } from "./human-request.js";
import { resolveRuntimeTurnOrigin } from "./turn-origin.js";

export interface ThreadInheritedRequester extends HumanRequestCaller {
  /** The thread turn a verified human request started, whose requester this turn inherits. */
  threadTurn: ContextRecord;
}

export interface ThreadRequesterDeps {
  getThread?: typeof dbGetOpenThreadHumanRequestTurns;
  getContextById?: (contextId: string) => ContextRecord | null;
  resolveRequester?: typeof resolveHumanRequestCaller;
}

/**
 * A Slack thread is one unit of work someone asked for. Its later turns are
 * often the parent session handing it more of that same work from turns no
 * human started (a thread report, a cron, a follow-up), and those used to lose
 * the person behind the thread: Bases refused them as another agent's relay.
 *
 * This returns that person for such a turn, so Bases (and the Console access
 * calls) act for them, when all of this holds:
 *
 * - the turn runs in the child session of an open thread;
 * - it is a work handoff (bootstrap, send, ask or execute) from an agent, made
 *   from a turn of the thread's own parent session (never a sibling session,
 *   another thread, or a chat the parent does not own), and that turn was the
 *   agent's or an automation's, not some person's (a person's own request is
 *   authorized as theirs or refused, never upgraded to the thread's);
 * - an earlier turn of this thread was started by a verified human request
 *   (the first one is the thread's requester), and that request still
 *   resolves now: the person is not blocked or opted out, and the turn they
 *   asked from was not withdrawn.
 *
 * A thread no human ever asked into inherits nothing, so a thread an external
 * message or an automation started keeps being refused. This is attribution
 * only: it never lends the operator's personal or shared connectors.
 */
export function resolveThreadInheritedRequester(
  input: {
    /** The turn's session, when its contexts agree on one. */
    sessionKey: string | null;
    /** The turn's own `turnOrigin` metadata. */
    turnOrigin: unknown;
    /** The agent the turn says relayed it (`agent:<id>`). */
    relayAgentId: string;
  },
  deps: ThreadRequesterDeps = {},
): ThreadInheritedRequester | null {
  if (!input.sessionKey) return null;
  const origin = resolveRuntimeTurnOrigin(input.turnOrigin);
  if (!origin || !isWorkHandoff(origin)) return null;
  if (origin.principal.type !== "agent" || origin.principal.id !== input.relayAgentId) return null;
  if (!origin.callerContextId) return null;

  const thread = (deps.getThread ?? dbGetOpenThreadHumanRequestTurns)(input.sessionKey);
  if (!thread) return null;
  const caller = (deps.getContextById ?? dbGetContext)(origin.callerContextId);
  if (!caller || caller.agentId !== input.relayAgentId || caller.sessionKey !== thread.parentSessionKey) return null;
  // A person's own turn in the parent session is theirs to authorize (the
  // human-request path); an unverified person never borrows the thread's
  // requester through it.
  const callerPrincipal = typeof caller.metadata?.actorPrincipal === "string" ? caller.metadata.actorPrincipal : "";
  if (!callerPrincipal.startsWith("agent:") && !callerPrincipal.startsWith("automation:")) return null;

  const resolve = deps.resolveRequester ?? resolveHumanRequestCaller;
  for (const threadTurn of thread.humanRequestTurns) {
    if (threadTurn.sessionKey !== input.sessionKey) continue;
    const requester = resolve({ _turnOrigin: resolveRuntimeTurnOrigin(threadTurn.metadata?.turnOrigin) ?? undefined });
    if (requester) return { ...requester, threadTurn };
    // The thread's first request no longer resolves (withdrawn or the person
    // is no longer eligible): do not fall through to a later, different one.
    return null;
  }
  return null;
}
