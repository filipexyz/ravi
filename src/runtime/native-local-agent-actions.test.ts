import { afterEach, describe, expect, it } from "bun:test";
import { NATIVE_CHANNEL_DRIVER_PROTOCOL, NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION } from "../channels/native/driver.js";
import { nativeLocalAgentActions } from "../channels/native/agent-actions.js";
import type { ContextRecord } from "../router/router-db.js";
import { createRuntimeHostServices } from "./host-services.js";

function context(allowed: boolean): ContextRecord {
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
            objectId: "example_create_space",
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
});
