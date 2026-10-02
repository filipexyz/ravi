import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { configStore } from "./config-store.js";
import { createNoopPresenceTargets } from "./channels/inbound/presence-targets.js";
import type { ChannelPresenceTargets } from "./channels/inbound/types.js";
import type { ChannelMessageSender } from "./channels/outbound/sender.js";
import { Gateway } from "./gateway.js";
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
  stateDir = await createIsolatedRaviState("ravi-gateway-headless-presence-");
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

/** Fake transport-neutral sender: only typing is observed. */
function fakeSender(sendTyping: ChannelMessageSender["sendTyping"]): ChannelMessageSender {
  return {
    send: mock(async () => ({})),
    sendTyping,
    sendReaction: mock(async () => {}),
    deleteMessage: mock(async () => {}),
    editMessage: mock(async () => {}),
    sendMedia: mock(async () => ({})),
    sendSticker: mock(async () => ({})),
    markRead: mock(async () => {}),
  };
}

function makeGateway(presenceTargets: ChannelPresenceTargets, sendTyping = mock(async () => {})) {
  const gateway = new Gateway({
    sender: fakeSender(sendTyping),
    presenceTargets,
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

/** An incomplete presence surface (no renewActiveTarget), as an older headless daemon stub was. */
function makeIncompletePresenceTargets(): ChannelPresenceTargets {
  const partial = {
    getActiveTarget: () => undefined,
    clearActiveTarget: async () => {},
  };
  return partial as unknown as ChannelPresenceTargets;
}

describe("Gateway presence with headless presence targets", () => {
  it("completes source-less presence renew with the noop presence targets", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const gateway = makeGateway(createNoopPresenceTargets(), sendTyping);

    await expect(handleRuntimePresence(gateway, sessionName, { type: "assistant.message" })).resolves.toBeUndefined();
    await expect(handleRuntimePresence(gateway, sessionName, { type: "stream.chunk" })).resolves.toBeUndefined();
    await expect(handleRuntimePresence(gateway, sessionName, { type: "turn.interrupted" })).resolves.toBeUndefined();

    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("degrades sourced presence to sendTyping when there is no active target", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const target = makeTarget();
    const gateway = makeGateway(createNoopPresenceTargets(), sendTyping);

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
    const gateway = makeGateway(makeIncompletePresenceTargets(), sendTyping);

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
          throw new Error("presence store down");
        },
      },
      sendTyping,
    );

    await expect(handleRuntimePresence(gateway, sessionName, { type: "assistant.message" })).resolves.toBeUndefined();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("degrades to sendTyping when getActiveTarget and clearActiveTarget throw", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const target = makeTarget();
    const clearActiveTarget = mock(async () => {
      throw new Error("presence store down");
    });
    const gateway = makeGateway(
      {
        getActiveTarget: () => {
          throw new Error("presence store down");
        },
        clearActiveTarget,
        renewActiveTarget: async () => true,
      },
      sendTyping,
    );

    await expect(
      handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: target }),
    ).resolves.toBeUndefined();
    await expect(
      handleRuntimePresence(gateway, sessionName, { type: "turn.complete", _source: target }),
    ).resolves.toBeUndefined();

    expect(sendTyping).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      true,
    );
    expect(sendTyping).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
      false,
    );
  });

  it("sends typing only for a sourced event with the noop presence targets", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const gateway = makeGateway(createNoopPresenceTargets(), sendTyping);

    await expect(handleRuntimePresence(gateway, sessionName, { type: "assistant.message" })).resolves.toBeUndefined();
    await expect(
      handleRuntimePresence(gateway, sessionName, { type: "assistant.message", _source: makeTarget() }),
    ).resolves.toBeUndefined();
    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it("renews the inbound active target instead of sending typing when it matches", async () => {
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
