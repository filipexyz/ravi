// The Omni consumer and the Slack service both decide, before the commit, who
// wins when a chat's subscription and the matched route disagree. These tests
// replay that sequence (matchRoute -> decision -> real commitMatchedRoute) and
// check what the commit does to the sessions, which is where the Omni path
// went wrong: it kept the route's forced session on a rerouted subscription,
// and the commit renamed the attached session to the route's name.
//
// This file lives in src/channels/ on purpose: CI runs `bun test src/channels/`
// in its own process. `src/omni/consumer-context.test.ts` mocks
// `commitMatchedRoute` on `../router/index.js`, and bun propagates that mock to
// every import of the resolver in the same process (see
// src/router/commit-matched-route.test.ts).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveSubscriptionPrecedence, type SubscriptionPrecedence } from "./subscription-precedence.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { commitMatchedRoute, matchRoute, RouteSessionAgentConflictError } from "../router/resolver.js";
import { dbUpsertChat, type AttachedByType } from "../router/router-db.js";
import { attachChatToSession, getOrCreateSession, getSession, getSessionByName } from "../router/sessions.js";
import type { MatchedRoute, RouteConfig, RouterConfig } from "../router/types.js";

let stateDir: string | null = null;
const PEER = "5511988887777";
const MAIN_KEY = "agent:main:main";
const THREAD = "1763555555.000100";

function configWith(route: RouteConfig): RouterConfig {
  return {
    agents: {
      main: { id: "main", cwd: "/tmp/main", dmScope: "per-peer" },
      specialist: { id: "specialist", cwd: "/tmp/specialist", dmScope: "per-peer" },
    },
    routes: [route],
    defaultAgent: "main",
    defaultDmScope: "per-peer",
    accountAgents: { acc: "main" },
    instanceToAccount: {},
    instances: {},
  };
}

function routeFor(partial: Partial<RouteConfig> = {}): RouteConfig {
  return { pattern: PEER, accountId: "acc", agent: "main", ...partial };
}

function seedChat(): string {
  return dbUpsertChat({
    channel: "whatsapp",
    instanceId: "acc",
    platformChatId: `${PEER}@s.whatsapp.net`,
    chatType: "dm",
    title: "peer",
    rawProvenance: { source: "test" },
    seenAt: 1_713_000_000_000,
  }).id;
}

function attach(chatId: string, sessionKey: string, attachedByType: AttachedByType): void {
  attachChatToSession({
    sessionKey,
    chatId,
    role: "primary",
    attachedByType,
    attachedReason: "test",
    setOutputTarget: true,
  });
}

function match(config: RouterConfig, threadId?: string): MatchedRoute {
  const matched = matchRoute(config, {
    phone: PEER,
    accountId: "acc",
    channel: "whatsapp",
    isGroup: false,
    peerKind: "dm",
    ...(threadId ? { threadId } : {}),
  });
  if (!matched) throw new Error("no route matched");
  return matched;
}

// What both inbound paths do with a subscription in the way.
function inbound(
  config: RouterConfig,
  subscription: { sessionKey: string; attachedByType: AttachedByType } | null,
  threadId?: string,
): { precedence: SubscriptionPrecedence | null; resolved: ReturnType<typeof commitMatchedRoute> } {
  const matched = match(config, threadId);
  let precedence: SubscriptionPrecedence | null = null;
  let toCommit = matched;
  if (subscription) {
    const owner = getSession(subscription.sessionKey);
    if (!owner) throw new Error("subscription without a session");
    precedence = resolveSubscriptionPrecedence({
      matched,
      subscription,
      ownerAgentId: owner.agentId,
      ownerAgent: config.agents[owner.agentId]!,
      chatId: seedChat(),
      threadId,
      defaultDmScope: config.defaultDmScope,
    });
    if (precedence.kind === "subscription-wins") toCommit = precedence.matched;
  }
  const resolved = commitMatchedRoute(toCommit, {
    phone: PEER,
    isGroup: false,
    peerKind: "dm",
    ...(threadId ? { threadId } : {}),
  });
  return { precedence, resolved };
}

