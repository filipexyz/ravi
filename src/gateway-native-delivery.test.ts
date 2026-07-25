import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChannelOutboundJob } from "./channels/outbound-stream.js";
import { configStore } from "./config-store.js";
import { dbUpsertChannel } from "./router/router-db.js";
import type { ResponseMessage } from "./runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

const publishedJobs: ChannelOutboundJob[] = [];
const decoder = new TextDecoder();
const acceptedMsgIds = new Set<string>();
let publishBehavior: "ok" | "timeoutOnceThenOk" | "timeoutAlwaysBeforePublish" | "failBeforePublish" = "ok";
let publishAttempts = 0;
const fakeJetStreamManager = {
  streams: {
    info: mock(async () => ({})),
    add: mock(async () => ({})),
  },
  consumers: {
    info: mock(async () => ({})),
    add: mock(async () => ({})),
  },
};
const fakeJetStream = {
  publish: mock(async (_subject: string, payload: Uint8Array, options?: { msgID?: string }) => {
    publishAttempts++;
    if (publishBehavior === "failBeforePublish") {
      throw new Error("stream unavailable");
    }
    if (publishBehavior === "timeoutAlwaysBeforePublish") {
      const error = new Error("TIMEOUT") as Error & { code?: string };
      error.code = "TIMEOUT";
      throw error;
    }

    const msgID = options?.msgID;
    if (!msgID || !acceptedMsgIds.has(msgID)) {
      if (msgID) acceptedMsgIds.add(msgID);
      publishedJobs.push(JSON.parse(decoder.decode(payload)) as ChannelOutboundJob);
    }

    if (publishBehavior === "timeoutOnceThenOk" && publishAttempts === 1) {
      const error = new Error("TIMEOUT") as Error & { code?: string };
      error.code = "TIMEOUT";
      throw error;
    }
  }),
};
const fakeNatsConnection = {
  jetstream: () => fakeJetStream,
  jetstreamManager: async () => fakeJetStreamManager,
};

mock.module("./nats.js", () => ({
  ensureConnected: mock(async () => fakeNatsConnection),
  getNats: mock(() => fakeNatsConnection),
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  isExplicitConnect: mock(() => true),
  publish: mock(async () => {}),
  subscribe: mock(async function* () {}),
  nats: {
    emit: mock(async () => {}),
    subscribe: mock(async function* () {}),
    close: mock(async () => {}),
  },
}));

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gateway-native-test-");
  publishedJobs.length = 0;
  acceptedMsgIds.clear();
  publishBehavior = "ok";
  publishAttempts = 0;
  fakeJetStream.publish.mockClear();
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function createGateway() {
  const { Gateway } = await import("./gateway.js");
  const emitted: Array<[string, Record<string, unknown>]> = [];
  const omniSend = mock(async () => ({ messageId: "omni-1" }));
  const gateway = new Gateway({
    omniSender: {
      send: omniSend,
      sendTyping: mock(async () => {}),
      sendReaction: mock(async () => {}),
      deleteMessage: mock(async () => {}),
      editMessage: mock(async () => {}),
      sendMedia: mock(async () => ({})),
      markRead: mock(async () => {}),
    } as never,
    omniConsumer: {
      getActiveTarget: () => undefined,
      clearActiveTarget: () => {},
      renewActiveTarget: mock(async () => false),
    } as never,
    emitEvent: mock(async (topic: string, payload: Record<string, unknown>) => {
      emitted.push([topic, payload]);
    }),
  });
  return { gateway, emitted, omniSend };
}

async function getPublishOutboxJob(idempotencyKey: string) {
  const { getChannelOutboundPublishJob } = await import("./channels/outbound-publish-outbox.js");
  return getChannelOutboundPublishJob(idempotencyKey);
}

async function reconcilePublishOutbox(
  options: { now?: () => number; emitEvent?: (topic: string, payload: Record<string, unknown>) => Promise<void> } = {},
) {
  const { reconcileDueChannelOutboundPublishes } = await import("./channels/outbound-publish-outbox.js");
  return reconcileDueChannelOutboundPublishes(options);
}

async function handleResponse(gateway: unknown, sessionName: string, response: ResponseMessage): Promise<void> {
  await (
    gateway as {
      handleResponseEvent(sessionName: string, response: ResponseMessage): Promise<void>;
    }
  ).handleResponseEvent(sessionName, response);
}

