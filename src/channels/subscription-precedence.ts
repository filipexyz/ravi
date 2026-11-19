/**
 * Who wins when a chat's active subscription and the matched route disagree.
 *
 * Both inbound paths (the native Slack service and the Omni consumer) ask this
 * question before `commitMatchedRoute`, so the answer lives in one place. The
 * Omni path used to keep its own copy of the old rule ("the subscription
 * overrides the route") and kept the route's forced session on a rerouted
 * subscription: the commit then renamed the attached session to the route's
 * name, or redirected away from an explicit attach. See sessions/attach SPEC
 * ("Routes and attachments solve different problems").
 *
 * - An automatic subscription (`attachedByType: system`) loses to a route that
 *   forces another session. The caller commits the route, then releases the
 *   subscription and the chat is rebound to the session the route landed in.
 * - An explicit attach (`user` or `agent`) keeps the chat on the attached
 *   session and agent. The route's forced session is dropped for that chat so
 *   the commit neither redirects to it nor renames the attached session to it.
 * - A subscription to the forced session itself agrees with the route.
 * - A thread has no forced session of its own (the commit forks it under the
 *   route's session), so a thread never takes the "route wins" branch and
 *   always loses the route's forced session.
 */

import { isExplicitSessionAttach } from "../router/route-sticky-attach.js";
import type { AttachedByType } from "../router/router-db.js";
import { getSessionByName } from "../router/sessions.js";
import type { AgentConfig, DmScope, MatchedRoute } from "../router/types.js";

export type SubscriptionPrecedence =
  /**
   * An automatic subscription that loses to the route's forced session. Commit
   * the route as matched, then release the subscription (`routeSession` names
   * the session the route forces).
   */
  | { kind: "route-wins"; routeSession: string }
  /**
   * The chat stays on the subscription. Commit `matched`: its route keeps the
   * pattern and policy but no longer forces a session that is not the
   * subscription's. `rerouted` says whether `matched` moved to the
   * subscription's session or already was there.
   */
  | { kind: "subscription-wins"; matched: MatchedRoute; rerouted: boolean };

export interface SubscriptionPrecedenceInput {
  /** What `matchRoute` returned for the inbound; null when no route matched. */
  matched: MatchedRoute | null;
  subscription: { sessionKey: string; attachedByType: AttachedByType };
  /** The agent that owns the subscription's session. */
  ownerAgentId: string;
  ownerAgent: AgentConfig;
  /** The thread the inbound belongs to, when it is a thread reply. */
  threadId?: string;
  /** Fallback `dmScope` when neither the match nor the owner agent set one. */
  defaultDmScope: DmScope;
}

export function resolveSubscriptionPrecedence(input: SubscriptionPrecedenceInput): SubscriptionPrecedence {
  const { matched, subscription, ownerAgentId, ownerAgent } = input;
  const threadId = input.threadId?.trim();
  const forcedSessionName = threadId ? undefined : matched?.route?.session?.trim() || undefined;
  const forcedSession = forcedSessionName ? getSessionByName(forcedSessionName) : null;
  const subscriptionIsForcedSession = forcedSession?.sessionKey === subscription.sessionKey;

  if (forcedSessionName && !subscriptionIsForcedSession && !isExplicitSessionAttach(subscription.attachedByType)) {
    return { kind: "route-wins", routeSession: forcedSessionName };
  }

  let next = matched;
  let rerouted = false;
  if (!next || subscription.sessionKey !== next.sessionKey) {
    const route = next?.route;
    // The subscription picks agent and session together; dropping the route's
    // forced session keeps the commit from pairing this agent with another
    // agent's session, and from renaming the attached session to the route's.
    next = {
      agentId: ownerAgentId,
      agent: ownerAgent,
      sessionKey: subscription.sessionKey,
      dmScope: next?.dmScope ?? ownerAgent.dmScope ?? input.defaultDmScope,
      route: route?.session && !subscriptionIsForcedSession ? { ...route, session: undefined } : route,
    };
    rerouted = true;
  }
  // Even when the keys already agree, an attached chat must not be redirected
  // to a different session the route forces.
  if (next.route?.session && forcedSessionName && !subscriptionIsForcedSession) {
    next = { ...next, route: { ...next.route, session: undefined } };
  }
  return { kind: "subscription-wins", matched: next, rerouted };
}
