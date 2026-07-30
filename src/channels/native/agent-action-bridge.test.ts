import { afterEach, describe, expect, it, mock } from "bun:test";
import { JSONCodec } from "nats";
import type { ContextRecord } from "../../router/router-db.js";
import { createRuntimeHostServices } from "../../runtime/host-services.js";
import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  type NativeLocalAgentActionDescriptor,
} from "./driver.js";
import {
  NATIVE_LOCAL_AGENT_ACTION_BRIDGE_QUEUE,
  NATIVE_LOCAL_AGENT_ACTION_BRIDGE_SUBJECT,
  requestNativeLocalAgentAction,
  startNativeLocalAgentActionBridgeResponder,
  type NativeLocalAgentActionBridgeMessage,
  type NativeLocalAgentActionBridgeRequestConnection,
  type NativeLocalAgentActionBridgeResponderConnection,
  type NativeLocalAgentActionBridgeSubscription,
} from "./agent-action-bridge.js";
import { NativeLocalAgentActionRegistry, nativeLocalAgentActions } from "./agent-actions.js";

const descriptor: NativeLocalAgentActionDescriptor = {
  toolName: "example_create_space",
  description: "Create a provider-owned collaboration space.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
  },
  sourceAccountId: "account-1",
  authorizationMode: "driver_handler",
};

afterEach(() => {
  nativeLocalAgentActions.clearForTests();
});