async function sendTyping(
  gateway: unknown,
  target: NonNullable<ResponseMessage["target"]>,
  active: boolean,
  metadata: { sessionName: string; reason: string },
): Promise<void> {
  await (
    gateway as {
      sendTyping(
        target: NonNullable<ResponseMessage["target"]>,
        active: boolean,
        metadata: { sessionName: string; reason: string },
      ): Promise<void>;
    }
  ).sendTyping(target, active, metadata);
}

describe("Gateway native channel outbound queue", () => {
  it("queues Slack responses through CHANNEL_OUTBOUND instead of Omni", async () => {
    const { gateway, emitted, omniSend } = await createGateway();

    await handleResponse(gateway, "main-slack", {
      _emitId: "emit-1",
      response: "oi slack",
      target: {
        channel: "slack",
        accountId: "slack",
        instanceId: "slack-main",
        chatId: "C123",
        canonicalChatId: "chat_slack_C123",
        threadId: "1710000000.000100",
      },
    });

    expect(omniSend).not.toHaveBeenCalled();
    expect(publishedJobs).toHaveLength(1);
    expect(publishedJobs[0]).toMatchObject({
      jobId: "runtime:main-slack:emit-1",
      status: "queued",
      request: {
        channelId: "slack",
        accountId: "slack",
        targetChatId: "C123",
        targetThreadId: "1710000000.000100",
        origin: {
          sessionName: "main-slack",
          emitId: "emit-1",
        },
        content: {
          type: "text",
          text: "oi slack",
        },
      },
    });
    expect(emitted[0]?.[0]).toBe("ravi.session.main-slack.delivery");
    expect(emitted[0]?.[1]).toMatchObject({
      status: "queued",
      reason: "native_channel_outbound",
      jobId: "runtime:main-slack:emit-1",
    });
    const record = await getPublishOutboxJob(publishedJobs[0]!.request.idempotencyKey);
    expect(record).toMatchObject({
      jobId: "runtime:main-slack:emit-1",
      status: "published",
    });
  });

  it("queues responses for an enabled configured native provider instead of Omni", async () => {
    dbUpsertChannel({
      name: "example-native-main",
      provider: "example-native",
    });
    configStore.refresh();
    const { gateway, emitted, omniSend } = await createGateway();

    await handleResponse(gateway, "main-example-native", {
      _emitId: "emit-configured-native",
      response: "hello native",
      target: {
        channel: "example-native",
        accountId: "example-native-main",
        instanceId: "example-native-main",
        chatId: "conversation-123",
      },
    });

    expect(omniSend).not.toHaveBeenCalled();
    expect(publishedJobs).toHaveLength(1);
    expect(publishedJobs[0]).toMatchObject({
      jobId: "runtime:main-example-native:emit-configured-native",
      status: "queued",
      request: {
        channelId: "example-native",
        accountId: "example-native-main",
        targetChatId: "conversation-123",
        origin: {
          sessionName: "main-example-native",
          emitId: "emit-configured-native",
        },
        content: {
          type: "text",
          text: "hello native",
        },
      },
    });
    expect(emitted[0]?.[0]).toBe("ravi.session.main-example-native.delivery");
    expect(emitted[0]?.[1]).toMatchObject({
      status: "queued",
      reason: "native_channel_outbound",
      jobId: "runtime:main-example-native:emit-configured-native",
    });
  });

  it("retries JetStream publish ack timeouts with an idempotent msgID before marking queued", async () => {
    publishBehavior = "timeoutOnceThenOk";
    const { gateway, emitted } = await createGateway();

    await handleResponse(gateway, "main-slack", {
      _emitId: "emit-timeout",
      response: "oi slack",
      target: {
        channel: "slack",
        accountId: "slack",
        instanceId: "slack-main",
        chatId: "C123",
      },
    });

    expect(fakeJetStream.publish).toHaveBeenCalledTimes(2);
    expect(publishedJobs).toHaveLength(1);
    expect(publishedJobs[0]?.jobId).toBe("runtime:main-slack:emit-timeout");
    expect(emitted[0]?.[0]).toBe("ravi.session.main-slack.delivery");
    expect(emitted[0]?.[1]).toMatchObject({
      status: "queued",
      reason: "native_channel_outbound",
      jobId: "runtime:main-slack:emit-timeout",
    });
  });

  it("emits delivery.failed when JetStream publish ack keeps timing out without confirmation", async () => {
    publishBehavior = "timeoutAlwaysBeforePublish";
    const { gateway, emitted } = await createGateway();

    await handleResponse(gateway, "main-slack", {
      _emitId: "emit-timeout-fail",
      response: "oi slack",
      target: {
        channel: "slack",
        accountId: "slack",
        instanceId: "slack-main",
        chatId: "C123",
      },
    });

    expect(fakeJetStream.publish).toHaveBeenCalledTimes(3);
    expect(publishedJobs).toHaveLength(0);
    expect(emitted[0]?.[0]).toBe("ravi.session.main-slack.delivery");
    expect(emitted[0]?.[1]).toMatchObject({
      status: "failed",
      reason: "queue_error",
      jobId: "runtime:main-slack:emit-timeout-fail",
      error: "TIMEOUT",
      retryable: true,
    });
    expect(emitted[0]?.[1]).toHaveProperty("nextAttemptAt");
    const record = await getPublishOutboxJob("runtime:main-slack:emit-timeout-fail:slack:slack:C123:root");
    expect(record).toMatchObject({
      jobId: "runtime:main-slack:emit-timeout-fail",
      status: "pending",
      attemptCount: 1,
      lastErrorMessage: "TIMEOUT",
    });
  });

  it("persists and later republishes non-timeout native queue errors without duplicate provider sends", async () => {
    publishBehavior = "failBeforePublish";
    const { gateway, emitted } = await createGateway();

    await handleResponse(gateway, "main-slack", {
      _emitId: "emit-fail",
      response: "oi slack",
      target: {
        channel: "slack",
        accountId: "slack",
        instanceId: "slack-main",
        chatId: "C123",
      },
    });

    expect(publishedJobs).toHaveLength(0);
    expect(emitted[0]?.[0]).toBe("ravi.session.main-slack.delivery");
    expect(emitted[0]?.[1]).toMatchObject({
      status: "failed",
      reason: "queue_error",
      jobId: "runtime:main-slack:emit-fail",
      error: "stream unavailable",
      retryable: true,
    });
    const idempotencyKey = "runtime:main-slack:emit-fail:slack:slack:C123:root";
    expect(await getPublishOutboxJob(idempotencyKey)).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastErrorMessage: "stream unavailable",
    });

    publishBehavior = "ok";
    const reconciled = await reconcilePublishOutbox({
      now: () => Date.now() + 60_000,
      emitEvent: async (topic, payload) => {
        emitted.push([topic, payload]);
      },
    });

    expect(reconciled).toEqual({ attempted: 1, published: 1, failed: 0 });
    expect(publishedJobs).toHaveLength(1);
    expect(publishedJobs[0]?.jobId).toBe("runtime:main-slack:emit-fail");
    const publishedRecord = await getPublishOutboxJob(idempotencyKey);
    expect(publishedRecord).toMatchObject({
      status: "published",
      attemptCount: 1,
    });
    expect(publishedRecord?.lastErrorMessage).toBeUndefined();
    expect(emitted[1]?.[0]).toBe("ravi.session.main-slack.delivery");
    expect(emitted[1]?.[1]).toMatchObject({
      status: "queued",
      reason: "native_channel_outbound_reconciled",
      jobId: "runtime:main-slack:emit-fail",
    });

    const second = await reconcilePublishOutbox({ now: () => Date.now() + 120_000 });
    expect(second).toEqual({ attempted: 0, published: 0, failed: 0 });
    expect(publishedJobs).toHaveLength(1);
  });

  it("publishes Slack typing presence through the native channel presence topic", async () => {
    const { gateway, emitted, omniSend } = await createGateway();

    await sendTyping(
      gateway,
      {
        channel: "slack",
        accountId: "slack",
        instanceId: "slack-main",
        chatId: "C123",
        sourceMessageId: "1713000000.000100",
      },
      true,
      {
        sessionName: "main-slack",
        reason: "runtime-turn.started",
      },
    );

    expect(omniSend).not.toHaveBeenCalled();
    expect(emitted[0]?.[0]).toBe("ravi.channel.presence.slack");
    expect(emitted[0]?.[1]).toMatchObject({
      channelId: "slack",
      sessionName: "main-slack",
      active: true,
      reason: "runtime-turn.started",
      target: {
        channel: "slack",
        chatId: "C123",
        sourceMessageId: "1713000000.000100",
      },
    });
    expect(emitted[1]?.[0]).toBe("ravi.presence.typing");
    expect(emitted[1]?.[1]).toMatchObject({
      sessionName: "main-slack",
      active: true,
      status: "active",
      reason: "native:runtime-turn.started",
    });
  });
});
