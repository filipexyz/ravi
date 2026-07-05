import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChannelOutboundJob } from "./channels/outbound-stream.js";
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
      error: "TIMEOUT",
    });
  });

  it("emits delivery.failed for non-timeout native queue errors", async () => {
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
      error: "stream unavailable",
    });
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
