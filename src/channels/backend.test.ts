import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  closeRouterDb,
  dbCreateAgent,
  dbGetChannelBackendIngressReceipt,
  dbGetChatMessage,
  dbGetSessionChatBinding,
} from "../router/router-db.js";
import { closeSessionStore } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  acceptChannelIngress,
  CHANNEL_BACKEND_PROTOCOL,
  CHANNEL_BACKEND_SCHEMA_VERSION,
  setChannelBackendPromptPublisherForTests,
  type ChannelBackendPromptPublisher,
  type ChannelIngressRequest,
} from "./backend.js";
import {
  CHANNEL_RUNTIME_EVENTS_PROTOCOL,
  CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
  ChannelRuntimeEventSinkRegistry,
  projectChannelRuntimeEvent,
  readChannelRuntime,
} from "./runtime-events.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-channel-backend-");
  dbCreateAgent({
    id: "agent-a",
    name: "Agent A",
    cwd: "/tmp/ravi-channel-agent-a",
  });
});

afterEach(async () => {
  setChannelBackendPromptPublisherForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("channel backend ingress", () => {
  it("persists canonical local ids and publishes one content-bearing prompt", async () => {
    const published: Array<{
      sessionName: string;
      payload: Record<string, unknown>;
      messageId?: string;
    }> = [];
    setChannelBackendPromptPublisherForTests(async (sessionName, payload, options) => {
      published.push({ sessionName, payload, messageId: options?.messageId });
    });

    const result = await acceptChannelIngress(request());

    expect(result).toMatchObject({
      disposition: "accepted",
      requestId: "request-a",
      binding: {
        channelInstanceId: "channel-instance-a",
        agentId: "agent-a",
      },
    });
    expect(result.binding?.chatId).toMatch(/^chat_[0-9a-f]{24}$/);
    expect(result.binding?.messageId).toMatch(/^cm_[0-9a-f]{24}$/);
    expect(result.binding?.sessionId).toMatch(/^channel-[0-9a-f]{24}$/);
    expect(result.binding?.turnId).toMatch(/^turn_[0-9a-f]{24}$/);

    const receipt = dbGetChannelBackendIngressReceipt("channel-instance-a", "idempotency-a");
    expect(receipt).toMatchObject({
      state: "published",
      chatId: result.binding?.chatId,
      messageId: result.binding?.messageId,
      sessionName: result.binding?.sessionId,
      turnId: result.binding?.turnId,
    });
    expect(dbGetChatMessage(result.binding!.messageId)?.content).toEqual({
      blocks: [{ type: "text", text: "fixture input" }],
    });
    expect(dbGetSessionChatBinding(receipt!.sessionKey)).toMatchObject({
      chatId: result.binding?.chatId,
      agentId: "agent-a",
      bindingReason: "channel_backend",
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      sessionName: result.binding?.sessionId,
      messageId: receipt?.id,
      payload: {
        prompt: "fixture input",
        _channelBackend: {
          ingressRequestId: "request-a",
          binding: result.binding,
          target: {
            channelKind: "custom",
            connectionId: "connection-a",
            conversationId: "external-conversation-a",
          },
        },
      },
    });
  });

  it("carries an accepted binding into runtime lifecycle readback", async () => {
    setChannelBackendPromptPublisherForTests(mock(async () => {}));
    const result = await acceptChannelIngress(request());
    if (!result.binding) throw new Error("accepted ingress did not return a binding");

    const target = {
      channelKind: "custom",
      connectionId: "connection-a",
      conversationId: "external-conversation-a",
    };
    const events: string[] = [];
    const sinks = new ChannelRuntimeEventSinkRegistry();
    const unregister = sinks.register(target, {
      async emit(event) {
        events.push(event.kind);
      },
    });

    try {
      await projectChannelRuntimeEvent({
        metadata: {
          protocol: CHANNEL_BACKEND_PROTOCOL,
          schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
          ingressRequestId: result.requestId,
          correlationId: result.requestId,
          binding: result.binding,
          target,
        },
        event: { type: "text.delta", text: "Hello" },
        occurredAt: Date.parse("2026-07-24T18:00:01.000Z"),
        sinks,
      });
    } finally {
      unregister();
    }

    expect(events).toEqual(["turn.state_changed", "turn.assistant_delta"]);
    expect(
      readChannelRuntime({
        protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
        schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
        requestId: "runtime-readback-a",
        binding: result.binding,
      }),
    ).toMatchObject({
      binding: result.binding,
      state: "running",
      lastSequence: 2,
    });
  });

  it("returns one stable binding across retries and process restarts", async () => {
    const publisher = mock(async () => {});
    setChannelBackendPromptPublisherForTests(publisher);

    const first = await acceptChannelIngress(request());
    closeSessionStore();
    closeRouterDb();
    const duplicate = await acceptChannelIngress(
      request({
        requestId: "request-retry",
        receivedAt: "2026-07-24T18:00:05.000Z",
      }),
    );

    expect(duplicate.disposition).toBe("duplicate");
    expect(duplicate.requestId).toBe("request-retry");
    expect(duplicate.binding).toEqual(first.binding);
    expect(publisher).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an idempotency key is reused with different content", async () => {
    const publisher = mock(async () => {});
    setChannelBackendPromptPublisherForTests(publisher);

    await acceptChannelIngress(request());
    const conflict = await acceptChannelIngress(
      request({
        requestId: "request-conflict",
        content: [{ type: "text", text: "different" }],
      }),
    );

    expect(conflict).toMatchObject({
      disposition: "rejected",
      requestId: "request-conflict",
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        category: "validation",
        retryable: false,
      },
    });
    expect(conflict.binding).toBeUndefined();
    expect(publisher).toHaveBeenCalledTimes(1);
  });

  it("keeps acceptance durable when publication is temporarily unavailable", async () => {
    let attempts = 0;
    const publisher: ChannelBackendPromptPublisher = async () => {
      attempts++;
      if (attempts === 1) throw new Error("nats unavailable");
    };
    setChannelBackendPromptPublisherForTests(publisher);

    const unavailable = await acceptChannelIngress(request());
    expect(unavailable).toMatchObject({
      disposition: "rejected",
      error: {
        code: "UNAVAILABLE",
        category: "availability",
        retryable: true,
      },
    });
    expect(dbGetChannelBackendIngressReceipt("channel-instance-a", "idempotency-a")).toMatchObject({
      state: "accepted",
    });

    const recovered = await acceptChannelIngress(
      request({
        requestId: "request-retry",
        receivedAt: "2026-07-24T18:00:05.000Z",
      }),
    );
    expect(recovered.disposition).toBe("duplicate");
    expect(recovered.binding).toBeDefined();
    expect(dbGetChannelBackendIngressReceipt("channel-instance-a", "idempotency-a")).toMatchObject({
      state: "published",
    });
    expect(attempts).toBe(2);
  });

  it("allows only one concurrent caller to publish the accepted message", async () => {
    let releasePublish!: () => void;
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const publisher = mock(async () => {
      await publishGate;
    });
    setChannelBackendPromptPublisherForTests(publisher);

    const first = acceptChannelIngress(request());
    await waitUntil(() => publisher.mock.calls.length === 1);
    const duplicate = await acceptChannelIngress(
      request({
        requestId: "request-concurrent",
        receivedAt: "2026-07-24T18:00:05.000Z",
      }),
    );
    releasePublish();

    expect((await first).disposition).toBe("accepted");
    expect(duplicate.disposition).toBe("duplicate");
    expect(publisher).toHaveBeenCalledTimes(1);
  });
});

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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await sleep(1);
  }
  throw new Error("condition was not reached");
}
