import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getOrCreateSession, updateSessionName } from "../router/sessions.js";
import { dbBindSessionToChat, dbUpsertChat } from "../router/router-db.js";
import { listSessionEvents } from "./session-trace-db.js";
import {
  normalizeSessionTraceSource,
  recordChannelMessageReceivedTrace,
  recordDeliveryTrace,
  recordPromptPublishedTrace,
  recordResponseEmittedTrace,
  recordRouteResolvedTrace,
} from "./channel-trace.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-channel-trace-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("channel session trace", () => {
  it("records an inbound channel message through prompt, response, and delivery outcomes", () => {
    const sessionKey = "agent:main:whatsapp:dm:5511999999999";
    const sessionName = "main-dm-5511999999999";
    getOrCreateSession(sessionKey, "main", "/tmp/ravi-agent");
    updateSessionName(sessionKey, sessionName);

    const source = normalizeSessionTraceSource({
      source: {
        channel: "whatsapp-baileys",
        accountId: "main",
        chatId: "5511999999999@s.whatsapp.net",
        sourceMessageId: "inbound-1",
      },
      context: {
        messageId: "context-message-id",
      },
    });

    recordChannelMessageReceivedTrace({
      sessionKey,
      sessionName,
      agentId: "main",
      timestamp: 10,
      source,
      payloadJson: { contentType: "text" },
      preview: "hello",
    });
    recordRouteResolvedTrace({
      sessionKey,
      sessionName,
      agentId: "main",
      timestamp: 11,
      source,
      payloadJson: { route: { pattern: "*" } },
    });
    recordPromptPublishedTrace({
      sessionName,
      timestamp: 12,
      payload: {
        prompt: "hello",
        source: {
          channel: "whatsapp-baileys",
          accountId: "main",
          chatId: "5511999999999@s.whatsapp.net",
          sourceMessageId: "inbound-1",
        },
        deliveryBarrier: "after_tool",
      },
    });
    const response = {
      response: "hi",
      target: {
        channel: "whatsapp-baileys",
        accountId: "main",
        chatId: "5511999999999@s.whatsapp.net",
        sourceMessageId: "inbound-1",
      },
      _emitId: "emit-1",
    };
    recordResponseEmittedTrace({ sessionName, response, timestamp: 13 });
    recordDeliveryTrace({
      sessionName,
      response,
      timestamp: 14,
      delivery: { status: "delivered", messageId: "outbound-1", target: response.target, emitId: "emit-1" },
    });
    recordDeliveryTrace({
      sessionName,
      response,
      timestamp: 15,
      delivery: { status: "dropped", reason: "silent", target: response.target, emitId: "emit-1" },
    });
    recordDeliveryTrace({
      sessionName,
      response,
      timestamp: 16,
      delivery: {
        status: "failed",
        reason: "send_error",
        error: "network down",
        target: response.target,
        emitId: "emit-1",
      },
    });

    const events = listSessionEvents(sessionKey);
    expect(events.map((event) => event.eventType)).toEqual([
      "channel.message.received",
      "route.resolved",
      "prompt.published",
      "response.emitted",
      "delivery.delivered",
      "delivery.dropped",
      "delivery.failed",
    ]);

    for (const event of events.slice(0, 3)) {
      expect(event.sourceChannel).toBe("whatsapp");
      expect(event.sourceAccountId).toBe("main");
      expect(event.sourceChatId).toBe("5511999999999@s.whatsapp.net");
      expect(event.canonicalChatId).toBeNull();
      expect(event.actorType).toBeNull();
      expect(event.messageId).toBe("inbound-1");
    }
    for (const event of events.slice(3)) {
      expect(event.sourceChannel).toBe("whatsapp");
      expect(event.sourceAccountId).toBe("main");
      expect(event.sourceChatId).toBe("5511999999999@s.whatsapp.net");
      expect(event.canonicalChatId).toBeNull();
      expect(event.actorType).toBe("agent");
      expect(event.actorAgentId).toBe("main");
      expect(event.contactId).toBeNull();
      expect(event.messageId).toBe("inbound-1");
    }

    const delivered = events.find((event) => event.eventType === "delivery.delivered");
    expect(delivered?.payloadJson).toMatchObject({
      deliveryMessageId: "outbound-1",
      emitId: "emit-1",
      status: "delivered",
    });
    const failed = events.find((event) => event.eventType === "delivery.failed");
    expect(failed?.error).toBe("network down");
  });

  it("uses session chat binding as an explicit legacy fallback for response traces", () => {
    const sessionKey = "agent:main:legacy-target";
    const sessionName = "main-legacy-target";
    getOrCreateSession(sessionKey, "main", "/tmp/ravi-agent");
    updateSessionName(sessionKey, sessionName);
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "11111111-1111-1111-1111-111111111111",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
    });
    dbBindSessionToChat({
      sessionKey,
      chatId: chat.id,
      agentId: "main",
      bindingReason: "test_legacy_response_fallback",
    });

    recordResponseEmittedTrace({
      sessionName,
      response: {
        response: "hi",
        target: {
          channel: "whatsapp-baileys",
          accountId: "main",
          chatId: "5511999999999@s.whatsapp.net",
        },
        _emitId: "emit-legacy",
      },
      timestamp: 20,
    });

    const event = listSessionEvents(sessionKey)[0];
    expect(event).toMatchObject({
      eventType: "response.emitted",
      sourceChatId: "5511999999999@s.whatsapp.net",
      canonicalChatId: chat.id,
      actorType: "agent",
      actorAgentId: "main",
      contactId: null,
    });
  });
});
