/**
 * Tests for router/resolver.ts
 *
 * Tests pure routing functions (matchRoute, findRoute, matchPattern) and
 * the thread: pattern priority introduced in the instances architecture.
 *
 * No DB access — all tests use in-memory RouterConfig.
 */

import { describe, it, expect } from "bun:test";
import { matchPattern, findRoute, matchRoute } from "./resolver.js";
import type { RouterConfig, RouteConfig, AgentConfig } from "./types.js";

// ============================================================================
// Test fixtures
// ============================================================================

const agentMain: AgentConfig = {
  id: "main",
  cwd: "/tmp/main",
  dmScope: "per-peer",
};

const agentVendas: AgentConfig = {
  id: "vendas",
  cwd: "/tmp/vendas",
  dmScope: "per-peer",
};

const agentSupport: AgentConfig = {
  id: "support",
  cwd: "/tmp/support",
  dmScope: "per-peer",
};

function makeConfig(routes: RouteConfig[], overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    agents: {
      main: agentMain,
      vendas: agentVendas,
      support: agentSupport,
    },
    routes,
    defaultAgent: "main",
    defaultDmScope: "per-peer",
    accountAgents: {},
    instanceToAccount: {},
    instances: {},
    ...overrides,
  };
}

// ============================================================================
// matchPattern
// ============================================================================

describe("matchPattern", () => {
  it("exact match returns true", () => {
    expect(matchPattern("5511999999999", "5511999999999")).toBe(true);
  });

  it("exact match is case-insensitive", () => {
    expect(matchPattern("AbcDef", "abcdef")).toBe(true);
  });

  it("exact mismatch returns false", () => {
    expect(matchPattern("5511999999999", "5511888888888")).toBe(false);
  });

  it("wildcard * matches everything", () => {
    expect(matchPattern("5511999999999", "*")).toBe(true);
    expect(matchPattern("anything", "*")).toBe(true);
  });

  it("prefix wildcard: '5511*' matches 55119...", () => {
    expect(matchPattern("5511999", "5511*")).toBe(true);
    expect(matchPattern("5511000", "5511*")).toBe(true);
  });

  it("prefix wildcard: '5511*' does not match 5512...", () => {
    expect(matchPattern("5512999", "5511*")).toBe(false);
  });

  it("suffix wildcard: '*999' matches xxx999", () => {
    expect(matchPattern("123999", "*999")).toBe(true);
    expect(matchPattern("abc999", "*999")).toBe(true);
  });

  it("contains wildcard: '*abc*' matches strings containing abc", () => {
    expect(matchPattern("prefixabcsuffix", "*abc*")).toBe(true);
    expect(matchPattern("abc", "*abc*")).toBe(true);
  });

  it("thread: exact pattern match", () => {
    expect(matchPattern("thread:12345", "thread:12345")).toBe(true);
    expect(matchPattern("thread:12345", "thread:99999")).toBe(false);
  });

  it("group: exact pattern match", () => {
    expect(matchPattern("group:123456789", "group:123456789")).toBe(true);
    expect(matchPattern("group:123456789", "group:000000000")).toBe(false);
  });
});

// ============================================================================
// findRoute
// ============================================================================

describe("findRoute", () => {
  const routes: RouteConfig[] = [
    { pattern: "*", accountId: "main", agent: "main", priority: 0 },
    { pattern: "5511*", accountId: "main", agent: "vendas", priority: 10 },
    { pattern: "5511999999999", accountId: "main", agent: "support", priority: 20 },
  ];

  it("returns highest priority matching route", () => {
    const route = findRoute("5511999999999", routes);
    expect(route?.agent).toBe("support"); // priority 20
  });

  it("falls back to lower priority when exact match absent", () => {
    const route = findRoute("5511888888888", routes);
    expect(route?.agent).toBe("vendas"); // priority 10
  });

  it("falls back to wildcard * when no other match", () => {
    const route = findRoute("5521999999999", routes);
    expect(route?.agent).toBe("main"); // priority 0
  });

  it("returns null when no route matches at all", () => {
    const route = findRoute("5521999", [], "main");
    expect(route).toBeNull();
  });

  it("filters by accountId when provided", () => {
    const mixedRoutes: RouteConfig[] = [
      { pattern: "*", accountId: "main", agent: "main", priority: 0 },
      { pattern: "*", accountId: "vendas-acc", agent: "vendas", priority: 0 },
    ];
    const route = findRoute("5511999", mixedRoutes, "vendas-acc");
    expect(route?.agent).toBe("vendas");
    expect(route?.accountId).toBe("vendas-acc");
  });

  it("does not return routes from other accounts", () => {
    const mixedRoutes: RouteConfig[] = [
      { pattern: "*", accountId: "acc-A", agent: "main", priority: 0 },
    ];
    const route = findRoute("5511999", mixedRoutes, "acc-B");
    expect(route).toBeNull();
  });
});

// ============================================================================
// matchRoute — thread: pattern priority
// ============================================================================