describe("native local Agent action process bridge", () => {
  it("discovers a turn-scoped descriptor in the daemon and invokes the isolated runner handler once", async () => {
    const connection = new InMemoryRequestReplyConnection();
    const runnerRegistry = new NativeLocalAgentActionRegistry();
    const handler = mock(async (request) => ({
      protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
      schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
      requestId: request.requestId,
      disposition: "completed" as const,
      text: `Created ${String(request.arguments.name)}.`,
      completedAt: "2026-07-30T03:00:01.000Z",
    }));
    runnerRegistry.register({
      provider: "example",
      channelInstanceId: "example-channel",
      descriptor,
      handler,
    });
    const responder = startNativeLocalAgentActionBridgeResponder({
      connection,
      registry: runnerRegistry,
    });
    const runtimeContext = context();
    const services = createRuntimeHostServices({
      context: runtimeContext,
      agentId: "agent-1",
      sessionName: "session-1",
      toolContext: { context: runtimeContext },
      nativeLocalAgentActionRequester: (input) => requestNativeLocalAgentAction(input, { connection, timeoutMs: 250 }),
    });

    try {
      expect(nativeLocalAgentActions.list(runtimeContext)).toEqual([]);
      expect(services.listDynamicTools().map(({ name }) => name)).toContain("example_create_space");
      await expect(
        services.executeDynamicTool({
          toolName: "example_create_space",
          callId: "action-request-1",
          arguments: { name: "roadmap" },
        }),
      ).resolves.toEqual({
        success: true,
        contentItems: [{ type: "inputText", text: "Created roadmap." }],
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "action-request-1",
          agentId: "agent-1",
          sessionName: "session-1",
          source: {
            channelKind: "example",
            accountId: "account-1",
            conversationId: "conversation-1",
          },
        }),
      );
      expect(connection.subscriptionOptions).toEqual({
        subject: NATIVE_LOCAL_AGENT_ACTION_BRIDGE_SUBJECT,
        queue: NATIVE_LOCAL_AGENT_ACTION_BRIDGE_QUEUE,
      });
    } finally {
      await responder.stop();
    }
  });

  it("fails closed for a copied source, wrong Channel instance, and stopped runner", async () => {
    const connection = new InMemoryRequestReplyConnection();
    const runnerRegistry = new NativeLocalAgentActionRegistry();
    const handler = mock(async (request) => ({
      protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
      schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
      requestId: request.requestId,
      disposition: "completed" as const,
      text: "Must not run.",
      completedAt: "2026-07-30T03:00:01.000Z",
    }));
    runnerRegistry.register({
      provider: "example",
      channelInstanceId: "another-channel",
      descriptor,
      handler,
    });
    const responder = startNativeLocalAgentActionBridgeResponder({
      connection,
      registry: runnerRegistry,
    });
    const copiedContext = context({
      source: {
        channel: "example",
        accountId: "account-2",
        chatId: "conversation-1",
      },
    });
    const copiedServices = createRuntimeHostServices({
      context: copiedContext,
      agentId: "agent-1",
      sessionName: "session-1",
      toolContext: { context: copiedContext },
    });
    expect(copiedServices.listDynamicTools().map(({ name }) => name)).not.toContain("example_create_space");

    const runtimeContext = context();
    const services = createRuntimeHostServices({
      context: runtimeContext,
      agentId: "agent-1",
      sessionName: "session-1",
      toolContext: { context: runtimeContext },
      nativeLocalAgentActionRequester: (input) => requestNativeLocalAgentAction(input, { connection, timeoutMs: 250 }),
    });

    await expect(
      services.executeDynamicTool({
        toolName: "example_create_space",
        callId: "action-request-wrong-instance",
        arguments: {},
      }),
    ).resolves.toMatchObject({
      success: false,
      reason: "UNAVAILABLE",
    });
    expect(handler).not.toHaveBeenCalled();

    await responder.stop();
    await expect(
      services.executeDynamicTool({
        toolName: "example_create_space",
        callId: "action-request-stopped",
        arguments: {},
      }),
    ).resolves.toEqual({
      success: false,
      reason: "native_local_agent_action_unavailable",
      contentItems: [
        {
          type: "inputText",
          text: "example_create_space is unavailable for this turn.",
        },
      ],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps runtime-context authorization ahead of a remote handler", async () => {
    const connection = new InMemoryRequestReplyConnection();
    const runnerRegistry = new NativeLocalAgentActionRegistry();
    const runtimeAuthorizedDescriptor: NativeLocalAgentActionDescriptor = {
      ...descriptor,
      authorizationMode: "runtime_context",
    };
    const handler = mock(async (request) => ({
      protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
      schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
      requestId: request.requestId,
      disposition: "completed" as const,
      text: "Created.",
      completedAt: "2026-07-30T03:00:01.000Z",
    }));
    runnerRegistry.register({
      provider: "example",
      channelInstanceId: "example-channel",
      descriptor: runtimeAuthorizedDescriptor,
      handler,
    });
    const responder = startNativeLocalAgentActionBridgeResponder({
      connection,
      registry: runnerRegistry,
    });
    const deniedContext = context({}, runtimeAuthorizedDescriptor);
    const deniedServices = createRuntimeHostServices({
      context: deniedContext,
      agentId: "agent-1",
      sessionName: "session-1",
      toolContext: { context: deniedContext },
      nativeLocalAgentActionRequester: (input) => requestNativeLocalAgentAction(input, { connection, timeoutMs: 250 }),
    });
    const allowedContext = context(
      {
        capabilities: [
          {
            permission: "use",
            objectType: "tool",
            objectId: "example_create_space",
            source: "test",
          },
        ],
      },
      runtimeAuthorizedDescriptor,
    );
    const allowedServices = createRuntimeHostServices({
      context: allowedContext,
      agentId: "agent-1",
      sessionName: "session-1",
      toolContext: { context: allowedContext },
      nativeLocalAgentActionRequester: (input) => requestNativeLocalAgentAction(input, { connection, timeoutMs: 250 }),
    });

    try {
      expect(deniedServices.listDynamicTools().map(({ name }) => name)).not.toContain("example_create_space");
      expect(allowedServices.listDynamicTools().map(({ name }) => name)).toContain("example_create_space");
      await expect(
        allowedServices.executeDynamicTool({
          toolName: "example_create_space",
          callId: "action-request-runtime-authorized",
          arguments: {},
        }),
      ).resolves.toMatchObject({ success: true });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await responder.stop();
    }
  });

  it("hides a tool when local and accepted-turn descriptors conflict", () => {
    nativeLocalAgentActions.register({
      provider: "example",
      channelInstanceId: "example-channel",
      descriptor,
      handler: async (request) => ({
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        requestId: request.requestId,
        disposition: "completed",
        text: "Must not run.",
        completedAt: "2026-07-30T03:00:01.000Z",
      }),
    });
    const runtimeContext = context(
      {},
      {
        ...descriptor,
        description: "A conflicting descriptor for the same tool.",
      },
    );
    const services = createRuntimeHostServices({
      context: runtimeContext,
      agentId: "agent-1",
      sessionName: "session-1",
      toolContext: { context: runtimeContext },
    });

    expect(services.listDynamicTools().map(({ name }) => name)).not.toContain("example_create_space");
  });

  it("returns only a bounded safe failure when the runner handler throws", async () => {
    const connection = new InMemoryRequestReplyConnection();
    const runnerRegistry = new NativeLocalAgentActionRegistry();
    runnerRegistry.register({
      provider: "example",
      channelInstanceId: "example-channel",
      descriptor,
      handler: async () => {
        throw new Error("provider credential and stack must remain private");
      },
    });
    const responder = startNativeLocalAgentActionBridgeResponder({
      connection,
      registry: runnerRegistry,
    });

    try {
      await expect(
        requestNativeLocalAgentAction(bridgeRequest("action-request-throw"), {
          connection,
          timeoutMs: 250,
        }),
      ).resolves.toMatchObject({
        requestId: "action-request-throw",
        disposition: "rejected",
        error: {
          code: "INTERNAL",
          category: "internal",
          retryable: false,
          correlationId: "action-request-throw",
        },
      });
    } finally {
      await responder.stop();
    }
  });

  it("rejects malformed or mismatched bridge replies", async () => {
    const codec = JSONCodec<unknown>();
    const malformedConnection: NativeLocalAgentActionBridgeRequestConnection = {
      async request() {
        return { data: codec.encode({ unexpected: "payload" }) };
      },
    };
    const mismatchedConnection: NativeLocalAgentActionBridgeRequestConnection = {
      async request() {
        return {
          data: codec.encode({
            protocol: "ravi.channel.native-local-action-bridge",
            schemaVersion: 1,
            requestId: "another-request",
            result: {
              protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
              schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
              requestId: "another-request",
              disposition: "completed",
              text: "Must not be accepted.",
              completedAt: "2026-07-30T03:00:01.000Z",
            },
          }),
        };
      },
    };

    await expect(
      requestNativeLocalAgentAction(bridgeRequest("action-request-malformed"), {
        connection: malformedConnection,
        timeoutMs: 250,
      }),
    ).resolves.toBeNull();
    await expect(
      requestNativeLocalAgentAction(bridgeRequest("action-request-mismatch"), {
        connection: mismatchedConnection,
        timeoutMs: 250,
      }),
    ).resolves.toBeNull();
  });
});

function context(
  overrides: Partial<ContextRecord> = {},
  turnDescriptor: NativeLocalAgentActionDescriptor = descriptor,
): ContextRecord {
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
    capabilities: [],
    metadata: {
      nativeLocalAgentActions: {
        source: {
          channelKind: "example",
          channelInstanceId: "example-channel",
          accountId: "account-1",
        },
        descriptors: [turnDescriptor],
      },
    },
    createdAt: Date.parse("2026-07-30T03:00:00.000Z"),
    ...overrides,
  };
}

