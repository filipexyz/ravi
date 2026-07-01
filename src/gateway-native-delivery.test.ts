import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Gateway } from "./gateway.js";
import type { NativeTextDelivery } from "./channels/native/types.js";
import { getOrCreateSession } from "./router/index.js";
import { dbFindChatMessage, dbUpsertChat } from "./router/router-db.js";
import type { ResponseMessage } from "./runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gateway-native-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function handleResponse(gateway: unknown, sessionName: string, response: ResponseMessage): Promise<void> {
  await (
    gateway as {
      handleResponseEvent(sessionName: string, response: ResponseMessage): Promise<void>;
    }
  ).handleResponseEvent(sessionName, response);
}

describe("Gateway native text delivery", () => {
  it("delivers Slack responses through native delivery instead of Omni", async () => {
    const omniSend = mock(async () => ({ messageId: "omni-1" }));
    const deliveredText: string[] = [];
    const chat = dbUpsertChat({
      channel: "slack",
      instanceId: "slack-main",
      platformChatId: "C123",
      chatType: "group",
      title: "C123",
      rawProvenance: { source: "test" },
      seenAt: Date.now(),
    });
    getOrCreateSession("session:main-slack", "dev", "/tmp/ravi-dev", {
      name: "main-slack",
      channel: "slack",
      accountId: "slack-main",
      groupId: "C123",
    });
    const nativeDelivery: NativeTextDelivery = {
      channelId: "slack",
      supports: (target) => target.channel === "slack",
      deliverText: async (request) => {
        deliveredText.push(request.text);
        return {
          provider: "slack",
          messageId: "1710000000.000200",
          platformMessageId: "1710000000.000200",
        };
      },
    };
    const emitted: Array<[string, Record<string, unknown>]> = [];
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
      nativeTextDeliveries: [nativeDelivery],
      emitEvent: mock(async (topic: string, payload: Record<string, unknown>) => {
        emitted.push([topic, payload]);
      }),
    });

    await handleResponse(gateway, "main-slack", {
      _emitId: "emit-1",
      response: "oi slack",
      target: {
        channel: "slack",
        accountId: "slack",
        instanceId: "slack-main",
        chatId: "C123",
        canonicalChatId: chat.id,
        threadId: "1710000000.000100",
      },
    });

    expect(omniSend).not.toHaveBeenCalled();
    expect(deliveredText).toEqual(["oi slack"]);
    expect(emitted[0]?.[0]).toBe("ravi.session.main-slack.delivery");
    expect(emitted[0]?.[1]).toMatchObject({
      status: "delivered",
      provider: "slack",
      messageId: "1710000000.000200",
      platformMessageId: "1710000000.000200",
    });
    const saved = dbFindChatMessage({
      channel: "slack",
      instanceId: "slack-main",
      chatId: chat.id,
      providerMessageId: "1710000000.000200",
    });
    expect(saved).toMatchObject({
      chatId: chat.id,
      channel: "slack",
      instanceId: "slack-main",
      providerMessageId: "1710000000.000200",
      actorType: "agent",
      agentId: "dev",
      messageType: "text",
    });
    expect(saved?.content).toEqual({ type: "text", text: "oi slack" });
  });
});