describe("matchRoute — thread: pattern priority", () => {
  it("thread route is matched before group route when threadId present", () => {
    const config = makeConfig([
      { pattern: "group:123456789", accountId: "main", agent: "vendas", priority: 0 },
      { pattern: "thread:abc123", accountId: "main", agent: "support", priority: 0 },
    ]);

    const result = matchRoute(config, {
      phone: "5511999999999",
      accountId: "main",
      isGroup: true,
      groupId: "123456789",
      threadId: "abc123",
    });

    // thread: pattern has highest priority
    expect(result?.agentId).toBe("support");
    expect(result?.route?.pattern).toBe("thread:abc123");
  });

  it("group route is used when threadId is absent", () => {
    const config = makeConfig([
      { pattern: "group:123456789", accountId: "main", agent: "vendas", priority: 0 },
      { pattern: "thread:abc123", accountId: "main", agent: "support", priority: 0 },
    ]);

    const result = matchRoute(config, {
      phone: "5511999999999",
      accountId: "main",
      isGroup: true,
      groupId: "123456789",
      // no threadId
    });

    expect(result?.agentId).toBe("vendas");
    expect(result?.route?.pattern).toBe("group:123456789");
  });

  it("falls back to phone route when neither thread nor group match", () => {
    const config = makeConfig([
      { pattern: "5511*", accountId: "main", agent: "vendas", priority: 0 },
    ]);

    const result = matchRoute(config, {
      phone: "5511999999999",
      accountId: "main",
      isGroup: false,
    });

    expect(result?.agentId).toBe("vendas");
  });

  it("falls back to default agent when no route matches", () => {
    const config = makeConfig([], {
      accountAgents: {},
    });

    const result = matchRoute(config, {
      phone: "5511999999999",
      // no accountId → uses defaultAgent
    });

    expect(result?.agentId).toBe("main");
  });

  it("returns null when account has no matching route and no agent mapping", () => {
    // Account "orphan" exists in accountAgents map (set to undefined-equivalent)
    // To trigger the "skip" branch, accountId must be in accountAgents with a defined value
    // OR we need accountId with no entry at all in accountAgents
    const config = makeConfig(
      [{ pattern: "5511*", accountId: "other", agent: "vendas", priority: 0 }],
      {
        accountAgents: { orphan: "nonexistent" }, // orphan has a mapping
      }
    );

    // Remove the agent from agents to make it throw — not the right approach.
    // The null path: effectiveAccount AND config.accountAgents[effectiveAccount] === undefined
    // That means accountId is provided but NOT in accountAgents at all
    const config2 = makeConfig(
      [{ pattern: "5521*", accountId: "other", agent: "vendas", priority: 0 }],
      {
        // accountAgents has NO entry for "unknown-acc"
        accountAgents: {},
      }
    );
    // accounts with no match and no entry in accountAgents return null only if
    // there IS an entry but it's undefined. Let's test the exact condition:
    const config3: RouterConfig = {
      ...config2,
      accountAgents: { "unknown-acc": undefined as unknown as string },
    };

    const result = matchRoute(config3, {
      phone: "5511999",
      accountId: "unknown-acc",
    });
    expect(result).toBeNull();
  });
});

// ============================================================================
// matchRoute — route.policy passthrough
// ============================================================================

describe("matchRoute — route.policy passthrough", () => {
  it("route.policy is included in matched result", () => {
    const config = makeConfig([
      {
        pattern: "group:111",
        accountId: "main",
        agent: "main",
        priority: 0,
        policy: "closed",
      },
    ]);

    const result = matchRoute(config, {
      phone: "5511999",
      accountId: "main",
      isGroup: true,
      groupId: "111",
    });

    expect(result).not.toBeNull();
    expect(result!.route?.policy).toBe("closed");
  });

  it("route without policy has policy undefined", () => {
    const config = makeConfig([
      { pattern: "*", accountId: "main", agent: "main", priority: 0 },
    ]);

    const result = matchRoute(config, { phone: "5511999", accountId: "main" });
    expect(result?.route?.policy).toBeUndefined();
  });
});

// ============================================================================
// matchRoute — accountId scoping
// ============================================================================

describe("matchRoute — accountId scoping", () => {
  it("uses accountAgent mapping when no route matches", () => {
    const config = makeConfig([], {
      accountAgents: { "acc-vendas": "vendas" },
    });

    const result = matchRoute(config, {
      phone: "5511999",
      accountId: "acc-vendas",
    });

    expect(result?.agentId).toBe("vendas");
  });

  it("route agent takes priority over accountAgent mapping", () => {
    const config = makeConfig(
      [{ pattern: "*", accountId: "acc-main", agent: "support", priority: 0 }],
      { accountAgents: { "acc-main": "vendas" } }
    );

    const result = matchRoute(config, {
      phone: "5511999",
      accountId: "acc-main",
    });

    expect(result?.agentId).toBe("support");
  });
});

// ============================================================================
// matchRoute — thread: normalization
// ============================================================================

describe("matchRoute — thread: normalization", () => {
  it("normalizes threadId to 'thread:ID' for route matching", () => {
    const config = makeConfig([
      { pattern: "thread:msg-99", accountId: "main", agent: "support", priority: 0 },
    ]);

    const result = matchRoute(config, {
      phone: "5511999",
      accountId: "main",
      threadId: "msg-99",
    });

    expect(result?.agentId).toBe("support");
  });

  it("does not match thread route when threadId differs", () => {
    const config = makeConfig([
      { pattern: "thread:msg-99", accountId: "main", agent: "support", priority: 0 },
      { pattern: "*", accountId: "main", agent: "main", priority: 0 },
    ]);

    const result = matchRoute(config, {
      phone: "5511999",
      accountId: "main",
      threadId: "msg-different",
    });

    // Fallback to * → main
    expect(result?.agentId).toBe("main");
  });
});
