// The owner DM guard runs before `commitMatchedRoute`, so it has to judge the
// session the commit will really land in. A route that forces a session
// redirects there, away from `matched.sessionKey` (review of #893, B1). These
// tests replay what both inbound paths do and check the preview against the
// real commit.
//
// This file lives in src/channels/ on purpose: CI runs `bun test src/channels/`
// in its own process. `src/omni/consumer-context.test.ts` mocks
// `commitMatchedRoute` on `../router/index.js`, and bun propagates that mock to
// every import of the resolver in the same process (see
// src/router/commit-matched-route.test.ts).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { evaluateOwnerDmGuard } from "./owner-dm-guard.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  commitMatchedRoute,
  matchRoute,
  previewCommittedSessionKey,
  RouteSessionAgentConflictError,
} from "../router/resolver.js";
import { getOrCreateSession } from "../router/sessions.js";
import type { AgentConfig, MatchedRoute, RouteConfig, RouterConfig } from "../router/types.js";

let stateDir: string | null = null;
const OWNER_CONTACT = "contact-owner";
const PEER_CONTACT = "contact-peer";
const OWNER_USER = "U0OWNER";
const PEER_USER = "U0COLLEAGUE";
const OWNER_SESSION = "agent:main:main";
const THREAD = "1763555555.000100";
const owners = { ownerContactIds: () => [OWNER_CONTACT] };

function configWith(dmScope: AgentConfig["dmScope"], route: RouteConfig): RouterConfig {
  return {
    agents: {
      main: { id: "main", cwd: "/tmp/main", dmScope },
      ponte: { id: "ponte", cwd: "/tmp/ponte", dmScope: "per-peer" },
    },
    routes: [route],
    defaultAgent: "main",
    defaultDmScope: "per-peer",
    accountAgents: { acc: "main" },
    instanceToAccount: {},
    instances: {},
  };
}

function match(config: RouterConfig, user: string, threadId?: string): MatchedRoute {
  const matched = matchRoute(config, {
    phone: user,
    accountId: "acc",
    channel: "slack",
    isGroup: false,
    peerKind: "dm",
    ...(threadId ? { threadId } : {}),
  });
  if (!matched) throw new Error("no route matched");
  return matched;
}

function commit(matched: MatchedRoute, user: string, threadId?: string) {
  return commitMatchedRoute(matched, {
    phone: user,
    isGroup: false,
    peerKind: "dm",
    ...(threadId ? { threadId } : {}),
  });
}

// What both inbound paths do, without a chat subscription in the way.
function inbound(config: RouterConfig, user: string, contactId: string, threadId?: string) {
  const matched = match(config, user, threadId);
  const landingSessionKey = previewCommittedSessionKey(matched, { threadId });
  const guard = evaluateOwnerDmGuard(
    { peerKind: "dm", sessionKey: landingSessionKey, senderContactId: contactId },
    owners,
  );
  const committed = guard.blocked ? null : commit(matched, user, threadId);
  return { landingSessionKey, guard, committed };
}

