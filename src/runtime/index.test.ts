import { describe, expect, it } from "bun:test";
import { nativeLocalAgentActions } from "../channels/native/agent-actions.js";
import { NATIVE_CHANNEL_DRIVER_PROTOCOL, NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION } from "../channels/native/driver.js";
import type { ContextRecord } from "../router/router-db.js";
import { createRuntimeHostServices } from "./host-services.js";
import {
  assertRuntimeCompatibility,
  createRuntimeProvider,
  DEFAULT_RUNTIME_PROVIDER_ID,
  getRuntimeCompatibilityIssues,
  listRegisteredRuntimeProviderIds,
  registerRuntimeProvider,
  unregisterRuntimeProvider,
} from "./index.js";
import type { RuntimeProvider } from "./types.js";

describe("runtime compatibility preflight", () => {
  it("exposes a source-scoped driver action only with matching local tool permission", async () => {
    const runtimeContext: ContextRecord = {
      contextId: "context-1",
      contextKey: "context-key-1",
      kind: "turn-runtime",
      agentId: "agent-1",
      sessionName: "session-1",
      source: {
        channel: "example",
        accountId: "account-1",
        chatId: "conversation-1",
      },
      capabilities: [
        {
          permission: "use",
          objectType: "tool",
          objectId: "example_create_space",
          source: "test",
        },
      ],
      createdAt: Date.parse("2026-07-26T12:00:00.000Z"),
    };
    const dispose = nativeLocalAgentActions.register({
      provider: "example",
      channelInstanceId: "example-local",
      descriptor: {
        toolName: "example_create_space",
        description: "Create a provider-owned collaboration space.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
        sourceAccountId: "account-1",
      },
      handler: async (request) => ({
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        requestId: request.requestId,
        disposition: "completed",
        text: "Created.",
        completedAt: "2026-07-26T12:00:01.000Z",
      }),
    });

    try {
      const services = createRuntimeHostServices({
        context: runtimeContext,
        agentId: "agent-1",
        sessionName: "session-1",
        toolContext: { context: runtimeContext },
      });
      expect(services.listDynamicTools().map(({ name }) => name)).toContain("example_create_space");
      expect(
        await services.executeDynamicTool({
          toolName: "example_create_space",
          callId: "request-1",
          arguments: { name: "roadmap" },
        }),
      ).toEqual({
        success: true,
        contentItems: [{ type: "inputText", text: "Created." }],
      });
    } finally {
      dispose();
    }
  });

  it("uses Codex as the default runtime provider", () => {
    expect(DEFAULT_RUNTIME_PROVIDER_ID).toBe("codex");
    expect(createRuntimeProvider().id).toBe("codex");
    expect(listRegisteredRuntimeProviderIds()).toContain("claude");
    expect(listRegisteredRuntimeProviderIds()).toEqual(expect.arrayContaining(["codex", "claude", "pi"]));
  });

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
        runtimeControl: { supported: false, operations: [] },
        dynamicTools: { mode: "none" },
        execution: { mode: "sdk" },
        sessionState: { mode: "provider-session-id" },
        usage: { semantics: "terminal-event" },
        tools: {
          permissionMode: "provider-native",
          accessRequirement: "tool_and_executable",
          supportsParallelCalls: false,
        },
        systemPrompt: { mode: "append" },
        terminalEvents: { guarantee: "adapter" },
        skillVisibility: { availability: "none", loadedState: "none" },
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

  it("blocks restricted tool access for Pi until Ravi-hosted tool hooks exist", () => {
    const issues = getRuntimeCompatibilityIssues(createRuntimeProvider("pi"), {
      toolAccessMode: "restricted",
    });

    expect(issues.map((issue) => issue.code)).toEqual(["restricted_tool_access_unsupported"]);
  });

  it("supports registering additional runtime providers without changing the factory switch", () => {
    try {
      registerRuntimeProvider("test-provider", () => ({
        id: "test-provider",
        getCapabilities: () => ({
          runtimeControl: { supported: false, operations: [] },
          dynamicTools: { mode: "none" },
          execution: { mode: "sdk" },
          sessionState: { mode: "provider-session-id" },
          usage: { semantics: "terminal-event" },
          tools: {
            permissionMode: "ravi-host",
            accessRequirement: "tool_and_executable",
            supportsParallelCalls: false,
          },
          systemPrompt: { mode: "append" },
          terminalEvents: { guarantee: "adapter" },
          skillVisibility: { availability: "none", loadedState: "none" },
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

  it("keeps built-in runtime providers registered", () => {
    expect(() => unregisterRuntimeProvider("codex")).toThrow("Cannot unregister built-in runtime provider 'codex'");
    expect(createRuntimeProvider("codex").id).toBe("codex");
  });
});
