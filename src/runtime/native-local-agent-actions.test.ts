import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { NATIVE_CHANNEL_DRIVER_PROTOCOL, NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION } from "../channels/native/driver.js";
import { nativeLocalAgentActions } from "../channels/native/agent-actions.js";
import type { ContextRecord } from "../router/router-db.js";
import { createRuntimeHostServices } from "./host-services.js";

function context(allowed: boolean, toolName = "example_create_space"): ContextRecord {
  return {
    contextId: "context-1",
    contextKey: "context-key-1",
    kind: "turn-runtime",
    agentId: "agent-1",
    sessionKey: "agent:agent-1:example",
    sessionName: "session-1",
    source: {
      channel: "example",
      accountId: "account-1",
      chatId: "conversation-1",
    },
    capabilities: allowed
      ? [
          {
            permission: "use",
            objectType: "tool",
            objectId: toolName,
            source: "test",
          },
        ]
      : [],
    createdAt: Date.parse("2026-07-26T12:00:00.000Z"),
  };
}

afterEach(() => {
  nativeLocalAgentActions.clearForTests();
});

describe("runtime native local agent actions", () => {
  it("does not advertise a driver action without local tool permission", () => {
    nativeLocalAgentActions.register({
      provider: "example",
      channelInstanceId: "example-local",
      descriptor: {
        toolName: "example_create_space",
        description: "Create a provider-owned collaboration space.",
        inputSchema: { type: "object", properties: {} },
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
    const runtimeContext = context(false);
    const services = createRuntimeHostServices({
      context: runtimeContext,
      agentId: "agent-1",
      sessionName: "session-1",
      toolContext: { context: runtimeContext },
    });
    expect(services.listDynamicTools().some(({ name }) => name === "example_create_space")).toBe(false);
  });

  it("delegates explicit driver-handler action authorization without ambient turn capabilities", async () => {
    let invoked = 0;
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
        authorizationMode: "driver_handler",
      },
      handler: async (request) => {
        invoked += 1;
        return {
          protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
          schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
          requestId: request.requestId,
          disposition: "completed",
          text: "Created.",
          completedAt: "2026-07-26T12:00:01.000Z",
        };
      },
    });
    const runtimeContext = context(false);
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
        callId: "request-handler-authorized",
        arguments: { name: "roadmap" },
      }),
    ).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "Created." }],
    });
    expect(invoked).toBe(1);
  });

  it("keeps the driver handler denial final", async () => {
    nativeLocalAgentActions.register({
      provider: "example",
      channelInstanceId: "example-local",
      descriptor: {
        toolName: "example_create_space",
        description: "Create a provider-owned collaboration space.",
        inputSchema: { type: "object", properties: {} },
        sourceAccountId: "account-1",
        authorizationMode: "driver_handler",
      },
      handler: async (request) => ({
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        requestId: request.requestId,
        disposition: "rejected",
        error: {
          code: "LOCAL_PERMISSION_DENIED",
          category: "authorization",
          retryable: false,
        },
        completedAt: "2026-07-26T12:00:01.000Z",
      }),
    });
    const runtimeContext = context(false);
    const services = createRuntimeHostServices({
      context: runtimeContext,
      agentId: "agent-1",
      sessionName: "session-1",
      toolContext: { context: runtimeContext },
    });

    expect(
      await services.executeDynamicTool({
        toolName: "example_create_space",
        callId: "request-handler-denied",
        arguments: {},
      }),
    ).toEqual({
      success: false,
      reason: "LOCAL_PERMISSION_DENIED",
      contentItems: [
        {
          type: "inputText",
          text: "Action rejected: LOCAL_PERMISSION_DENIED",
        },
      ],
    });
  });

  it("does not advertise a driver action that collides with any built-in command", () => {
    nativeLocalAgentActions.register({
      provider: "example",
      channelInstanceId: "example-local",
      descriptor: {
        toolName: "channels_create",
        description: "Create a provider-owned channel.",
        inputSchema: { type: "object", properties: {} },
        sourceAccountId: "account-1",
      },
      handler: async (request) => ({
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        requestId: request.requestId,
        disposition: "completed",
        text: "Must not run.",
        completedAt: "2026-07-26T12:00:01.000Z",
      }),
    });
    const runtimeContext = context(true, "channels_create");
    const services = createRuntimeHostServices({
      context: runtimeContext,
      agentId: "agent-1",
      sessionName: "session-1",
      toolContext: { context: runtimeContext },
    });

    expect(services.listDynamicTools().some(({ name }) => name === "channels_create")).toBe(false);
  });

  it("bounds a stalled driver action with the runtime tool timeout", async () => {
    let handlerStarted = false;
    nativeLocalAgentActions.register({
      provider: "example",
      channelInstanceId: "example-local",
      descriptor: {
        toolName: "example_create_space",
        description: "Create a provider-owned collaboration space.",
        inputSchema: { type: "object", properties: {} },
        sourceAccountId: "account-1",
      },
      handler: async () => {
        handlerStarted = true;
        return await new Promise<never>(() => {});
      },
    });
    const runtimeContext = context(true);
    const services = createRuntimeHostServices({
      context: runtimeContext,
      agentId: "agent-1",
      sessionName: "session-1",
      toolContext: { context: runtimeContext },
    });
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      _delay?: number,
      ...args: unknown[]
    ) => {
      setImmediate(() => callback(...args));
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      expect(
        await services.executeDynamicTool({
          toolName: "example_create_space",
          callId: "request-timeout",
          arguments: {},
        }),
      ).toEqual({
        success: false,
        reason: "native_local_agent_action_failed",
        contentItems: [{ type: "inputText", text: "example_create_space could not be completed." }],
      });
      expect(handlerStarted).toBe(true);
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
