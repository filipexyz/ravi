import { describe, expect, it } from "bun:test";
import type { AgentConfig } from "../router/types.js";
import type { SessionEntry } from "../router/types.js";
import { resolveTuiTarget } from "./tui-entry.js";

function makeAgent(id: string): AgentConfig {
  return {
    id,
    cwd: `/tmp/${id}`,
    provider: "claude",
  };
}

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionKey: overrides.sessionKey ?? "agent:main:main",
    name: overrides.name ?? "main",
    agentId: overrides.agentId ?? "main",
    agentCwd: overrides.agentCwd ?? "/tmp/main",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    systemSent: false,
    abortedLastRun: false,
    compactionCount: 0,
    ephemeral: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("resolveTuiTarget", () => {
  it("prefers an existing session over an agent id", () => {
    const result = resolveTuiTarget("main", {
      resolveSessionByName: () => makeSession({ name: "main", sessionKey: "agent:main:main", agentId: "main" }),
      getAgentById: () => makeAgent("main"),
    });

    expect(result).toEqual({
      agentId: "main",
      sessionName: "main",
      source: "session",
    });
  });

  it("falls back to agent when no session exists", () => {
    const result = resolveTuiTarget("support", {
      resolveSessionByName: () => null,
      getAgentById: () => makeAgent("support"),
    });

    expect(result).toEqual({
      agentId: "support",
      source: "agent",
    });
  });

  it("throws when neither agent nor session exist", () => {
    expect(() =>
      resolveTuiTarget("missing", {
        resolveSessionByName: () => null,
        getAgentById: () => null,
      }),
    ).toThrow("Unknown agent or session: missing");
  });
});
