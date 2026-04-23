import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { configStore } from "./config-store.js";
import { Gateway, SILENT_TOKEN } from "./gateway.js";
import { dbUpsertInstance } from "./router/router-db.js";
import { getOrCreateSession, updateSessionName } from "./router/sessions.js";
import { listSessionEvents } from "./session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";
import type { ResponseMessage } from "./runtime/message-types.js";

const emitted: Array<[string, Record<string, unknown>]> = [];
const emitMock = mock(async (topic: string, payload: Record<string, unknown>) => {
  emitted.push([topic, payload]);
});

type RuntimePresenceEventData = {
  type?: string;
  status?: string;
  nativeEvent?: string;
  _source?: NonNullable<ResponseMessage["target"]>;
};

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

function makeGateway(
  send: (instanceId: string, chatId: string, text: string, threadId?: string) => Promise<unknown>,
  overrides: {
    getActiveTarget?: () => ResponseMessage["target"] | undefined;
    clearActiveTarget?: () => void;
    renewActiveTarget?: () => Promise<boolean>;
    sendTyping?: (instanceId: string, chatId: string, active?: boolean) => Promise<void>;
  } = {},
) {
  const gateway = new Gateway({
    omniSender: {
      send,
      sendTyping: overrides.sendTyping ?? mock(async () => {}),
      sendReaction: mock(async () => {}),
      sendMedia: mock(async () => ({})),
      markRead: mock(async () => {}),
    } as never,
    omniConsumer: {
      getActiveTarget: overrides.getActiveTarget ?? (() => undefined),
      clearActiveTarget: overrides.clearActiveTarget ?? (() => {}),
      renewActiveTarget: overrides.renewActiveTarget ?? mock(async () => false),
    } as never,
    emitEvent: emitMock,
  });
  (gateway as unknown as { running: boolean }).running = true;
  return gateway;
}

async function handleRuntimePresence(
  gateway: unknown,
  sessionName: string,
  data: RuntimePresenceEventData,
): Promise<void> {
  await (
    gateway as {
      handleRuntimePresenceEvent(sessionName: string, data: RuntimePresenceEventData): Promise<void>;
    }
  ).handleRuntimePresenceEvent(sessionName, data);
}