describe("subscription x route precedence", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-subscription-precedence-");
    getOrCreateSession(MAIN_KEY, "main", "/tmp/main", { name: "main" });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  for (const by of ["user", "agent"] as const) {
    it(`keeps a ${by} attach on its session and never renames it to the route's forced name`, () => {
      const chatId = seedChat();
      attach(chatId, MAIN_KEY, by);
      const config = configWith(routeFor({ session: "colleague-room" }));

      const { precedence, resolved } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: by });

      expect(precedence).toMatchObject({ kind: "subscription-wins", rerouted: true });
      expect(resolved.sessionKey).toBe(MAIN_KEY);
      expect(resolved.sessionName).toBe("main");
      expect(getSession(MAIN_KEY)?.name).toBe("main");
      expect(getSessionByName("colleague-room")).toBeNull();
    });
  }

  it("keeps the route's pattern and policy on the rerouted match, only the forced session goes", () => {
    const chatId = seedChat();
    attach(chatId, MAIN_KEY, "user");
    const config = configWith(routeFor({ session: "colleague-room", policy: "open" }));

    const { precedence } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: "user" });

    expect(precedence?.kind).toBe("subscription-wins");
    if (precedence?.kind !== "subscription-wins") return;
    expect(precedence.matched.route).toMatchObject({ pattern: PEER, policy: "open" });
    expect(precedence.matched.route?.session).toBeUndefined();
  });

  it("keeps an explicit attach on its session when the route forces another session of the same agent", () => {
    const chatId = seedChat();
    attach(chatId, MAIN_KEY, "user");
    getOrCreateSession("agent:main:shared", "main", "/tmp/main", { name: "shared" });
    const config = configWith(routeFor({ session: "shared" }));

    const { resolved } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: "user" });

    expect(resolved.sessionKey).toBe(MAIN_KEY);
    expect(getSession(MAIN_KEY)?.name).toBe("main");
    expect(getSessionByName("shared")?.sessionKey).toBe("agent:main:shared");
  });

  it("keeps an explicit attach and never pairs its agent with the route's session of another agent", () => {
    const chatId = seedChat();
    attach(chatId, MAIN_KEY, "user");
    getOrCreateSession("agent:specialist:fixed", "specialist", "/tmp/specialist", { name: "specialist-fixed" });
    const config = configWith(routeFor({ agent: "specialist", session: "specialist-fixed" }));

    const { resolved } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: "user" });

    expect(resolved.sessionKey).toBe(MAIN_KEY);
    expect(resolved.agent.id).toBe("main");
    expect(getSessionByName("specialist-fixed")?.agentId).toBe("specialist");
  });

  it("keeps an explicit attach even when the attach already is the key the route computes", () => {
    getOrCreateSession("agent:main:shared", "main", "/tmp/main", { name: "shared" });
    const config = configWith(routeFor({ session: "shared" }));
    // The key the route alone would compute for this peer.
    const routeKey = match(config).sessionKey;
    getOrCreateSession(routeKey, "main", "/tmp/main", { name: "peer-own" });
    attach(seedChat(), routeKey, "user");

    const { precedence, resolved } = inbound(config, { sessionKey: routeKey, attachedByType: "user" });

    expect(precedence).toMatchObject({ kind: "subscription-wins", rerouted: false });
    expect(resolved.sessionKey).toBe(routeKey);
    expect(getSession(routeKey)?.name).toBe("peer-own");
  });

  it("lets a route's forced session beat an automatic subscription, and leaves the old session alone", () => {
    const chatId = seedChat();
    attach(chatId, MAIN_KEY, "system");
    const config = configWith(routeFor({ session: "colleague-room" }));

    const { precedence, resolved } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: "system" });

    expect(precedence).toEqual({ kind: "route-wins", routeSession: "colleague-room" });
    // The route's own session is created and takes the forced name...
    expect(resolved.sessionKey).not.toBe(MAIN_KEY);
    expect(resolved.sessionName).toBe("colleague-room");
    expect(getSessionByName("colleague-room")?.sessionKey).toBe(resolved.sessionKey);
    // ...and the session the stale subscription pointed at keeps its name.
    expect(getSession(MAIN_KEY)?.name).toBe("main");
  });

  it("delivers an automatic subscription to the route's existing session of the same agent", () => {
    const chatId = seedChat();
    attach(chatId, MAIN_KEY, "system");
    getOrCreateSession("agent:main:shared", "main", "/tmp/main", { name: "shared" });
    const config = configWith(routeFor({ session: "shared" }));

    const { precedence, resolved } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: "system" });

    expect(precedence?.kind).toBe("route-wins");
    expect(resolved.sessionKey).toBe("agent:main:shared");
  });

  it("sends an automatic subscription to the route's session of another agent instead of pairing the agents", () => {
    const chatId = seedChat();
    attach(chatId, MAIN_KEY, "system");
    getOrCreateSession("agent:specialist:fixed", "specialist", "/tmp/specialist", { name: "specialist-fixed" });
    const config = configWith(routeFor({ agent: "specialist", session: "specialist-fixed" }));

    const { precedence, resolved } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: "system" });

    expect(precedence?.kind).toBe("route-wins");
    expect(resolved.sessionKey).toBe("agent:specialist:fixed");
    expect(resolved.agent.id).toBe("specialist");
  });

  it("still refuses a route whose forced session belongs to another agent when nothing is attached", () => {
    getOrCreateSession("agent:specialist:fixed", "specialist", "/tmp/specialist", { name: "specialist-fixed" });
    const config = configWith(routeFor({ agent: "main", session: "specialist-fixed" }));

    expect(() => inbound(config, null)).toThrow(RouteSessionAgentConflictError);
  });

  it("agrees with a subscription to the route's forced session itself", () => {
    const chatId = seedChat();
    getOrCreateSession("agent:main:shared", "main", "/tmp/main", { name: "shared" });
    attach(chatId, "agent:main:shared", "system");
    const config = configWith(routeFor({ session: "shared" }));

    const { precedence, resolved } = inbound(config, { sessionKey: "agent:main:shared", attachedByType: "system" });

    expect(precedence?.kind).toBe("subscription-wins");
    if (precedence?.kind !== "subscription-wins") return;
    expect(precedence.matched.route?.session).toBe("shared");
    expect(resolved.sessionKey).toBe("agent:main:shared");
    expect(getSession("agent:main:shared")?.name).toBe("shared");
  });

  it("never lets a route's forced session pull a thread away from the session it is attached to", () => {
    const threadKey = `${MAIN_KEY}:thread:${THREAD}`;
    getOrCreateSession(threadKey, "main", "/tmp/main", { name: "main-thread" });
    attach(seedChat(), threadKey, "system");
    getOrCreateSession("agent:main:shared", "main", "/tmp/main", { name: "shared" });
    const config = configWith(routeFor({ session: "shared" }));

    const { precedence, resolved } = inbound(config, { sessionKey: threadKey, attachedByType: "system" }, THREAD);

    expect(precedence?.kind).toBe("subscription-wins");
    expect(resolved.sessionKey).toBe(threadKey);
    expect(getSession(threadKey)?.name).toBe("main-thread");
  });

  // A DM carries no thread in its session key, so a thread reply can compute the
  // very key the chat is attached to (dmScope main). The route's forced session
  // must still not pull the reply away from the attach, and a subscription that
  // IS the forced session must still fork the thread under it.
  for (const by of ["user", "system"] as const) {
    it(`keeps a thread reply on the ${by} attach when the key agrees and the route forces another session`, () => {
      const chatId = seedChat();
      attach(chatId, MAIN_KEY, by);
      getOrCreateSession("agent:main:shared", "main", "/tmp/main", { name: "shared" });
      const config = configWith(routeFor({ session: "shared", dmScope: "main" }));
      expect(match(config, THREAD).sessionKey).toBe(MAIN_KEY);

      const { precedence, resolved } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: by }, THREAD);

      expect(precedence?.kind).toBe("subscription-wins");
      if (precedence?.kind !== "subscription-wins") return;
      expect(precedence.matched.route?.session).toBeUndefined();
      expect(resolved.sessionKey).toBe(MAIN_KEY);
      expect(getSessionByName("shared")?.sessionKey).toBe("agent:main:shared");
    });
  }

  it("forks a thread reply under the forced session when the subscription is that session and the keys differ", () => {
    const chatId = seedChat();
    getOrCreateSession("agent:main:shared", "main", "/tmp/main", { name: "shared" });
    attach(chatId, "agent:main:shared", "system");
    const config = configWith(routeFor({ session: "shared" }));
    expect(match(config, THREAD).sessionKey).not.toBe("agent:main:shared");

    const { precedence, resolved } = inbound(
      config,
      { sessionKey: "agent:main:shared", attachedByType: "system" },
      THREAD,
    );

    expect(precedence?.kind).toBe("subscription-wins");
    if (precedence?.kind !== "subscription-wins") return;
    expect(precedence.matched.route?.session).toBe("shared");
    expect(resolved.sessionKey).toBe(`agent:main:shared:thread:${THREAD}`);
  });

  it("forks a thread reply under the forced session when the subscription is that session and the keys agree", () => {
    const chatId = seedChat();
    attach(chatId, MAIN_KEY, "system");
    const config = configWith(routeFor({ session: "main", dmScope: "main" }));
    expect(match(config, THREAD).sessionKey).toBe(MAIN_KEY);

    const { resolved } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: "system" }, THREAD);

    expect(resolved.sessionKey).toBe(`${MAIN_KEY}:thread:${THREAD}`);
  });

  // attachChatToSession refuses a session on another instance (instance
  // isolation), and commitMatchedRoute only checks the agent. A route that wins
  // there would release the subscription and then fail to rebind the chat.
  it("keeps an automatic subscription when the route's forced session lives on another instance", () => {
    const chatId = seedChat();
    attach(chatId, MAIN_KEY, "system");
    getOrCreateSession("agent:main:far-room", "main", "/tmp/main", {
      name: "far-room",
      channel: "whatsapp",
      accountId: "other-account",
    });
    const config = configWith(routeFor({ session: "far-room" }));

    const { precedence, resolved } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: "system" });

    expect(precedence).toMatchObject({ kind: "subscription-wins", rerouted: true });
    if (precedence?.kind !== "subscription-wins") return;
    expect(precedence.matched.route?.session).toBeUndefined();
    // The commit lands in the subscription's session, not in the foreign one.
    expect(resolved.sessionKey).toBe(MAIN_KEY);
    expect(getSession("agent:main:far-room")?.name).toBe("far-room");
  });

  it("still lets a route's forced session on the chat's own instance beat an automatic subscription", () => {
    const chatId = seedChat();
    attach(chatId, MAIN_KEY, "system");
    getOrCreateSession("agent:main:near-room", "main", "/tmp/main", {
      name: "near-room",
      channel: "whatsapp",
      accountId: "acc",
    });
    const config = configWith(routeFor({ session: "near-room" }));

    const { precedence, resolved } = inbound(config, { sessionKey: MAIN_KEY, attachedByType: "system" });

    expect(precedence).toEqual({ kind: "route-wins", routeSession: "near-room" });
    expect(resolved.sessionKey).toBe("agent:main:near-room");
  });

  it("builds the match from the owner agent when no route matched the inbound", () => {
    const owner = config().agents.specialist!;
    getOrCreateSession("agent:specialist:main", "specialist", "/tmp/specialist", { name: "specialist" });

    const precedence = resolveSubscriptionPrecedence({
      matched: null,
      subscription: { sessionKey: "agent:specialist:main", attachedByType: "user" },
      ownerAgentId: "specialist",
      ownerAgent: owner,
      chatId: seedChat(),
      defaultDmScope: "main",
    });

    expect(precedence).toMatchObject({ kind: "subscription-wins", rerouted: true });
    if (precedence.kind !== "subscription-wins") return;
    expect(precedence.matched).toMatchObject({
      agentId: "specialist",
      sessionKey: "agent:specialist:main",
      dmScope: "per-peer",
    });
    expect(precedence.matched.route).toBeUndefined();
  });

  it("leaves a match without a forced session exactly as routing produced it", () => {
    const chatId = seedChat();
    const cfg = configWith(routeFor());
    const matched = match(cfg);
    getOrCreateSession(matched.sessionKey, "main", "/tmp/main", { name: "peer-own" });
    attach(chatId, matched.sessionKey, "system");

    const same = resolveSubscriptionPrecedence({
      matched,
      subscription: { sessionKey: matched.sessionKey, attachedByType: "system" },
      ownerAgentId: "main",
      ownerAgent: cfg.agents.main!,
      chatId,
      defaultDmScope: "per-peer",
    });
    expect(same).toEqual({ kind: "subscription-wins", matched, rerouted: false });

    const moved = resolveSubscriptionPrecedence({
      matched,
      subscription: { sessionKey: MAIN_KEY, attachedByType: "user" },
      ownerAgentId: "main",
      ownerAgent: cfg.agents.main!,
      chatId,
      defaultDmScope: "per-peer",
    });
    expect(moved).toMatchObject({ kind: "subscription-wins", rerouted: true });
    if (moved.kind !== "subscription-wins") return;
    expect(moved.matched.sessionKey).toBe(MAIN_KEY);
    expect(moved.matched.route).toBe(matched.route);
  });
});

function config(): RouterConfig {
  return configWith(routeFor());
}
