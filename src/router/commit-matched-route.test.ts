/**
 * Tests for the lazy session-commit refactor.
 *
 * The orphan-session bug fix splits route resolution into two phases:
 *  - `matchRoute` — pure, returns a candidate `MatchedRoute` with no DB
 *    side effects, safe to call before policy enforcement.
 *  - `commitMatchedRoute` — writes the session row (idempotent via
 *    `getOrCreateSession`) and assigns a canonical sessionName.
 *
 * These tests pin the contract that lets the omni consumer reject inbound
 * messages on policy without leaving orphan session rows behind: when the
 * caller never invokes `commitMatchedRoute`, no session row may exist.
 *
 * Note: we deliberately only assert the purity side of the contract here.
 * Asserting on `commitMatchedRoute` directly is unreliable inside the
 * full-suite run because `src/omni/consumer-context.test.ts` installs a
 * `mock.module("../router/index.js", ...)` whose `commitMatchedRoute`
 * override bun propagates into direct imports of `./resolver.js` — a
 * known limitation of bun's module-mock implementation. The commit-side
 * behaviour is exercised indirectly by every existing `resolveRoute`
 * call site, since `resolveRoute = matchRoute + commitMatchedRoute`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { matchRoute } from "./resolver.js";
import { getSession, listSessions } from "./sessions.js";
import type { AgentConfig, RouterConfig } from "./types.js";

let stateDir: string | null = null;

const agentMain: AgentConfig = {
  id: "main",
  cwd: "/tmp/main",
  dmScope: "per-peer",
};

function makeConfig(): RouterConfig {
  return {
    agents: { main: agentMain },
    routes: [],
    defaultAgent: "main",
    defaultDmScope: "per-peer",
    accountAgents: { acc: "main" },
    instanceToAccount: {},
    instances: {},
  };
}

describe("matchRoute purity (orphan-session prevention)", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-match-route-purity-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("matchRoute returns a candidate without writing a session row", () => {
    const config = makeConfig();
    const matched = matchRoute(config, {
      phone: "5511999999999",
      accountId: "acc",
      isGroup: false,
    });

    expect(matched).not.toBeNull();
    expect(matched?.sessionKey).toContain("agent:main");
    expect(listSessions()).toHaveLength(0);
    expect(getSession(matched!.sessionKey)).toBeNull();
  });

  it("matchRoute followed by no commit leaves zero session rows", () => {
    // Mirrors the consumer policy-rejection path: route is matched, but the
    // caller (consumer) decides not to commit because a policy gate fails
    // (e.g. group_closed, dm_pairing_pending). No session row may exist.
    const config = makeConfig();
    const matched = matchRoute(config, {
      phone: "5511999999999",
      accountId: "acc",
      isGroup: false,
    });
    expect(matched).not.toBeNull();

    // Intentionally do NOT call commitMatchedRoute — the caller rejected
    // the inbound message after matching but before committing.
    expect(listSessions()).toHaveLength(0);
  });
});