function bridgeRequest(requestId: string) {
  return {
    channelInstanceId: "example-channel",
    request: {
      protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
      schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
      requestId,
      toolName: "example_create_space",
      arguments: {},
      agentId: "agent-1",
      sessionName: "session-1",
      source: {
        channelKind: "example",
        accountId: "account-1",
        conversationId: "conversation-1",
      },
      requestedAt: "2026-07-30T03:00:00.000Z",
    },
  } as const;
}

class InMemoryRequestReplyConnection
  implements NativeLocalAgentActionBridgeResponderConnection, NativeLocalAgentActionBridgeRequestConnection
{
  private subscription?: InMemorySubscription;
  subscriptionOptions?: { subject: string; queue?: string };

  subscribe(subject: string, options?: { readonly queue?: string }): NativeLocalAgentActionBridgeSubscription {
    this.subscriptionOptions = {
      subject,
      ...(options?.queue === undefined ? {} : { queue: options.queue }),
    };
    this.subscription = new InMemorySubscription();
    return this.subscription;
  }

  async request(
    _subject: string,
    data: Uint8Array,
    options: { readonly timeout: number },
  ): Promise<{ readonly data: Uint8Array }> {
    const subscription = this.subscription;
    if (!subscription || subscription.closed) throw new Error("no responders");
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), options.timeout);
      timer.unref?.();
      subscription.push({
        data,
        respond(response) {
          clearTimeout(timer);
          resolve({ data: response });
          return true;
        },
      });
    });
  }
}

class InMemorySubscription implements NativeLocalAgentActionBridgeSubscription {
  private readonly messages: NativeLocalAgentActionBridgeMessage[] = [];
  private wake: (() => void) | undefined;
  closed = false;

  push(message: NativeLocalAgentActionBridgeMessage): void {
    this.messages.push(message);
    this.wake?.();
    this.wake = undefined;
  }

  unsubscribe(): void {
    this.closed = true;
    this.wake?.();
    this.wake = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<NativeLocalAgentActionBridgeMessage> {
    while (!this.closed || this.messages.length > 0) {
      const message = this.messages.shift();
      if (message) {
        yield message;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
