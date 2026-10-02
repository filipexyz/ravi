import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { configStore } from "./config-store.js";
import type { ChannelOutboundJob } from "./channels/outbound-stream.js";
import type { SlackTextSendInput } from "./channels/slack/text-send.js";
import type { requestWhatsAppRpc } from "./channels/whatsapp/rpc-client.js";
import * as slackTextSend from "./channels/slack/text-send.js";
import type { ResponseMessage } from "./runtime/message-types.js";
import { dbUpsertChannel, dbUpsertChat, dbUpsertChatMessage, dbUpsertInstance, getDb } from "./router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

const publishedJobs: ChannelOutboundJob[] = [];
const slackMediaSends: Array<Record<string, unknown>> = [];
const slackTextSends: SlackTextSendInput[] = [];
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

mock.module("./channels/slack/media.js", () => ({
  sendSlackMedia: mock(async (input: Record<string, unknown>) => {
    slackMediaSends.push(input);
    return {
      transport: "slack-native",
      provider: "slack",
      success: true,
      status: "sent",
      fileId: "F123",
      messageId: "1720000000.000100",
      raw: { ok: true },
    };
  }),
}));

let stateDir: string | null = null;
let sendSlackTextSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gateway-native-test-");
  publishedJobs.length = 0;
  slackMediaSends.length = 0;
  slackTextSends.length = 0;
  sendSlackTextSpy?.mockRestore();
  sendSlackTextSpy = spyOn(slackTextSend, "sendSlackText").mockImplementation(async (input: SlackTextSendInput) => {
    slackTextSends.push(input);
    return {
      transport: "slack-native",
      provider: "slack",
      success: true,
      status: "sent",
      messageId: "1784000000.000100",
      raw: { ok: true },
    };
  });
  acceptedMsgIds.clear();
  publishBehavior = "ok";
  publishAttempts = 0;
  fakeJetStream.publish.mockClear();
});

