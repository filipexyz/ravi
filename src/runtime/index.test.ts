import { describe, expect, it } from "bun:test";
import {
  assertRuntimeCompatibility,
  createRuntimeProvider,
  getRuntimeCompatibilityIssues,
  listRegisteredRuntimeProviderIds,
  registerRuntimeProvider,
  unregisterRuntimeProvider,
} from "./index.js";
import type { RuntimeProvider } from "./types.js";

describe("runtime compatibility preflight", () => {
  it("allows Claude providers to satisfy restricted tool access", () => {
    const provider = createRuntimeProvider("claude");

    expect(() =>
      assertRuntimeCompatibility(provider, {
        requiresMcpServers: true,
        requiresRemoteSpawn: true,
        toolAccessMode: "restricted",
      }),
    ).not.toThrow();
  });

  it("reports provider capability restrictions through the shared runtime abstraction", () => {
    const issues = getRuntimeCompatibilityIssues(createRuntimeProvider("codex"), {
      requiresMcpServers: true,
      requiresRemoteSpawn: true,
      toolAccessMode: "restricted",
    });

    expect(issues.map((issue) => issue.code)).toEqual(["mcp_servers_unsupported", "remote_spawn_unsupported"]);
  });

  it("reports restricted tool access when runtime hooks are unavailable", () => {
    const provider: RuntimeProvider = {
      id: "codex",
      getCapabilities: () => ({
        supportsSessionResume: true,
        supportsSessionFork: true,
        supportsPartialText: true,
        supportsToolHooks: false,
        supportsPlugins: true,
        supportsMcpServers: true,
        supportsRemoteSpawn: true,
      }),
    };

    const issues = getRuntimeCompatibilityIssues(provider, {
      toolAccessMode: "restricted",
    });

    expect(issues.map((issue) => issue.code)).toEqual(["restricted_tool_access_unsupported"]);
  });

  it("allows Codex when the agent is already unrestricted", () => {
    const provider = createRuntimeProvider("codex");

    expect(() =>
      assertRuntimeCompatibility(provider, {
        toolAccessMode: "unrestricted",
      }),
    ).not.toThrow();
  });

  it("supports registering additional runtime providers without changing the factory switch", () => {
    try {
      registerRuntimeProvider("test-provider", () => ({
        id: "test-provider",
        getCapabilities: () => ({
          supportsSessionResume: false,
          supportsSessionFork: false,
          supportsPartialText: false,
          supportsToolHooks: true,
          supportsPlugins: false,
          supportsMcpServers: false,
          supportsRemoteSpawn: false,
        }),
        startSession: () => ({
          provider: "test-provider",
          events: (async function* () {})(),
          interrupt: async () => {},
        }),
      }));

      expect(listRegisteredRuntimeProviderIds()).toContain("test-provider");
      expect(createRuntimeProvider("test-provider").id).toBe("test-provider");
    } finally {
      unregisterRuntimeProvider("test-provider");
    }
  });
});