async function handleResponse(gateway: unknown, sessionName: string, response: ResponseMessage): Promise<void> {
  await (
    gateway as {
      handleResponseEvent(sessionName: string, response: ResponseMessage): Promise<void>;
    }
  ).handleResponseEvent(sessionName, response);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function makeOtherTarget(): NonNullable<ResponseMessage["target"]> {
  return {
    channel: "whatsapp-baileys",
    accountId: "main",
    chatId: "120363000000000000@g.us",
    sourceMessageId: "inbound-other",
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

  it("renews active presence one second after a delivered non-final response", async () => {
    const { sessionName } = seedSession();
    const send = mock(async () => ({ messageId: "outbound-1" }));
    const renewActiveTarget = mock(async () => true);
    const sendTyping = mock(async () => {});
    const target = makeResponse().target!;
    const gateway = makeGateway(send, { getActiveTarget: () => target, renewActiveTarget, sendTyping });

    await handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: target });
    renewActiveTarget.mockClear();
    await handleResponse(gateway, sessionName, makeResponse({ target }));

    expect(renewActiveTarget).not.toHaveBeenCalled();
    await wait(1_050);
    expect(renewActiveTarget).toHaveBeenCalledTimes(1);
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("forces delayed presence renewal from the response target for non-final cross-daemon delivery", async () => {
    const { sessionName } = seedSession();
    const send = mock(async () => ({ messageId: "outbound-1" }));
    const renewActiveTarget = mock(async () => false);
    const sendTyping = mock(async () => {});
    const target = makeResponse().target!;
    const gateway = makeGateway(send, { renewActiveTarget, sendTyping });

    await handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: target });
    renewActiveTarget.mockClear();
    sendTyping.mockClear();
    await handleResponse(gateway, sessionName, makeResponse({ target }));

    expect(sendTyping).not.toHaveBeenCalledWith(expect.any(String), expect.any(String), true);
    await wait(1_050);
    expect(renewActiveTarget).not.toHaveBeenCalled();
    expect(sendTyping).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      true,
    );
  });

  it("does not renew a stale active target after a delivered non-final response", async () => {
    const { sessionName } = seedSession();
    const send = mock(async () => ({ messageId: "outbound-1" }));
    const renewActiveTarget = mock(async () => true);
    const sendTyping = mock(async () => {});
    const target = makeResponse().target!;
    const gateway = makeGateway(send, {
      getActiveTarget: () => makeOtherTarget(),
      renewActiveTarget,
      sendTyping,
    });

    await handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: target });
    renewActiveTarget.mockClear();
    sendTyping.mockClear();
    await handleResponse(gateway, sessionName, makeResponse({ target }));

    await wait(1_050);
    expect(renewActiveTarget).not.toHaveBeenCalled();
    expect(sendTyping).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      true,
    );
    expect(sendTyping).not.toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "120363000000000000@g.us",
      true,
    );
  });

  it("does not renew after a delivered final response when the turn completes within the grace window", async () => {
    const { sessionName } = seedSession();
    const send = mock(async () => ({ messageId: "outbound-1" }));
    const renewActiveTarget = mock(async () => true);
    const sendTyping = mock(async () => {});
    const target = makeResponse().target!;
    const gateway = makeGateway(send, { getActiveTarget: () => target, renewActiveTarget, sendTyping });

    await handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: target });
    renewActiveTarget.mockClear();
    await handleResponse(gateway, sessionName, makeResponse({ target }));
    await handleRuntimePresence(gateway, sessionName, { type: "turn.complete", _source: target });
    await wait(1_050);

    expect(renewActiveTarget).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalledWith(expect.any(String), expect.any(String), true);
  });

  it("keeps presence active on interrupted turns instead of pausing", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const clearActiveTarget = mock(() => {});
    const target = makeResponse().target!;
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        getActiveTarget: () => target,
        renewActiveTarget,
        clearActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "turn.interrupted", _source: target });

    expect(renewActiveTarget).toHaveBeenCalledTimes(1);
    expect(clearActiveTarget).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalledWith(expect.any(String), expect.any(String), false);
  });

  it("forces presence renewal from the event source on cross-daemon interrupts", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => false);
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        renewActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "turn.interrupted", _source: makeResponse().target });

    expect(sendTyping).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      true,
    );
  });

  it("does not renew presence from idle runtime status", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const target = makeResponse().target!;
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        getActiveTarget: () => target,
        renewActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "status", status: "idle", _source: target });

    expect(renewActiveTarget).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("renews active presence on runtime activity before the final response", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const target = makeResponse().target!;
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        getActiveTarget: () => target,
        renewActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "tool.started", _source: target });

    expect(renewActiveTarget).toHaveBeenCalledTimes(1);
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("uses the runtime event source instead of a stale active target", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const target = makeResponse().target!;
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        getActiveTarget: () => makeOtherTarget(),
        renewActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "tool.started", _source: target });

    expect(renewActiveTarget).not.toHaveBeenCalled();
    expect(sendTyping).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      true,
    );
    expect(sendTyping).not.toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "120363000000000000@g.us",
      true,
    );
  });

  it("forces presence renewal from streamed activity when delivery runs outside the active consumer", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => false);
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        renewActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "stream.chunk", _source: makeResponse().target });

    expect(sendTyping).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      true,
    );
  });

  it("throttles repeated runtime activity presence renewals", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const target = makeResponse().target!;
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        getActiveTarget: () => target,
        renewActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "stream.chunk", _source: target });
    await handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: target });

    expect(renewActiveTarget).toHaveBeenCalledTimes(1);
  });

  it("stops presence on completed turns", async () => {
    const { sessionName } = seedSession();
    const clearActiveTarget = mock(() => {});
    const target = makeResponse().target!;
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        getActiveTarget: () => target,
        clearActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "turn.complete", _source: target });

    expect(clearActiveTarget).toHaveBeenCalledTimes(1);
  });

  it("stops presence immediately when the response is silent", async () => {
    const { sessionName } = seedSession();
    const send = mock(async () => ({ messageId: "outbound-1" }));
    const sendTyping = mock(async () => {});
    const target = makeResponse().target!;
    const gateway = makeGateway(send, { sendTyping });

    await handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: target });
    sendTyping.mockClear();
    await handleResponse(gateway, sessionName, makeResponse({ response: SILENT_TOKEN, target }));

    expect(send).not.toHaveBeenCalled();
    expect(sendTyping).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      false,
    );
    expect(emitted).toContainEqual([
      `ravi.session.${sessionName}.delivery`,
      expect.objectContaining({ status: "dropped", reason: "silent" }),
    ]);
  });

  it("does not reactivate presence from late activity after a terminal runtime event", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const clearActiveTarget = mock(() => {});
    const target = makeResponse().target!;
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        getActiveTarget: () => target,
        renewActiveTarget,
        clearActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: target });
    await handleRuntimePresence(gateway, sessionName, { type: "turn.complete", _source: target });
    renewActiveTarget.mockClear();
    sendTyping.mockClear();

    await handleRuntimePresence(gateway, sessionName, { type: "stream.chunk", _source: target });

    expect(renewActiveTarget).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalledWith(expect.any(String), expect.any(String), true);
  });

  it("allows a new turn to start presence after the previous turn reached terminal state", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const clearActiveTarget = mock(() => {});
    const target = makeResponse().target!;
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        getActiveTarget: () => target,
        renewActiveTarget,
        clearActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "turn.complete", _source: target });
    renewActiveTarget.mockClear();
    sendTyping.mockClear();

    await handleRuntimePresence(gateway, sessionName, { type: "turn.started", _source: target });

    expect(renewActiveTarget).toHaveBeenCalledTimes(1);
    expect(sendTyping).not.toHaveBeenCalledWith(expect.any(String), expect.any(String), true);
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
