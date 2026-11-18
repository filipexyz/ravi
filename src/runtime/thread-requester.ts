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
  now?: number;
}

/** A delegated requester older than this is not inherited (the person asks again). */
export const DELEGATED_REQUESTER_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * Whether the person's verified request (its origin human turn) is recent
 * enough to still be lent to delegated work: 72 hours from that turn.
 */
export function isDelegatedRequesterFresh(
  requester: HumanRequestCaller,
  deps: { getContextById?: (contextId: string) => ContextRecord | null; now?: number } = {},
): boolean {
  const origin = (deps.getContextById ?? dbGetContext)(requester.originContextId) ?? requester.caller;
  const createdAt = typeof origin.createdAt === "number" ? origin.createdAt : Number.NaN;
  if (!Number.isFinite(createdAt)) return false;
  return (deps.now ?? Date.now()) - createdAt <= DELEGATED_REQUESTER_MAX_AGE_MS;
}

/**
 * A Slack thread is one unit of work someone asked for. Its later turns are
 * often the parent session handing it more of that same work after the thread
 * reported back, and those used to lose the person behind the thread: Bases
 * refused them as another agent's relay.
 *
 * This returns that person for such a turn, so Bases (and the Console access
 * calls) act for them, when all of this holds:
 *
 * - the turn runs in the child session of an open thread;
 * - it is a work handoff (bootstrap, send, ask or execute) from an agent, made
 *   from a turn of the thread's own parent session, by that same agent;
 * - that parent turn was caused by this very thread: an `inform` or `answer`
 *   relayed from the thread's session, or the thread's `session.return`. A
 *   parent turn driven by another session's Ask/Inform, another thread, a
 *   trigger (a PR, an e-mail), a cron or any automation inherits nothing, and
 *   a person's own parent turn is authorized as theirs (the direct human
 *   handoff), never upgraded to the thread's requester;
 * - the first turn of this thread a verified human request started still
 *   resolves now (the person is not blocked or opted out, the turn they asked
 *   from was not withdrawn) and is at most 72 hours old. If it does not, the
 *   turn inherits nothing: it never falls through to a later requester.
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

  const getById = deps.getContextById ?? dbGetContext;
  const thread = (deps.getThread ?? dbGetOpenThreadHumanRequestTurns)(input.sessionKey);
  if (!thread) return null;
  const caller = getById(origin.callerContextId);
  if (!caller || caller.agentId !== input.relayAgentId || caller.sessionKey !== thread.parentSessionKey) return null;
  const callerPrincipal = typeof caller.metadata?.actorPrincipal === "string" ? caller.metadata.actorPrincipal : "";
  if (callerPrincipal !== `agent:${input.relayAgentId}`) return null;
  if (!wasCausedByThread(caller, input.sessionKey, getById)) return null;

  const resolve = deps.resolveRequester ?? resolveHumanRequestCaller;
  const threadTurn = thread.humanRequestTurns.find((turn) => turn.sessionKey === input.sessionKey);
  if (!threadTurn) return null;
  const requester = resolve({ _turnOrigin: resolveRuntimeTurnOrigin(threadTurn.metadata?.turnOrigin) ?? undefined });
  if (!requester || !isDelegatedRequesterFresh(requester, { getContextById: getById, now: deps.now })) return null;
  return { ...requester, threadTurn };
}

/**
 * The parent turn was started by the thread itself: an `inform`/`answer`
 * relayed from a turn of the thread's session, or that turn's
 * `session.return`. The proof is the host-recorded `turnOrigin` and the
 * session of the context it names, never prompt text.
 */
function wasCausedByThread(
  parentTurn: ContextRecord,
  threadSessionKey: string,
  getById: (contextId: string) => ContextRecord | null,
): boolean {
  const cause = resolveRuntimeTurnOrigin(parentTurn.metadata?.turnOrigin);
  if (!cause?.callerContextId) return false;
  const fromThread =
    (cause.producer === "session-relay" &&
      (cause.action === "inform" || cause.action === "answer") &&
      (!cause.session?.key || cause.session.key === threadSessionKey)) ||
    (cause.producer === "channel" && cause.action === "session.return");
  if (!fromThread) return false;
  return getById(cause.callerContextId)?.sessionKey === threadSessionKey;
}
