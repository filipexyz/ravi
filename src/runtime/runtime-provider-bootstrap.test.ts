import { afterEach, describe, expect, it } from "bun:test";
import { nativeLocalAgentActions } from "../channels/native/agent-actions.js";
import { NATIVE_CHANNEL_DRIVER_PROTOCOL, NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION } from "../channels/native/driver.js";
import type { AgentConfig } from "../router/index.js";
import type { ContextRecord } from "../router/router-db.js";
import { prepareRuntimeProviderBootstrap } from "./runtime-provider-bootstrap.js";
import type { RuntimeCapabilities, SessionRuntimeProvider } from "./types.js";

const capabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "host" },
  execution: { mode: "sdk" },
  sessionState: { mode: "provider-session-id" },
  usage: { semantics: "terminal-event" },
  tools: {
    permissionMode: "ravi-host",
    accessRequirement: "tool_surface",
    supportsParallelCalls: false,
  },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: {
    availability: "none",
    loadedState: "none",
  },
  supportsSessionResume: false,
  supportsSessionFork: false,
  supportsPartialText: true,
  supportsToolHooks: true,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};

afterEach(() => {
  nativeLocalAgentActions.clearForTests();
});

describe("runtime provider bootstrap", () => {
  it("bridges source-scoped native Channel actions through the shared host capability", async () => {
    const context: ContextRecord = {
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
      createdAt: Date.parse("2026-07-27T12:00:00.000Z"),
    };
    nativeLocalAgentActions.register({
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
        completedAt: "2026-07-27T12:00:01.000Z",
      }),
    });
    const provider: SessionRuntimeProvider = {
      id: "test-provider",
      getCapabilities: () => capabilities,
      prepareSession: () => ({
        startRequest: {
          approveRuntimeRequest: async () => ({ approved: true }),
        },
      }),
      startSession: () => ({
        provider: "test-provider",
        events: (async function* () {})(),
        interrupt: async () => {},
      }),
    };

    const result = await prepareRuntimeProviderBootstrap({
      runtimeProvider: provider,
      runtimeCapabilities: capabilities,
      agent: { id: "agent-1", cwd: "/tmp/agent-1" } satisfies AgentConfig,
      sessionName: "session-1",
      sessionCwd: "/tmp/agent-1",
      resolvedSource: context.source,
      toolContext: { context },
      context,
    });
    const startRequest = result.providerBootstrap?.startRequest;

    expect(typeof startRequest?.approveRuntimeRequest).toBe("function");
    expect(startRequest?.dynamicTools?.map(({ name }) => name)).toContain("example_create_space");
    await expect(
      startRequest?.handleRuntimeToolCall?.({
        toolName: "example_create_space",
        callId: "call-1",
        arguments: { name: "roadmap" },
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "Created." }],
    });
  });
});