afterEach(async () => {
  sendSlackTextSpy?.mockRestore();
  sendSlackTextSpy = undefined;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function createGateway() {
  const { Gateway } = await import("./gateway.js");
  const emitted: Array<[string, Record<string, unknown>]> = [];
  const senderSend = mock(async () => ({ messageId: "msg-1" }));
  const senderSendMedia = mock(async () => ({ messageId: "media-1" }));
  const senderSendReaction = mock(async () => {});
  const senderEditMessage = mock(async () => {});
  const senderDeleteMessage = mock(async () => {});
  const senderSendSticker = mock(async () => ({ messageId: "sticker-1" }));
  const gateway = new Gateway({
    sender: {
      send: senderSend,
      sendTyping: mock(async () => {}),
      sendReaction: senderSendReaction,
      deleteMessage: senderDeleteMessage,
      editMessage: senderEditMessage,
      sendMedia: senderSendMedia,
      sendSticker: senderSendSticker,
      markRead: mock(async () => {}),
    } as never,
    presenceTargets: {
      getActiveTarget: () => undefined,
      clearActiveTarget: () => {},
      renewActiveTarget: mock(async () => false),
    } as never,
    emitEvent: mock(async (topic: string, payload: Record<string, unknown>) => {
      emitted.push([topic, payload]);
    }),
  });
  return {
    gateway,
    emitted,
    senderSend,
    senderSendMedia,
    senderSendReaction,
    senderEditMessage,
    senderDeleteMessage,
    senderSendSticker,
  };
}

function ensureGatewaySession(sessionName: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `
      INSERT OR IGNORE INTO sessions (session_key, name, agent_id, agent_cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    )
    .run(`agent:main:${sessionName}`, sessionName, "main", "/tmp/ravi-gateway-test/main", now, now);
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
  it("queues Slack responses through CHANNEL_OUTBOUND instead of the instance sender", async () => {
    const { gateway, emitted, senderSend } = await createGateway();

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

    expect(senderSend).not.toHaveBeenCalled();
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

  it("delivers response media to the WhatsApp target through the channel sender without using session defaults", async () => {
    dbUpsertInstance({
      name: "main",
      instanceId: "11111111-1111-1111-1111-111111111111",
      channel: "whatsapp",
    });
    configStore.refresh();
    const { gateway, emitted, senderSend, senderSendMedia } = await createGateway();

    await handleResponse(gateway, "main-whatsapp", {
      _emitId: "emit-media-wa",
      response: "imagem pronta",
      content: [
        {
          type: "media",
          media: {
            type: "image",
            filePath: "/tmp/generated.png",
            filename: "generated.png",
            mimeType: "image/png",
            idempotencyKey: "media-key-wa",
          },
        },
        { type: "text", text: "imagem pronta" },
      ],
      target: {
        channel: "whatsapp",
        accountId: "main",
        instanceId: "11111111-1111-1111-1111-111111111111",
        chatId: "group:120363407390920496",
        canonicalChatId: "chat_whatsapp_source",
      },
    });

    expect(senderSendMedia).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "120363407390920496@g.us",
      "/tmp/generated.png",
      "image",
      "generated.png",
      undefined,
      undefined,
    );
    expect(senderSend).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "120363407390920496@g.us",
      "imagem pronta",
      undefined,
    );
    expect(emitted.map((entry) => entry[1].contentType)).toEqual(["media", "text"]);
    expect(emitted[0]?.[1]).toMatchObject({
      status: "delivered",
      target: {
        channel: "whatsapp",
        chatId: "group:120363407390920496",
        canonicalChatId: "chat_whatsapp_source",
      },
      mediaType: "image",
      filename: "generated.png",
    });
  });

  it("delivers response media to the Slack target natively and queues the Slack text part", async () => {
    const { gateway, emitted, senderSend, senderSendMedia } = await createGateway();

    await handleResponse(gateway, "main-slack", {
      _emitId: "emit-media-slack",
      response: "slack pronto",
      content: [
        {
          type: "media",
          media: {
            type: "image",
            filePath: "/tmp/generated-slack.png",
            filename: "generated-slack.png",
            mimeType: "image/png",
            idempotencyKey: "media-key-slack",
          },
        },
        { type: "text", text: "slack pronto" },
      ],
      target: {
        channel: "slack",
        accountId: "slack",
        instanceId: "slack-main",
        chatId: "C123",
        canonicalChatId: "chat_slack_C123",
        threadId: "1710000000.000100",
      },
    });

    expect(senderSend).not.toHaveBeenCalled();
    expect(senderSendMedia).not.toHaveBeenCalled();
    expect(slackMediaSends).toEqual([
      {
        accountId: "slack",
        chatId: "C123",
        threadId: "1710000000.000100",
        filePath: "/tmp/generated-slack.png",
        filename: "generated-slack.png",
        caption: undefined,
      },
    ]);
    expect(publishedJobs).toHaveLength(1);
    expect(publishedJobs[0]).toMatchObject({
      jobId: "runtime:main-slack:emit-media-slack:text:1",
      request: {
        targetChatId: "C123",
        targetThreadId: "1710000000.000100",
        content: { type: "text", text: "slack pronto" },
      },
    });
    expect(emitted.map((entry) => entry[1].contentType)).toEqual(["media", "text"]);
    expect(emitted[0]?.[1]).toMatchObject({
      status: "delivered",
      target: {
        channel: "slack",
        chatId: "C123",
        threadId: "1710000000.000100",
      },
      mediaType: "image",
      filename: "generated-slack.png",
      fileId: "F123",
    });
  });

  it("does not redeliver generated media after a gateway restart", async () => {
    const sessionName = "main-whatsapp-media-dedupe";
    ensureGatewaySession(sessionName);
    dbUpsertInstance({
      name: "main",
      instanceId: "11111111-1111-1111-1111-111111111111",
      channel: "whatsapp",
    });
    configStore.refresh();
    const firstGateway = await createGateway();
    const response: ResponseMessage = {
      _emitId: "media-duplicate-proof",
      response: "",
      content: [
        {
          type: "media",
          media: {
            type: "image",
            filePath: "/tmp/generated-dedupe.png",
            filename: "generated-dedupe.png",
            mimeType: "image/png",
            idempotencyKey: "runtime.generated_media:session:item:hash",
          },
        },
      ],
      target: {
        channel: "whatsapp",
        accountId: "main",
        instanceId: "11111111-1111-1111-1111-111111111111",
        chatId: "5511999999999@s.whatsapp.net",
        canonicalChatId: "chat_whatsapp_dedupe",
      },
    };

    await handleResponse(firstGateway.gateway, sessionName, response);
    const secondGateway = await createGateway();
    await handleResponse(secondGateway.gateway, sessionName, response);

    expect(firstGateway.senderSendMedia).toHaveBeenCalledTimes(1);
    expect(secondGateway.senderSendMedia).not.toHaveBeenCalled();
    expect(secondGateway.emitted.at(-1)?.[1]).toMatchObject({
      status: "dropped",
      reason: "duplicate_media",
      idempotencyKey: "runtime.generated_media:session:item:hash",
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
    const { gateway, emitted, senderSend } = await createGateway();

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

    expect(senderSend).not.toHaveBeenCalled();
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

const WA_UUID = "11111111-1111-1111-1111-111111111111";

function seedNativeSlack(overrides: { credentialConnection?: string | null } = {}): void {
  dbUpsertChannel({
    name: "hana-slack",
    provider: "slack",
    enabled: true,
    ...(overrides.credentialConnection === null
      ? {}
      : { credentialConnection: overrides.credentialConnection ?? "hana-slack-secret" }),
  });
  configStore.refresh();
}

function seedWhatsAppInstance(): void {
  dbUpsertInstance({
    name: "main",
    instanceId: WA_UUID,
    channel: "whatsapp",
  });
  configStore.refresh();
}

type DirectSendTestRequest = {
  channel: string;
  accountId: string;
  to: string;
  text?: string;
  poll?: { name: string; values: string[] };
  replyTopic?: string;
  threadId?: string;
  blocks?: readonly Record<string, unknown>[];
};

type ReactionTestRequest = {
  channel: string;
  accountId: string;
  chatId: string;
  messageId: string;
  emoji: string;
};

type MessageEditTestRequest = {
  channel?: string;
  accountId: string;
  chatId: string;
  messageId: string;
  text: string;
  canonicalMessageId?: string;
  replyTopic?: string;
};

type MessageDeleteTestRequest = {
  channel?: string;
  accountId: string;
  chatId: string;
  messageId: string;
  canonicalMessageId?: string;
  replyTopic?: string;
};

type StickerTestRequest = {
  channel: string;
  accountId: string;
  chatId: string;
  stickerId: string;
  label: string;
  filePath: string;
  mimeType: string;
  filename: string;
  replyTopic?: string;
};

async function handleDirectSend(gateway: unknown, data: DirectSendTestRequest): Promise<void> {
  await (gateway as { handleDirectSendEvent(data: DirectSendTestRequest): Promise<void> }).handleDirectSendEvent(data);
}

async function handleReaction(gateway: unknown, data: ReactionTestRequest): Promise<void> {
  await (gateway as { handleReactionEvent(data: ReactionTestRequest): Promise<void> }).handleReactionEvent(data);
}

async function handleMessageEdit(gateway: unknown, data: MessageEditTestRequest): Promise<void> {
  await (gateway as { handleMessageEditEvent(data: MessageEditTestRequest): Promise<void> }).handleMessageEditEvent(
    data,
  );
}

async function handleMessageDelete(gateway: unknown, data: MessageDeleteTestRequest): Promise<void> {
  await (
    gateway as { handleMessageDeleteEvent(data: MessageDeleteTestRequest): Promise<void> }
  ).handleMessageDeleteEvent(data);
}

async function handleSticker(gateway: unknown, data: StickerTestRequest): Promise<void> {
  await (gateway as { handleStickerSendEvent(data: StickerTestRequest): Promise<void> }).handleStickerSendEvent(data);
}

describe("Gateway native channel account actions", () => {
  beforeEach(() => {
    configStore.refresh();
  });

  it("delivers ravi.outbound.deliver through Slack native send for a channels-created account", async () => {
    seedNativeSlack();
    const { gateway, emitted, senderSend } = await createGateway();

    await handleDirectSend(gateway, {
      channel: "slack",
      accountId: "hana-slack",
      to: "C123",
      text: "hello native",
      replyTopic: "ravi.reply.native-send",
    });

    expect(senderSend).not.toHaveBeenCalled();
    expect(slackTextSends).toEqual([
      {
        accountId: "hana-slack",
        chatId: "C123",
        text: "hello native",
      },
    ]);
    expect(emitted).toEqual([["ravi.reply.native-send", { success: true, messageId: "1784000000.000100" }]]);
  });

  it("forwards Slack Block Kit blocks on native direct send", async () => {
    seedNativeSlack();
    const { gateway, emitted, senderSend } = await createGateway();
    const blocks = [{ type: "actions", elements: [{ type: "button", action_id: "ravi.approval.v1.approve" }] }];

    await handleDirectSend(gateway, {
      channel: "slack",
      accountId: "hana-slack",
      to: "C123",
      text: "Permission requested",
      threadId: "1783999999.000099",
      blocks,
      replyTopic: "ravi.reply.native-blocks",
    });

    expect(senderSend).not.toHaveBeenCalled();
    expect(slackTextSends).toEqual([
      {
        accountId: "hana-slack",
        chatId: "C123",
        text: "Permission requested",
        threadId: "1783999999.000099",
        blocks,
      },
    ]);
    expect(emitted).toEqual([["ravi.reply.native-blocks", { success: true, messageId: "1784000000.000100" }]]);
  });

  it("sends WhatsApp direct sends through the channel sender", async () => {
    seedWhatsAppInstance();
    const { gateway, emitted, senderSend } = await createGateway();

    await handleDirectSend(gateway, {
      channel: "whatsapp",
      accountId: "main",
      to: "group:120363407390920496",
      text: "hello whatsapp",
      replyTopic: "ravi.reply.wa-send",
    });

    expect(slackTextSends).toHaveLength(0);
    expect(senderSend).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "120363407390920496@g.us",
      "hello whatsapp",
      {
        mentions: undefined,
      },
    );
    expect(emitted[0]).toEqual(["ravi.reply.wa-send", { success: true, messageId: "msg-1" }]);
  });

  it("keeps No instance for account when neither an instance nor a native channel exists", async () => {
    const { gateway, emitted, senderSend } = await createGateway();

    await handleDirectSend(gateway, {
      channel: "slack",
      accountId: "ghost",
      to: "C123",
      text: "nope",
      replyTopic: "ravi.reply.missing",
    });

    expect(senderSend).not.toHaveBeenCalled();
    expect(slackTextSends).toHaveLength(0);
    expect(emitted).toEqual([["ravi.reply.missing", { success: false, error: "No instance for account" }]]);
  });

  it("fails honestly when a native Slack account has no credential connection", async () => {
    seedNativeSlack({ credentialConnection: null });
    const { gateway, emitted, senderSend } = await createGateway();

    await handleDirectSend(gateway, {
      channel: "slack",
      accountId: "hana-slack",
      to: "C123",
      text: "hello",
      replyTopic: "ravi.reply.no-cred",
    });

    expect(senderSend).not.toHaveBeenCalled();
    expect(slackTextSends).toHaveLength(0);
    expect(emitted).toEqual([
      [
        "ravi.reply.no-cred",
        { success: false, error: "The Slack channel has no enabled brokered credential connection" },
      ],
    ]);
  });

  it("rejects Slack polls without inventing an instance", async () => {
    seedNativeSlack();
    const { gateway, emitted, senderSend } = await createGateway();

    await handleDirectSend(gateway, {
      channel: "slack",
      accountId: "hana-slack",
      to: "C123",
      poll: { name: "lunch?", values: ["yes", "no"] },
      replyTopic: "ravi.reply.poll",
    });

    expect(senderSend).not.toHaveBeenCalled();
    expect(slackTextSends).toHaveLength(0);
    expect(emitted).toEqual([["ravi.reply.poll", { success: false, error: "Polls are not supported on Slack" }]]);
  });

  it("queues native Slack reactions instead of the instance sender", async () => {
    seedNativeSlack();
    const { gateway, senderSendReaction } = await createGateway();

    await handleReaction(gateway, {
      channel: "slack",
      accountId: "hana-slack",
      chatId: "C123",
      messageId: "1784000000.000100",
      emoji: "👍",
    });

    expect(senderSendReaction).not.toHaveBeenCalled();
    expect(publishedJobs).toHaveLength(1);
    expect(publishedJobs[0]).toMatchObject({
      status: "queued",
      request: {
        channelId: "slack",
        accountId: "hana-slack",
        instanceId: "hana-slack",
        targetChatId: "C123",
        content: {
          type: "chat_action",
          actionId: "message.react",
          providerMessageId: "1784000000.000100",
          emoji: "👍",
          operation: "add",
        },
      },
    });
  });

  it("queues native Slack edit and delete without marking canonical state", async () => {
    seedNativeSlack();
    const { gateway, emitted, senderEditMessage, senderDeleteMessage } = await createGateway();

    await handleMessageEdit(gateway, {
      channel: "slack",
      accountId: "hana-slack",
      chatId: "C123",
      messageId: "1784000000.000100",
      canonicalMessageId: "cm_edit",
      text: "edited",
      replyTopic: "ravi.reply.edit",
    });
    await handleMessageDelete(gateway, {
      channel: "slack",
      accountId: "hana-slack",
      chatId: "C123",
      messageId: "1784000000.000100",
      canonicalMessageId: "cm_delete",
      replyTopic: "ravi.reply.delete",
    });

    expect(senderEditMessage).not.toHaveBeenCalled();
    expect(senderDeleteMessage).not.toHaveBeenCalled();
    expect(publishedJobs).toHaveLength(2);
    expect(publishedJobs[0]?.request.content).toMatchObject({
      actionId: "message.edit",
      providerMessageId: "1784000000.000100",
      text: "edited",
    });
    expect(publishedJobs[1]?.request.content).toMatchObject({
      actionId: "message.delete",
      providerMessageId: "1784000000.000100",
    });
    expect(emitted[0]?.[0]).toBe("ravi.reply.edit");
    expect(emitted[0]?.[1]).toMatchObject({
      success: true,
      queued: true,
      executionMode: "durable",
      messageId: "1784000000.000100",
    });
    expect(emitted[1]?.[0]).toBe("ravi.reply.delete");
    expect(emitted[1]?.[1]).toMatchObject({
      success: true,
      queued: true,
      executionMode: "durable",
      messageId: "1784000000.000100",
    });
  });

  it("sends WhatsApp edit and delete through the channel sender", async () => {
    seedWhatsAppInstance();
    const { gateway, emitted, senderEditMessage, senderDeleteMessage } = await createGateway();

    await handleMessageEdit(gateway, {
      channel: "whatsapp",
      accountId: "main",
      chatId: "group:120363407390920496",
      messageId: "wamid-1",
      text: "edited",
      replyTopic: "ravi.reply.wa-edit",
    });
    await handleMessageDelete(gateway, {
      channel: "whatsapp",
      accountId: "main",
      chatId: "group:120363407390920496",
      messageId: "wamid-1",
      replyTopic: "ravi.reply.wa-delete",
    });

    expect(senderEditMessage).toHaveBeenCalledWith(WA_UUID, "120363407390920496@g.us", "wamid-1", "edited");
    expect(senderDeleteMessage).toHaveBeenCalledWith(WA_UUID, "120363407390920496@g.us", "wamid-1");
    expect(publishedJobs).toHaveLength(0);
    expect(emitted[0]?.[1]).toMatchObject({ success: true, messageId: "wamid-1" });
    expect(emitted[1]?.[1]).toMatchObject({ success: true, messageId: "wamid-1" });
  });

  it("fails Slack stickers honestly without calling the instance sender", async () => {
    seedNativeSlack();
    const { gateway, emitted, senderSendSticker } = await createGateway();

    await handleSticker(gateway, {
      channel: "slack",
      accountId: "hana-slack",
      chatId: "C123",
      stickerId: "wave",
      label: "Wave",
      filePath: "/tmp/wave.webp",
      mimeType: "image/webp",
      filename: "wave.webp",
      replyTopic: "ravi.reply.sticker",
    });

    expect(senderSendSticker).not.toHaveBeenCalled();
    expect(emitted).toEqual([
      ["ravi.reply.sticker", { success: false, error: "Slack does not support Ravi stickers" }],
    ]);
  });
});

const TG_UUID = "22222222-2222-4222-8222-222222222222";
const UNMAPPED_UUID = "99999999-9999-4999-8999-999999999999";

type RpcCall = { instanceId: string; method: string; params: unknown };

/**
 * Gateway over the production per-instance router: WhatsApp goes to a WhatsApp sender whose
 * RPC is faked, everything else to a fake legacy-bridge sender (or none).
 */
async function createRoutedGateway(options: { bridge?: boolean } = {}) {
  const { Gateway } = await import("./gateway.js");
  const { createChannelSenderRouter } = await import("./channels/outbound/router.js");
  const { createWhatsAppClient } = await import("./channels/whatsapp/client.js");
  const { createWhatsAppSender } = await import("./channels/whatsapp/sender.js");

  const rpcCalls: RpcCall[] = [];
  const request = mock(async (instanceId: string, method: string, params: unknown) => {
    rpcCalls.push({ instanceId, method, params });
    return { messageId: `wa-${rpcCalls.length}`, status: "sent" };
  });
  const whatsapp = createWhatsAppSender(
    createWhatsAppClient({ request: request as unknown as typeof requestWhatsAppRpc }),
    { retry: { sleep: async () => {} } },
  );
  const bridge = {
    send: mock(async () => ({ messageId: "bridge-1" })),
    sendTyping: mock(async () => {}),
    sendReaction: mock(async () => {}),
    deleteMessage: mock(async () => {}),
    editMessage: mock(async () => {}),
    sendMedia: mock(async () => ({ messageId: "bridge-media-1" })),
    sendSticker: mock(async () => ({ messageId: "bridge-sticker-1" })),
    markRead: mock(async () => {}),
  };
  const sender = createChannelSenderRouter({ whatsapp, bridge: options.bridge === false ? null : bridge });
  const emitted: Array<[string, Record<string, unknown>]> = [];
  const gateway = new Gateway({
    sender,
    presenceTargets: {
      getActiveTarget: () => undefined,
      clearActiveTarget: async () => {},
      renewActiveTarget: async () => false,
    },
    emitEvent: mock(async (topic: string, payload: Record<string, unknown>) => {
      emitted.push([topic, payload]);
    }),
  });
  const bridgeCalls = () => Object.values(bridge).reduce((total, fn) => total + fn.mock.calls.length, 0);
  return { gateway, emitted, rpcCalls, bridge, bridgeCalls };
}

function seedWhatsAppAccount(options: { bound: boolean; instanceId?: string | null }): void {
  dbUpsertInstance({
    name: "main",
    ...(options.instanceId === null ? {} : { instanceId: options.instanceId ?? WA_UUID }),
    channel: "whatsapp",
  });
  if (options.bound) dbUpsertChannel({ name: "main", provider: "whatsapp", enabled: true });
  configStore.refresh();
}

function seedTelegramAccount(): void {
  dbUpsertInstance({ name: "tg", instanceId: TG_UUID, channel: "telegram" });
  configStore.refresh();
}

describe("Gateway outbound routing (WhatsApp never reaches the legacy bridge)", () => {
  beforeEach(() => {
    configStore.refresh();
  });

  it("sends a bound WhatsApp account through the WhatsApp RPC, not the bridge", async () => {
    seedWhatsAppAccount({ bound: true });
    const { gateway, emitted, rpcCalls, bridgeCalls } = await createRoutedGateway();

    await handleDirectSend(gateway, {
      channel: "whatsapp",
      accountId: "main",
      to: "group:120363407390920496",
      text: "oi",
      replyTopic: "ravi.reply.wa",
    });

    expect(rpcCalls).toEqual([
      { instanceId: WA_UUID, method: "messages.sendText", params: { to: "120363407390920496@g.us", text: "oi" } },
    ]);
    expect(bridgeCalls()).toBe(0);
    expect(emitted).toEqual([["ravi.reply.wa", { success: true, messageId: "wa-1" }]]);
  });

  it("passes the stored sender of a group message with the reaction (survives a runner restart)", async () => {
    seedWhatsAppAccount({ bound: true });
    const group = "120363407390920496@g.us";
    const chat = dbUpsertChat({ channel: "whatsapp", instanceId: WA_UUID, platformChatId: group, chatType: "group" });
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: WA_UUID,
      providerMessageId: "WAMID-IN",
      rawChatId: group,
      rawSenderId: "112233445566778",
      actorType: "contact",
      rawProvenance: {
        source: "whatsapp.message.received",
        rawPayload: { key: { remoteJid: group, id: "WAMID-IN", fromMe: false, participant: "112233445566778@lid" } },
      },
    });
    const { gateway, rpcCalls, bridgeCalls } = await createRoutedGateway();

    await handleReaction(gateway, {
      channel: "whatsapp",
      accountId: "main",
      chatId: "group:120363407390920496",
      messageId: "WAMID-IN",
      emoji: "👍",
    });
    await handleReaction(gateway, {
      channel: "whatsapp",
      accountId: "main",
      chatId: group,
      messageId: "WAMID-UNKNOWN",
      emoji: "👍",
    });

    expect(rpcCalls).toEqual([
      {
        instanceId: WA_UUID,
        method: "messages.react",
        params: { to: group, messageId: "WAMID-IN", emoji: "👍", participant: "112233445566778@lid", fromMe: false },
      },
      { instanceId: WA_UUID, method: "messages.react", params: { to: group, messageId: "WAMID-UNKNOWN", emoji: "👍" } },
    ]);
    expect(bridgeCalls()).toBe(0);
  });

  it("fails an unbound WhatsApp account with WHATSAPP_NOT_BOUND and never calls the bridge", async () => {
    seedWhatsAppAccount({ bound: false });
    const { gateway, emitted, rpcCalls, bridgeCalls } = await createRoutedGateway();

    await handleDirectSend(gateway, {
      channel: "whatsapp-baileys",
      accountId: "main",
      to: "5511999999999@s.whatsapp.net",
      text: "oi",
      replyTopic: "ravi.reply.wa-unbound",
    });
    await handleReaction(gateway, {
      channel: "whatsapp",
      accountId: "main",
      chatId: "5511999999999@s.whatsapp.net",
      messageId: "wamid-1",
      emoji: "👍",
    });
    await handleMessageEdit(gateway, {
      channel: "whatsapp",
      accountId: "main",
      chatId: "5511999999999@s.whatsapp.net",
      messageId: "wamid-1",
      text: "edited",
      replyTopic: "ravi.reply.wa-unbound-edit",
    });

    expect(rpcCalls).toHaveLength(0);
    expect(bridgeCalls()).toBe(0);
    expect(emitted[0]?.[1]).toMatchObject({ success: false, code: "WHATSAPP_NOT_BOUND" });
    expect(String(emitted[0]?.[1].error)).toContain("is not bound to a WhatsApp channel");
    expect(emitted[1]?.[1]).toMatchObject({ success: false, code: "WHATSAPP_NOT_BOUND" });
  });

  it("replies not connected for a WhatsApp account without an instance UUID", async () => {
    seedWhatsAppAccount({ bound: false, instanceId: null });
    const { gateway, emitted, rpcCalls, bridgeCalls } = await createRoutedGateway();

    await handleDirectSend(gateway, {
      channel: "whatsapp",
      accountId: "main",
      to: "5511999999999@s.whatsapp.net",
      text: "oi",
      replyTopic: "ravi.reply.wa-not-bound",
    });

    expect(rpcCalls).toHaveLength(0);
    expect(bridgeCalls()).toBe(0);
    expect(emitted).toEqual([
      [
        "ravi.reply.wa-not-bound",
        { success: false, error: "WhatsApp instance main is not connected: ravi instances connect main" },
      ],
    ]);
  });

  it("sends a Telegram account through the legacy bridge", async () => {
    seedTelegramAccount();
    const { gateway, emitted, rpcCalls, bridge } = await createRoutedGateway();

    await handleDirectSend(gateway, {
      channel: "telegram",
      accountId: "tg",
      to: "12345",
      text: "oi",
      replyTopic: "ravi.reply.tg",
    });

    expect(bridge.send).toHaveBeenCalledWith(TG_UUID, "12345", "oi", { mentions: undefined });
    expect(rpcCalls).toHaveLength(0);
    expect(emitted).toEqual([["ravi.reply.tg", { success: true, messageId: "bridge-1" }]]);
  });

  it("replies LEGACY_BRIDGE_NOT_CONFIGURED for Telegram when no bridge is configured", async () => {
    seedTelegramAccount();
    const { gateway, emitted, rpcCalls } = await createRoutedGateway({ bridge: false });

    await handleDirectSend(gateway, {
      channel: "telegram",
      accountId: "tg",
      to: "12345",
      text: "oi",
      replyTopic: "ravi.reply.tg-no-bridge",
    });

    expect(rpcCalls).toHaveLength(0);
    expect(emitted[0]?.[0]).toBe("ravi.reply.tg-no-bridge");
    expect(emitted[0]?.[1]).toMatchObject({ success: false, code: "LEGACY_BRIDGE_NOT_CONFIGURED" });
    expect(String(emitted[0]?.[1].error)).toContain("legacy channel bridge");
  });

  it("records a response to an unmapped UUID as failed with INSTANCE_NOT_FOUND and never calls the bridge", async () => {
    const { gateway, emitted, rpcCalls, bridgeCalls } = await createRoutedGateway();

    await handleResponse(gateway, "main-whatsapp", {
      _emitId: "emit-unmapped",
      response: "oi",
      target: {
        channel: "whatsapp-baileys",
        accountId: UNMAPPED_UUID,
        chatId: "5511999999999@s.whatsapp.net",
      },
    });
    await handleResponse(gateway, "main-whatsapp", {
      _emitId: "emit-unmapped-media",
      content: [
        {
          type: "media",
          media: { type: "image", filePath: "/tmp/unmapped.png", filename: "unmapped.png", mimeType: "image/png" },
        },
      ],
      target: {
        channel: "whatsapp-baileys",
        accountId: UNMAPPED_UUID,
        chatId: "5511999999999@s.whatsapp.net",
      },
    });
    await sendTyping(
      gateway,
      { channel: "whatsapp-baileys", accountId: UNMAPPED_UUID, chatId: "5511999999999@s.whatsapp.net" },
      true,
      { sessionName: "main-whatsapp", reason: "test" },
    );

    expect(rpcCalls).toHaveLength(0);
    expect(bridgeCalls()).toBe(0);
    const deliveries = emitted.filter(([topic]) => topic === "ravi.session.main-whatsapp.delivery");
    expect(deliveries.map(([, payload]) => payload)).toEqual([
      expect.objectContaining({
        status: "failed",
        reason: "send_error",
        contentType: "text",
        instanceId: UNMAPPED_UUID,
        errorCode: "INSTANCE_NOT_FOUND",
      }),
      expect.objectContaining({
        status: "failed",
        reason: "send_error",
        contentType: "media",
        errorCode: "INSTANCE_NOT_FOUND",
      }),
    ]);
  });

  it("never sends any action for an unmapped UUID through the bridge", async () => {
    const { gateway, emitted, rpcCalls, bridgeCalls } = await createRoutedGateway();
    const chatId = "5511999999999@s.whatsapp.net";

    await handleDirectSend(gateway, {
      channel: "whatsapp",
      accountId: UNMAPPED_UUID,
      to: chatId,
      text: "oi",
      replyTopic: "ravi.reply.unmapped-send",
    });
    await handleReaction(gateway, {
      channel: "whatsapp",
      accountId: UNMAPPED_UUID,
      chatId,
      messageId: "m",
      emoji: "👍",
    });
    await handleMessageEdit(gateway, {
      accountId: UNMAPPED_UUID,
      chatId,
      messageId: "m",
      text: "x",
      replyTopic: "ravi.reply.unmapped-edit",
    });
    await handleMessageDelete(gateway, {
      accountId: UNMAPPED_UUID,
      chatId,
      messageId: "m",
      replyTopic: "ravi.reply.unmapped-delete",
    });
    await handleSticker(gateway, {
      channel: "whatsapp",
      accountId: UNMAPPED_UUID,
      chatId,
      stickerId: "wave",
      label: "Wave",
      filePath: "/tmp/wave.webp",
      mimeType: "image/webp",
      filename: "wave.webp",
      replyTopic: "ravi.reply.unmapped-sticker",
    });

    expect(rpcCalls).toHaveLength(0);
    expect(bridgeCalls()).toBe(0);
    expect(emitted).toEqual([
      ["ravi.reply.unmapped-send", { success: false, error: "No instance for account" }],
      ["ravi.reply.unmapped-edit", { success: false, error: "No instance for account" }],
      ["ravi.reply.unmapped-delete", { success: false, error: "No instance for account" }],
      ["ravi.reply.unmapped-sticker", { success: false, error: "No instance for account" }],
    ]);
  });
});