describe("owner DM guard on the session the commit lands in", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-owner-dm-routing-");
    getOrCreateSession(OWNER_SESSION, "main", "/tmp/main", { name: "main" });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("holds a colleague that a wildcard route forces into the owner's session, and admits the owner", () => {
    const config = configWith("per-peer", { pattern: "*", accountId: "acc", agent: "main", session: "main" });

    const peer = inbound(config, PEER_USER, PEER_CONTACT);
    expect(peer.landingSessionKey).toBe(OWNER_SESSION);
    expect(peer.guard).toEqual({ blocked: true, reason: "non_owner_dm_to_owner_session", ownerCount: 1 });

    const owner = inbound(config, OWNER_USER, OWNER_CONTACT);
    expect(owner.guard).toEqual({ blocked: false, reason: "owner" });
    expect(owner.committed?.sessionKey).toBe(OWNER_SESSION);
  });

  it("treats a thread forked from the owner's session as the owner's session", () => {
    const config = configWith("per-peer", { pattern: "*", accountId: "acc", agent: "main", session: "main" });

    const peer = inbound(config, PEER_USER, PEER_CONTACT, THREAD);
    expect(peer.landingSessionKey).toBe(`${OWNER_SESSION}:thread:${THREAD}`);
    expect(peer.guard.blocked).toBe(true);

    const owner = inbound(config, OWNER_USER, OWNER_CONTACT, THREAD);
    expect(owner.guard.blocked).toBe(false);
    expect(owner.committed?.sessionKey).toBe(`${OWNER_SESSION}:thread:${THREAD}`);
  });

  it("holds a colleague whatever route sends them to the owner's session: glob or literal", () => {
    for (const pattern of ["U0*", PEER_USER]) {
      const config = configWith("main", { pattern, accountId: "acc", agent: "main", session: "main" });

      expect(inbound(config, PEER_USER, PEER_CONTACT).guard).toEqual({
        blocked: true,
        reason: "non_owner_dm_to_owner_session",
        ownerCount: 1,
      });
    }
    const config = configWith("main", { pattern: "U0*", accountId: "acc", agent: "main", session: "main" });
    expect(inbound(config, OWNER_USER, OWNER_CONTACT).guard.blocked).toBe(false);
  });

  it("holds a colleague a literal route names even without forcing a session, while the agent's DMs share one", () => {
    const config = configWith("main", { pattern: PEER_USER, accountId: "acc", agent: "main" });

    const peer = inbound(config, PEER_USER, PEER_CONTACT);
    expect(peer.landingSessionKey).toBe(OWNER_SESSION);
    expect(peer.guard.blocked).toBe(true);
    expect(peer.committed).toBeNull();
  });

  it("lets a literal route give the colleague a session of their own", () => {
    for (const route of [
      { pattern: PEER_USER, accountId: "acc", agent: "main", dmScope: "per-peer" as const },
      { pattern: PEER_USER, accountId: "acc", agent: "ponte", session: "ponte-colleague" },
    ]) {
      const peer = inbound(configWith("main", route), PEER_USER, PEER_CONTACT);
      expect(peer.guard).toEqual({ blocked: false, reason: "not_owner_session" });
      expect(peer.committed?.sessionKey).not.toBe(OWNER_SESSION);
    }
  });

  it("previews the same key the commit lands in", () => {
    const scenarios: Array<{ config: RouterConfig; threadId?: string }> = [
      { config: configWith("main", { pattern: "*", accountId: "acc", agent: "main" }) },
      { config: configWith("per-peer", { pattern: "*", accountId: "acc", agent: "main" }) },
      { config: configWith("per-peer", { pattern: "*", accountId: "acc", agent: "main", session: "main" }) },
      {
        config: configWith("per-peer", { pattern: "*", accountId: "acc", agent: "main", session: "main" }),
        threadId: THREAD,
      },
      { config: configWith("main", { pattern: "U0*", accountId: "acc", agent: "main", session: "main" }) },
      { config: configWith("per-peer", { pattern: "*", accountId: "acc", agent: "main", session: "not-created-yet" }) },
      {
        config: configWith("per-peer", { pattern: "*", accountId: "acc", agent: "main", session: "not-created-yet" }),
        threadId: THREAD,
      },
    ];
    for (const { config, threadId } of scenarios) {
      const matched = match(config, PEER_USER, threadId);
      const preview = previewCommittedSessionKey(matched, { threadId });
      expect(commit(matched, PEER_USER, threadId).sessionKey).toBe(preview);
    }
  });

  it("names the forced session even when it belongs to another agent, whose commit refuses", () => {
    getOrCreateSession("agent:ponte:main", "ponte", "/tmp/ponte", { name: "ponte-shared" });
    const config = configWith("per-peer", { pattern: "*", accountId: "acc", agent: "main", session: "ponte-shared" });

    const matched = match(config, PEER_USER);
    expect(previewCommittedSessionKey(matched, {})).toBe("agent:ponte:main");
    expect(() => commit(matched, PEER_USER)).toThrow(RouteSessionAgentConflictError);
  });
});
