import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { configStore } from "./config-store.js";
import { createContact, getContact, upsertAgentPlatformIdentity } from "./contacts.js";
import { Gateway, SILENT_TOKEN } from "./gateway.js";
import {
  dbBindSessionToChat,
  dbFindChatMessage,
  dbGetChatMessage,
  dbGetMessageMeta,
  dbSaveMessageMeta,
  dbUpsertChat,
  dbUpsertChatMessage,
  dbUpsertInstance,
} from "./router/router-db.js";
import { getOrCreateSession, updateSessionName } from "./router/sessions.js";
import { listSessionEvents } from "./session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";
import type { ResponseMessage } from "./runtime/message-types.js";
import { upsertOmniGroupMetadata } from "./omni/group-metadata-cache.js";
import type { OmniUserMention } from "./omni/mentions.js";

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

type GatewaySendOptions = string | { threadId?: string; mentions?: OmniUserMention[] };
type GatewaySend = (
  instanceId: string,
  chatId: string,
  text: string,
  optionsOrThreadId?: GatewaySendOptions,
) => Promise<unknown>;
type MessageDeleteEventData = {
  channel?: string;
  accountId: string;
  chatId: string;
  messageId: string;
  canonicalMessageId?: string;
  replyTopic?: string;
};
type MessageEditEventData = MessageDeleteEventData & {
  text: string;
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
  send: GatewaySend,
  overrides: {
    getActiveTarget?: () => ResponseMessage["target"] | undefined;
    clearActiveTarget?: () => void | Promise<void>;
    renewActiveTarget?: () => Promise<boolean>;
    sendTyping?: (instanceId: string, chatId: string, active?: boolean) => Promise<void>;
    deleteMessage?: (instanceId: string, chatId: string, messageId: string) => Promise<void>;
    editMessage?: (instanceId: string, chatId: string, messageId: string, text: string) => Promise<void>;
  } = {},
) {
  const gateway = new Gateway({
    omniSender: {
      send,
      sendTyping: overrides.sendTyping ?? mock(async () => {}),
      sendReaction: mock(async () => {}),
      deleteMessage: overrides.deleteMessage ?? mock(async () => {}),
      editMessage: overrides.editMessage ?? mock(async () => {}),
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

async function handleMessageDelete(gateway: unknown, data: MessageDeleteEventData): Promise<void> {
  await (
    gateway as {
      handleMessageDeleteEvent(data: MessageDeleteEventData): Promise<void>;
    }
  ).handleMessageDeleteEvent(data);
}

async function handleMessageEdit(gateway: unknown, data: MessageEditEventData): Promise<void> {
  await (
    gateway as {
      handleMessageEditEvent(data: MessageEditEventData): Promise<void>;
    }
  ).handleMessageEditEvent(data);
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

function makeInstanceAliasTarget(): NonNullable<ResponseMessage["target"]> {
  return {
    channel: "whatsapp",
    accountId: "11111111-1111-1111-1111-111111111111",
    instanceId: "11111111-1111-1111-1111-111111111111",
    chatId: "5511999999999@s.whatsapp.net",
    sourceMessageId: "inbound-instance-alias",
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

  it("enriches gateway traces from canonical chat binding and message actor metadata", async () => {
    const { sessionKey, sessionName } = seedSession();
    const agentIdentity = upsertAgentPlatformIdentity({
      agentId: "main",
      channel: "whatsapp",
      instanceId: "11111111-1111-1111-1111-111111111111",
      platformUserId: "5511000000000@s.whatsapp.net",
      confidence: 1,
      linkedBy: "test",
      linkReason: "gateway_trace_test",
    });
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
      bindingReason: "test_canonical_trace",
    });
    dbSaveMessageMeta("inbound-1", "5511999999999@s.whatsapp.net", {
      canonicalChatId: chat.id,
      actorType: "contact",
      contactId: "contact_1",
      rawSenderId: "5511999999999@s.whatsapp.net",
      normalizedSenderId: "5511999999999",
      identityProvenance: { source: "test" },
    });
    const gateway = makeGateway(mock(async () => ({ messageId: "outbound-1" })));

    await handleResponse(gateway, sessionName, makeResponse());

    const events = listSessionEvents(sessionKey);
    expect(events.map((event) => event.eventType)).toEqual(["response.emitted", "delivery.delivered"]);
    for (const event of events) {
      expect(event.sourceChatId).toBe("5511999999999@s.whatsapp.net");
      expect(event.canonicalChatId).toBe(chat.id);
      expect(event.actorType).toBe("agent");
      expect(event.actorAgentId).toBe("main");
      expect(event.contactId).toBeNull();
      expect(event.platformIdentityId).toBe(agentIdentity.id);
      expect(event.rawSenderId).toBe("5511000000000@s.whatsapp.net");
      expect(event.normalizedSenderId).toBe("5511000000000");
    }
    expect(dbGetMessageMeta("outbound-1")).toMatchObject({
      canonicalChatId: chat.id,
      actorType: "agent",
      agentId: "main",
      platformIdentityId: agentIdentity.id,
    });
    expect(
      dbFindChatMessage({
        channel: "whatsapp-baileys",
        instanceId: "11111111-1111-1111-1111-111111111111",
        chatId: chat.id,
        providerMessageId: "outbound-1",
      }),
    ).toMatchObject({
      chatId: chat.id,
      actorType: "agent",
      agentId: "main",
      platformIdentityId: agentIdentity.id,
      providerMessageId: "outbound-1",
      content: { type: "text", text: "hello back" },
    });
  });

  it("deletes an own outbound message through omni and marks the canonical message row", async () => {
    const { sessionKey } = seedSession();
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "11111111-1111-1111-1111-111111111111",
      platformChatId: "120363000000000000@g.us",
      chatType: "group",
    });
    dbBindSessionToChat({
      sessionKey,
      chatId: chat.id,
      agentId: "main",
      bindingReason: "test_delete_own_outbound",
    });
    const own = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "11111111-1111-1111-1111-111111111111",
      providerMessageId: "outbound-delete-1",
      rawChatId: "120363000000000000@g.us",
      rawSenderId: "5511000000000@s.whatsapp.net",
      normalizedSenderId: "5511000000000",
      actorType: "agent",
      agentId: "main",
      messageType: "text",
      content: { type: "text", text: "mensagem errada" },
    }).message;
    const deleteMessage = mock(async () => {});
    const gateway = makeGateway(
      mock(async () => ({ messageId: "unused" })),
      { deleteMessage },
    );

    await handleMessageDelete(gateway, {
      channel: "whatsapp",
      accountId: "main",
      chatId: "group:120363000000000000",
      messageId: "outbound-delete-1",
      canonicalMessageId: own.id,
      replyTopic: "ravi._reply.test-delete",
    });

    expect(deleteMessage).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "120363000000000000@g.us",
      "outbound-delete-1",
    );
    expect(dbGetChatMessage(own.id)?.deletedAt).toBeTruthy();
    expect(emitted).toContainEqual([
      "ravi._reply.test-delete",
      expect.objectContaining({
        success: true,
        messageId: "outbound-delete-1",
        canonicalMessageId: own.id,
      }),
    ]);
  });

  it("edits an own outbound message through omni and updates the canonical message row", async () => {
    const { sessionKey } = seedSession();
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "11111111-1111-1111-1111-111111111111",
      platformChatId: "120363000000000000@g.us",
      chatType: "group",
    });
    dbBindSessionToChat({
      sessionKey,
      chatId: chat.id,
      agentId: "main",
      bindingReason: "test_edit_own_outbound",
    });
    const own = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "11111111-1111-1111-1111-111111111111",
      providerMessageId: "outbound-edit-1",
      rawChatId: "120363000000000000@g.us",
      rawSenderId: "5511000000000@s.whatsapp.net",
      normalizedSenderId: "5511000000000",
      actorType: "agent",
      agentId: "main",
      messageType: "text",
      content: { type: "text", text: "mensagem errada" },
    }).message;
    const editMessage = mock(async () => {});
    const gateway = makeGateway(
      mock(async () => ({ messageId: "unused" })),
      { editMessage },
    );

    await handleMessageEdit(gateway, {
      channel: "whatsapp",
      accountId: "main",
      chatId: "group:120363000000000000",
      messageId: "outbound-edit-1",
      canonicalMessageId: own.id,
      text: "mensagem corrigida",
      replyTopic: "ravi._reply.test-edit",
    });

    expect(editMessage).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "120363000000000000@g.us",
      "outbound-edit-1",
      "mensagem corrigida",
    );
    expect(dbGetChatMessage(own.id)?.content).toMatchObject({ text: "mensagem corrigida" });
    expect(dbGetChatMessage(own.id)?.editedAt).toBeTruthy();
    expect(emitted).toContainEqual([
      "ravi._reply.test-edit",
      expect.objectContaining({
        success: true,
        messageId: "outbound-edit-1",
        canonicalMessageId: own.id,
      }),
    ]);
  });

  it("updates outbound interaction projection only for resolved DM contact targets", async () => {
    const { sessionKey, sessionName } = seedSession();
    const contact = createContact({
      phone: "5511999999999",
      name: "Luis",
      status: "allowed",
      source: "manual",
    });
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
      bindingReason: "test_dm_outbound_projection",
    });
    const gateway = makeGateway(mock(async () => ({ messageId: "outbound-dm-1" })));

    await handleResponse(
      gateway,
      sessionName,
      makeResponse({
        target: {
          ...makeResponse().target!,
          canonicalChatId: chat.id,
          contactId: contact.id,
        },
      }),
    );

    const updated = getContact(contact.id);
    expect(updated?.last_outbound_at).toBeTruthy();
    expect(updated?.interaction_count).toBe(1);
  });

  it("does not update outbound contact projection for group chat replies", async () => {
    const { sessionKey, sessionName } = seedSession();
    const contact = createContact({
      phone: "5511888888888",
      name: "Group Sender",
      status: "allowed",
      source: "manual",
    });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "11111111-1111-1111-1111-111111111111",
      platformChatId: "120363000000000000@g.us",
      chatType: "group",
    });
    dbBindSessionToChat({
      sessionKey,
      chatId: chat.id,
      agentId: "main",
      bindingReason: "test_group_outbound_projection",
    });
    const gateway = makeGateway(mock(async () => ({ messageId: "outbound-group-1" })));

    await handleResponse(
      gateway,
      sessionName,
      makeResponse({
        target: {
          channel: "whatsapp-baileys",
          accountId: "main",
          chatId: "120363000000000000@g.us",
          canonicalChatId: chat.id,
          contactId: contact.id,
          sourceMessageId: "inbound-group-1",
        },
      }),
    );

    const updated = getContact(contact.id);
    expect(updated?.last_outbound_at).toBeNull();
    expect(updated?.interaction_count).toBe(0);
  });

  it("resolves exact outbound group mentions from group participants", async () => {
    const oldApiUrl = process.env.OMNI_API_URL;
    const oldApiKey = process.env.OMNI_API_KEY;
    process.env.OMNI_API_URL = "http://omni.local";
    process.env.OMNI_API_KEY = "test-key";

    try {
      const { sessionName } = seedSession();
      const groupJid = "120363000000000000@g.us";
      upsertOmniGroupMetadata({
        accountId: "main",
        instanceId: "11111111-1111-1111-1111-111111111111",
        chatId: groupJid,
        channel: "whatsapp",
        name: "Ravi - Dev",
        participants: [
          { platformUserId: "91015272759397@lid", displayName: "Ravi Bot" },
          { platformUserId: "5511947879044@s.whatsapp.net", displayName: "Luís Filipe" },
        ],
        fetchedAt: Date.now(),
      });
      const send = mock(async (..._args: Parameters<GatewaySend>) => ({ messageId: "outbound-mentioned" }));
      const gateway = makeGateway(send);

      await handleResponse(
        gateway,
        sessionName,
        makeResponse({
          response: "oi @Luis @RaviBot @Luisalgo @12345",
          target: {
            channel: "whatsapp-baileys",
            accountId: "main",
            chatId: groupJid,
            sourceMessageId: "inbound-group",
          },
        }),
      );

      expect(send).toHaveBeenCalledTimes(1);
      const [, , text, options] = send.mock.calls[0] as Parameters<GatewaySend>;
      expect(text).toBe("oi @5511947879044 @91015272759397 @Luisalgo @12345");
      expect(options).toMatchObject({
        mentions: expect.arrayContaining([
          { id: "5511947879044@s.whatsapp.net", type: "user" },
          { id: "91015272759397@lid", type: "user" },
        ]),
      });
    } finally {
      if (oldApiUrl === undefined) delete process.env.OMNI_API_URL;
      else process.env.OMNI_API_URL = oldApiUrl;
      if (oldApiKey === undefined) delete process.env.OMNI_API_KEY;
      else process.env.OMNI_API_KEY = oldApiKey;
    }
  });

  it("uses native LID mentions for inline phone placeholders when group metadata maps phone to LID", async () => {
    const oldApiUrl = process.env.OMNI_API_URL;
    const oldApiKey = process.env.OMNI_API_KEY;
    process.env.OMNI_API_URL = "http://omni.local";
    process.env.OMNI_API_KEY = "test-key";

    try {
      const { sessionName } = seedSession();
      const groupJid = "120363000000000002@g.us";
      upsertOmniGroupMetadata({
        accountId: "main",
        instanceId: "11111111-1111-1111-1111-111111111111",
        chatId: groupJid,
        channel: "whatsapp",
        name: "Ravi - Dev",
        participants: [
          {
            platformUserId: "178035101794451",
            normalizedPlatformUserId: "5511947879044",
            mentionUserId: "5511947879044@s.whatsapp.net",
            displayName: "Luís Filipe",
          },
        ],
        fetchedAt: Date.now(),
      });
      const send = mock(async (..._args: Parameters<GatewaySend>) => ({ messageId: "outbound-lid-mention" }));
      const gateway = makeGateway(send);

      await handleResponse(
        gateway,
        sessionName,
        makeResponse({
          response: "@5511947879044, testa agora",
          target: {
            channel: "whatsapp-baileys",
            accountId: "main",
            chatId: groupJid,
            sourceMessageId: "inbound-group-lid-mention",
          },
        }),
      );

      expect(send).toHaveBeenCalledTimes(1);
      const [, , text, options] = send.mock.calls[0] as Parameters<GatewaySend>;
      expect(text).toBe("@178035101794451, testa agora");
      expect(options).toMatchObject({
        mentions: [{ id: "178035101794451@lid", type: "user" }],
      });
    } finally {
      if (oldApiUrl === undefined) delete process.env.OMNI_API_URL;
      else process.env.OMNI_API_URL = oldApiUrl;
      if (oldApiKey === undefined) delete process.env.OMNI_API_KEY;
      else process.env.OMNI_API_KEY = oldApiKey;
    }
  });

  it("falls back to native WhatsApp mention metadata for inline phone placeholders", async () => {
    const oldApiUrl = process.env.OMNI_API_URL;
    const oldApiKey = process.env.OMNI_API_KEY;
    process.env.OMNI_API_URL = "http://omni.local";
    process.env.OMNI_API_KEY = "test-key";

    try {
      const { sessionName } = seedSession();
      const groupJid = "120363000000000001@g.us";
      upsertOmniGroupMetadata({
        accountId: "main",
        instanceId: "11111111-1111-1111-1111-111111111111",
        chatId: groupJid,
        channel: "whatsapp",
        name: "Ravi - Dev",
        participants: [],
        fetchedAt: Date.now(),
      });
      const send = mock(async (..._args: Parameters<GatewaySend>) => ({ messageId: "outbound-phone-mention" }));
      const gateway = makeGateway(send);

      await handleResponse(
        gateway,
        sessionName,
        makeResponse({
          response: "@5511947879044, cola isso no terminal pra ver:",
          target: {
            channel: "whatsapp-baileys",
            accountId: "main",
            chatId: groupJid,
            sourceMessageId: "inbound-group-phone-mention",
          },
        }),
      );

      expect(send).toHaveBeenCalledTimes(1);
      const [, , text, options] = send.mock.calls[0] as Parameters<GatewaySend>;
      expect(text).toBe("@5511947879044, cola isso no terminal pra ver:");
      expect(options).toMatchObject({
        mentions: [{ id: "5511947879044@s.whatsapp.net", type: "user" }],
      });
    } finally {
      if (oldApiUrl === undefined) delete process.env.OMNI_API_URL;
      else process.env.OMNI_API_URL = oldApiUrl;
      if (oldApiKey === undefined) delete process.env.OMNI_API_KEY;
      else process.env.OMNI_API_KEY = oldApiKey;
    }
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

  it("stops active presence from idle runtime status", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const clearActiveTarget = mock(async () => {});
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

    await handleRuntimePresence(gateway, sessionName, { type: "status", status: "idle", _source: target });

    expect(renewActiveTarget).not.toHaveBeenCalled();
    expect(clearActiveTarget).toHaveBeenCalledTimes(1);
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("does not renew presence from raw provider events", async () => {
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

    await handleRuntimePresence(gateway, sessionName, {
      type: "provider.raw",
      nativeEvent: "item.completed",
      _source: target,
    });

    expect(renewActiveTarget).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("does not expose typing for suppressed background runtime sources", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const target = { ...makeResponse().target!, suppressPresence: true };
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        getActiveTarget: () => target,
        renewActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "turn.started", _source: target });
    await handleRuntimePresence(gateway, sessionName, { type: "tool.started", _source: target });

    expect(renewActiveTarget).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalledWith(expect.any(String), expect.any(String), true);
  });

  it("does not force typing when a suppressed background turn is interrupted", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => false);
    const target = { ...makeResponse().target!, suppressPresence: true };
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        renewActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "turn.interrupted", _source: target });

    expect(renewActiveTarget).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalledWith(expect.any(String), expect.any(String), true);
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

  it("treats account-name and instance-id presence targets as the same chat", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const renewActiveTarget = mock(async () => true);
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        getActiveTarget: () => makeResponse().target,
        renewActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, {
      type: "tool.started",
      _source: makeInstanceAliasTarget(),
    });

    expect(renewActiveTarget).toHaveBeenCalledTimes(1);
    expect(sendTyping).not.toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "5511999999999@s.whatsapp.net",
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

  it("records presence trace for fallback typing renewal", async () => {
    const { sessionKey, sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        renewActiveTarget: mock(async () => false),
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "stream.chunk", _source: makeResponse().target });

    const presenceEvents = listSessionEvents(sessionKey).filter((event) => event.eventGroup === "presence");
    expect(presenceEvents).toHaveLength(1);
    expect(presenceEvents[0]).toMatchObject({
      eventType: "presence.typing",
      status: "active",
      preview: "runtime-stream.chunk active",
    });
    expect(emitted).toContainEqual([
      "ravi.presence.typing",
      expect.objectContaining({
        sessionName,
        active: true,
        status: "active",
        reason: "runtime-stream.chunk",
      }),
    ]);
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

  it("records presence trace when terminal events clear an active target", async () => {
    const { sessionKey, sessionName } = seedSession();
    const clearActiveTarget = mock(async () => {});
    const target = makeResponse().target!;
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        getActiveTarget: () => target,
        clearActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, { type: "turn.complete", _source: target });

    const presenceEvents = listSessionEvents(sessionKey).filter((event) => event.eventGroup === "presence");
    expect(clearActiveTarget).toHaveBeenCalledTimes(1);
    expect(presenceEvents).toHaveLength(1);
    expect(presenceEvents[0]).toMatchObject({
      eventType: "presence.typing",
      status: "inactive",
      preview: "terminal-clear-active-target inactive",
    });
  });

  it("clears equivalent account-name and instance-id targets without duplicate fallback pauses", async () => {
    const { sessionName } = seedSession();
    const sendTyping = mock(async () => {});
    const clearActiveTarget = mock(() => {});
    const gateway = makeGateway(
      mock(async () => ({ messageId: "outbound-1" })),
      {
        sendTyping,
        getActiveTarget: () => makeResponse().target,
        clearActiveTarget,
      },
    );

    await handleRuntimePresence(gateway, sessionName, {
      type: "turn.complete",
      _source: makeInstanceAliasTarget(),
    });

    expect(clearActiveTarget).toHaveBeenCalledTimes(1);
    expect(sendTyping).not.toHaveBeenCalled();
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

  it("treats turn.completed as terminal for presence lifecycle", async () => {
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
    await handleRuntimePresence(gateway, sessionName, { type: "turn.completed", _source: target });
    renewActiveTarget.mockClear();
    sendTyping.mockClear();

    await handleRuntimePresence(gateway, sessionName, { type: "stream.chunk", _source: target });

    expect(clearActiveTarget).toHaveBeenCalledTimes(1);
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
