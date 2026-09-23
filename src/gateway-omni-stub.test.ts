import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { configStore } from "./config-store.js";
import { Gateway } from "./gateway.js";
import { createStubOmniConsumer } from "./omni/stub-consumer.js";
import { dbUpsertInstance } from "./router/router-db.js";
import { getOrCreateSession, updateSessionName } from "./router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";
import type { ResponseMessage } from "./runtime/message-types.js";

type RuntimePresenceEventData = {
  type?: string;
  status?: string;
  nativeEvent?: string;
  _source?: NonNullable<ResponseMessage["target"]>;
  _replyTarget?: ResponseMessage["target"];
};

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gateway-omni-stub-");
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

function makeTarget(): NonNullable<ResponseMessage["target"]> {
  return {
    channel: "whatsapp-baileys",
    accountId: "main",
    chatId: "5511999999999@s.whatsapp.net",
    sourceMessageId: "inbound-1",
  };
}

function makeGateway(omniConsumer: object, sendTyping = mock(async () => {})) {
  const gateway = new Gateway({
    omniSender: {
      send: mock(async () => ({})),
      sendTyping,
      sendReaction: mock(async () => {}),
      deleteMessage: mock(async () => {}),
      editMessage: mock(async () => {}),
      sendMedia: mock(async () => ({})),
      markRead: mock(async () => {}),
    } as never,
    omniConsumer: omniConsumer as never,
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

/** Pre-fix daemon stub: no renewActiveTarget. */
function makeLegacyIncompleteStub() {
  return {
    start: async () => {},
    stop: async () => {},
    getActiveTarget: () => undefined,
    clearActiveTarget: () => {},
  };
}

describe("Gateway presence without Omni", () => {
  it("completes source-less presence renew with the daemon stub consumer", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const gateway = makeGateway(createStubOmniConsumer(), sendTyping);

    await expect(handleRuntimePresence(gateway, sessionName, { type: "assistant.message" })).resolves.toBeUndefined();
    await expect(handleRuntimePresence(gateway, sessionName, { type: "stream.chunk" })).resolves.toBeUndefined();
    await expect(handleRuntimePresence(gateway, sessionName, { type: "turn.interrupted" })).resolves.toBeUndefined();

    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("degrades sourced presence to sendTyping when the stub has no active target", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const target = makeTarget();
    const gateway = makeGateway(createStubOmniConsumer(), sendTyping);

    await expect(
      handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: target }),
    ).resolves.toBeUndefined();

    expect(sendTyping).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      true,
    );

    await expect(
      handleRuntimePresence(gateway, sessionName, { type: "turn.complete", _source: target }),
    ).resolves.toBeUndefined();
    expect(sendTyping).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      false,
    );
  });

  it("does not throw on source-less presence when renewActiveTarget is missing", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const gateway = makeGateway(makeLegacyIncompleteStub(), sendTyping);

    await expect(handleRuntimePresence(gateway, sessionName, { type: "assistant.message" })).resolves.toBeUndefined();
    await expect(handleRuntimePresence(gateway, sessionName, { type: "turn.interrupted" })).resolves.toBeUndefined();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("does not throw when renewActiveTarget exists but throws", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const gateway = makeGateway(
      {
        getActiveTarget: () => undefined,
        clearActiveTarget: async () => {},
        renewActiveTarget: async () => {
          throw new Error("omni down");
        },
      },
      sendTyping,
    );

    await expect(handleRuntimePresence(gateway, sessionName, { type: "assistant.message" })).resolves.toBeUndefined();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("keeps real OmniConsumer renew behavior when the active target matches", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const target = makeTarget();
    const gateway = makeGateway(
      {
        getActiveTarget: () => target,
        clearActiveTarget: mock(async () => {}),
        renewActiveTarget,
      },
      sendTyping,
    );

    await handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: target });

    expect(renewActiveTarget).toHaveBeenCalledTimes(1);
    expect(sendTyping).not.toHaveBeenCalled();
  });
});
