import { afterEach, describe, expect, it } from "bun:test";
import type { ContextRecord } from "../../router/router-db.js";
import { NATIVE_CHANNEL_DRIVER_PROTOCOL, NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION } from "./driver.js";
import { nativeLocalAgentActions } from "./agent-actions.js";

function context(overrides: Partial<ContextRecord> = {}): ContextRecord {
  return {
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
    capabilities: [],
    createdAt: Date.parse("2026-07-26T12:00:00.000Z"),
    ...overrides,
  };
}

function register(sourceAccountId = "account-1", channelInstanceId = "example-local") {
  const requests: unknown[] = [];
  const dispose = nativeLocalAgentActions.register({
    provider: "example",
    channelInstanceId,
    descriptor: {
      toolName: "example_create_space",
      description: "Create a provider-owned collaboration space.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      sourceAccountId,
    },
    async handler(request) {
      requests.push(structuredClone(request));
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
  return { dispose, requests };
}

afterEach(() => {
  nativeLocalAgentActions.clearForTests();
});

describe("native local agent action registry", () => {
  it("advertises and invokes only the action scoped to the current source", async () => {
    const registered = register();
    expect(nativeLocalAgentActions.list(context()).map(({ toolName }) => toolName)).toEqual(["example_create_space"]);
    expect(
      nativeLocalAgentActions.list(
        context({
          source: {
            channel: "example",
            accountId: "another-account",
            chatId: "conversation-1",
          },
        }),
      ),
    ).toEqual([]);

    const result = await nativeLocalAgentActions.invoke({
      context: context(),
      toolName: "example_create_space",
      arguments: { name: "roadmap" },
      requestId: "request-1",
      now: () => "2026-07-26T12:00:00.000Z",
    });
    expect(result?.disposition).toBe("completed");
    expect(registered.requests).toEqual([
      {
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        requestId: "request-1",
        toolName: "example_create_space",
        arguments: { name: "roadmap" },
        agentId: "agent-1",
        sessionName: "session-1",
        source: {
          channelKind: "example",
          accountId: "account-1",
          conversationId: "conversation-1",
        },
        requestedAt: "2026-07-26T12:00:00.000Z",
      },
    ]);

    registered.dispose();
    expect(nativeLocalAgentActions.list(context())).toEqual([]);
  });

  it("fails closed when two registrations match the same tool and source", async () => {
    register();
    register();
    expect(nativeLocalAgentActions.list(context())).toEqual([]);
    expect(
      await nativeLocalAgentActions.invoke({
        context: context(),
        toolName: "example_create_space",
        arguments: { name: "roadmap" },
      }),
    ).toBeUndefined();
  });

  it("resolves otherwise ambiguous registrations by exact Channel instance for the process bridge", async () => {
    register("account-1", "example-a");
    const selected = register("account-1", "example-b");
    expect(nativeLocalAgentActions.list(context())).toEqual([]);
    expect(
      nativeLocalAgentActions.listForSource({
        provider: "example",
        channelInstanceId: "example-b",
        accountId: "account-1",
      }),
    ).toHaveLength(1);

    await expect(
      nativeLocalAgentActions.invokeRequest(
        {
          protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
          schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
          requestId: "request-exact-instance",
          toolName: "example_create_space",
          arguments: { name: "roadmap" },
          agentId: "agent-1",
          sessionName: "session-1",
          source: {
            channelKind: "example",
            accountId: "account-1",
            conversationId: "conversation-1",
          },
          requestedAt: "2026-07-26T12:00:00.000Z",
        },
        { channelInstanceId: "example-b" },
      ),
    ).resolves.toMatchObject({
      requestId: "request-exact-instance",
      disposition: "completed",
    });
    expect(selected.requests).toHaveLength(1);
  });
});
