import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  CHANNEL_BACKEND_PROTOCOL,
  CHANNEL_BACKEND_SCHEMA_VERSION,
  setChannelBackendPromptPublisherForTests,
  type ChannelIngressRequest,
  type LocalChannelMessageBinding,
} from "../../channels/backend.js";
import {
  CHANNEL_RUNTIME_EVENTS_PROTOCOL,
  CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
  setChannelRuntimeAbortPublisherForTests,
  type ChannelInterruptRequest,
  type ChannelRuntimeReadbackRequest,
} from "../../channels/runtime-events.js";
import { ChannelBackendCommands, ChannelBackendRuntimeCommands } from "../../cli/commands/channel-backend.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import {
  dbCreateAgent,
  dbGetChannelBackendIngressReceipt,
  type ContextCapability,
  type ContextRecord,
} from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { startGateway, type GatewayHandle } from "./server.js";

const registry = buildRegistry([ChannelBackendCommands, ChannelBackendRuntimeCommands]);
const exactContext = context("rctx_channel_backend_exact", [
  { permission: "mutate", objectType: "agent", objectId: "agent-a", source: "test" },
  { permission: "read", objectType: "agent", objectId: "agent-a", source: "test" },
]);
const semanticContext = context("rctx_channel_backend_semantic", [
  { permission: "mutate", objectType: "agent", objectId: "channel-ingress", source: "test" },
]);

let stateDir: string | null = null;
let handle: GatewayHandle | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sdk-channel-backend-");
  dbCreateAgent({
    id: "agent-a",
    name: "Agent A",
    cwd: "/tmp/ravi-sdk-channel-agent-a",
  });
  setChannelBackendPromptPublisherForTests(mock(async () => {}));
  setChannelRuntimeAbortPublisherForTests(mock(async () => {}));
  handle = startGateway({
    host: "127.0.0.1",
    port: 0,
    registry,
    auth: {
      resolveContext(token) {
        if (token === exactContext.contextKey) return { ...exactContext };
        if (token === semanticContext.contextKey) return { ...semanticContext };
        return null;
      },
    },
  });
});

afterEach(async () => {
  setChannelBackendPromptPublisherForTests();
  setChannelRuntimeAbortPublisherForTests();
  if (handle) {
    await handle.stop();
    handle = null;
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("gateway — channel backend ingress", () => {
  it("requires a concrete local agent grant and returns stable canonical bindings", async () => {
    const meta = await fetch(`${handle!.url}/api/v1/_meta/registry`);
    const metaBody = (await meta.json()) as { commands: Array<{ fullName: string; path: string }> };
    expect(metaBody.commands.find((command) => command.fullName === "channels.backend.ingress")).toMatchObject({
      fullName: "channels.backend.ingress",
      path: "/api/v1/channels/backend/ingress",
    });

    const denied = await post(semanticContext.contextKey, request());
    expect(denied.status).toBe(403);
    expect(dbGetChannelBackendIngressReceipt("channel-instance-a", "idempotency-a")).toBeNull();

    const accepted = await post(exactContext.contextKey, request());
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as {
      disposition: string;
      binding: {
        chatId: string;
        messageId: string;
        sessionId: string;
        turnId: string;
      };
    };
    expect(acceptedBody.disposition).toBe("accepted");

    const duplicate = await post(
      exactContext.contextKey,
      request({
        requestId: "request-retry",
        receivedAt: "2026-07-24T18:00:05.000Z",
      }),
    );
    expect(duplicate.status).toBe(200);
    const duplicateBody = (await duplicate.json()) as {
      requestId: string;
      disposition: string;
      binding: typeof acceptedBody.binding;
    };
    expect(duplicateBody.requestId).toBe("request-retry");
    expect(duplicateBody.disposition).toBe("duplicate");
    expect(duplicateBody.binding).toEqual(acceptedBody.binding);
  });

  it("rejects an unsupported contract version before local persistence", async () => {
    const response = await post(exactContext.contextKey, {
      ...request(),
      schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION + 1,
    });

    expect(response.status).toBe(400);
    expect(dbGetChannelBackendIngressReceipt("channel-instance-a", "idempotency-a")).toBeNull();
  });

  it("exposes authorized readback and idempotent interrupt commands for accepted turns", async () => {
    const meta = await fetch(`${handle!.url}/api/v1/_meta/registry`);
    const metaBody = (await meta.json()) as { commands: Array<{ fullName: string; path: string }> };
    expect(metaBody.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullName: "channels.backend.runtime.readback",
          path: "/api/v1/channels/backend/runtime/readback",
        }),
        expect.objectContaining({
          fullName: "channels.backend.runtime.interrupt",
          path: "/api/v1/channels/backend/runtime/interrupt",
        }),
      ]),
    );

    const accepted = await post(exactContext.contextKey, request());
    const acceptedBody = (await accepted.json()) as {
      binding: LocalChannelMessageBinding;
    };
    const binding = acceptedBody.binding;

    const readbackRequest: ChannelRuntimeReadbackRequest = {
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: "readback-a",
      binding,
    };
    const readback = await postRuntime("readback", exactContext.contextKey, readbackRequest);
    expect(readback.status).toBe(200);
    await expect(readback.json()).resolves.toMatchObject({
      state: "accepted",
      lastSequence: 0,
      binding,
    });

    const interruptRequest: ChannelInterruptRequest = {
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: "interrupt-a",
      idempotencyKey: "interrupt-idempotency-a",
      binding,
      requestedAt: "2026-07-24T18:00:01.000Z",
    };
    const interrupt = await postRuntime("interrupt", exactContext.contextKey, interruptRequest);
    expect(interrupt.status).toBe(200);
    await expect(interrupt.json()).resolves.toMatchObject({
      requestId: "interrupt-a",
      disposition: "requested",
    });

    const denied = await postRuntime("readback", semanticContext.contextKey, readbackRequest);
    expect(denied.status).toBe(403);
  });
});

function context(contextKey: string, capabilities: ContextCapability[]): ContextRecord {
  return {
    contextId: contextKey.replace(/^rctx_/, "ctx_"),
    contextKey,
    kind: "test-runtime",
    agentId: "gateway-test-agent",
    capabilities,
    metadata: { authorityMode: "delegated" },
    createdAt: Date.now(),
  };
}

async function post(token: string, requestBody: Record<string, unknown>): Promise<Response> {
  return fetch(`${handle!.url}/api/v1/channels/backend/ingress`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      agentId: "agent-a",
      request: requestBody,
    }),
  });
}

async function postRuntime(
  operation: "interrupt" | "readback",
  token: string,
  requestBody: ChannelInterruptRequest | ChannelRuntimeReadbackRequest,
): Promise<Response> {
  return fetch(`${handle!.url}/api/v1/channels/backend/runtime/${operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      agentId: "agent-a",
      request: requestBody,
    }),
  });
}

function request(overrides: Partial<ChannelIngressRequest> = {}): ChannelIngressRequest {
  return {
    protocol: CHANNEL_BACKEND_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
    requestId: "request-a",
    idempotencyKey: "idempotency-a",
    localActorId: "actor-a",
    channelInstanceId: "channel-instance-a",
    agentId: "agent-a",
    external: {
      channelKind: "custom",
      connectionId: "connection-a",
      conversationId: "external-conversation-a",
      senderId: "external-sender-a",
      messageId: "external-message-a",
    },
    content: [{ type: "text", text: "fixture input" }],
    receivedAt: "2026-07-24T18:00:00.000Z",
    ...overrides,
  };
}
