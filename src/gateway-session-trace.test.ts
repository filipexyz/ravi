import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { configStore } from "./config-store.js";
import { Gateway } from "./gateway.js";
import { dbUpsertInstance } from "./router/router-db.js";
import { getOrCreateSession, updateSessionName } from "./router/sessions.js";
import { listSessionEvents } from "./session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";
import type { ResponseMessage } from "./runtime/message-types.js";

const emitted: Array<[string, Record<string, unknown>]> = [];
const emitMock = mock(async (topic: string, payload: Record<string, unknown>) => {
  emitted.push([topic, payload]);
});

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gateway-trace-test-");
  emitted.length = 0;
  emitMock.mockClear();
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function seedSession() {
  const sessionKey = "agent:main:whatsapp:dm:5511999999999";
  const sessionName = "main-dm-5511999999999";
  dbUpsertInstance({
    name: "main",
    instanceId: "11111111-1111-1111-1111-111111111111",
    channel: "whatsapp",
  });
  configStore.refresh();
  getOrCreateSession(sessionKey, "main", "/tmp/ravi-agent");
  updateSessionName(sessionKey, sessionName);
  return { sessionKey, sessionName };
}

function makeGateway(send: (instanceId: string, chatId: string, text: string, threadId?: string) => Promise<unknown>) {
  return new Gateway({
    omniSender: {
      send,
      sendTyping: mock(async () => {}),
      sendReaction: mock(async () => {}),
      sendMedia: mock(async () => ({})),
      markRead: mock(async () => {}),
    } as never,
    omniConsumer: {
      getActiveTarget: () => undefined,
      clearActiveTarget: () => {},
    } as never,
    emitEvent: emitMock,
  });
}

async function handleResponse(gateway: unknown, sessionName: string, response: ResponseMessage): Promise<void> {
  await (
    gateway as {
      handleResponseEvent(sessionName: string, response: ResponseMessage): Promise<void>;
    }
  ).handleResponseEvent(sessionName, response);
}

function makeResponse(overrides: Partial<ResponseMessage> = {}): ResponseMessage {
  return {
    response: "hello back",
    target: {
      channel: "whatsapp-baileys",
      accountId: "main",
      chatId: "5511999999999@s.whatsapp.net",
      sourceMessageId: "inbound-1",
    },
    _emitId: "emit-1",
    ...overrides,
  };
}

describe("Gateway session trace instrumentation", () => {
  it("records response.emitted and delivery.delivered for successful channel delivery", async () => {
    const { sessionKey, sessionName } = seedSession();
    const send = mock(async () => ({ messageId: "outbound-1" }));
    const gateway = makeGateway(send);

    await handleResponse(gateway, sessionName, makeResponse());

    expect(send).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      "hello back",
      undefined,
    );
    expect(emitted).toContainEqual([
      `ravi.session.${sessionName}.delivery`,
      expect.objectContaining({ status: "delivered", messageId: "outbound-1", emitId: "emit-1" }),
    ]);

    const events = listSessionEvents(sessionKey);
    expect(events.map((event) => event.eventType)).toEqual(["response.emitted", "delivery.delivered"]);
    expect(events[0]?.messageId).toBe("inbound-1");
    expect(events[1]?.messageId).toBe("inbound-1");
    expect(events[1]?.payloadJson).toMatchObject({ deliveryMessageId: "outbound-1", status: "delivered" });
  });

  it("records delivery.dropped when a response has no target", async () => {
    const { sessionKey, sessionName } = seedSession();
    const send = mock(async () => ({ messageId: "outbound-1" }));
    const gateway = makeGateway(send);

    await handleResponse(gateway, sessionName, makeResponse({ target: undefined }));

    expect(send).not.toHaveBeenCalled();
    expect(emitted).toContainEqual([
      `ravi.session.${sessionName}.delivery`,
      expect.objectContaining({ status: "dropped", reason: "missing_target" }),
    ]);
    expect(listSessionEvents(sessionKey).map((event) => event.eventType)).toEqual([
      "response.emitted",
      "delivery.dropped",
    ]);
  });

  it("records delivery.failed when omni send throws", async () => {
    const { sessionKey, sessionName } = seedSession();
    const send = mock(async () => {
      throw new Error("send exploded");
    });
    const gateway = makeGateway(send);

    await handleResponse(gateway, sessionName, makeResponse());

    expect(emitted).toContainEqual([
      `ravi.session.${sessionName}.delivery`,
      expect.objectContaining({ status: "failed", reason: "send_error", error: "send exploded" }),
    ]);

    const events = listSessionEvents(sessionKey);
    expect(events.map((event) => event.eventType)).toEqual(["response.emitted", "delivery.failed"]);
    expect(events[1]?.messageId).toBe("inbound-1");
    expect(events[1]?.error).toBe("send exploded");
  });
});
