import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "../utils/logger.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

const actualRouterDbModule = await import("../router/router-db.js");
const actualRouterSessionsModule = await import("../router/sessions.js");
const actualDbSaveMessageMeta = actualRouterDbModule.dbSaveMessageMeta;
const actualDbGetMessageMeta = actualRouterDbModule.dbGetMessageMeta;
const actualDbUpsertChat = actualRouterDbModule.dbUpsertChat;
const actualDbUpsertChatParticipant = actualRouterDbModule.dbUpsertChatParticipant;
const actualDbBindSessionToChat = actualRouterDbModule.dbBindSessionToChat;
const actualDbUpsertSessionParticipant = actualRouterDbModule.dbUpsertSessionParticipant;
const actualGetOrCreateSession = actualRouterSessionsModule.getOrCreateSession;

const promptCalls: Array<[string, Record<string, unknown>]> = [];
const chatParticipantCalls: Array<Parameters<typeof actualDbUpsertChatParticipant>[0]> = [];
const sessionParticipantCalls: Array<Parameters<typeof actualDbUpsertSessionParticipant>[0]> = [];
const messageMetaSaveCalls: Array<[string, string, Record<string, unknown>]> = [];
const agentPlatformIdentityCalls: Array<Record<string, unknown>> = [];
const platformIdentityByUser = new Map<string, Record<string, unknown>>();
const messageMetaById = new Map<
  string,
  {
    messageId: string;
    chatId: string;
    transcription?: string;
    mediaPath?: string;
    mediaType?: string;
    createdAt: number;
  }
>();
let stateDir: string | null = null;

mock.module("../nats.js", () => ({
  getNats: () => {
    throw new Error("not used in this test");
  },
  publish: mock(async () => {}),
  nats: {
    emit: mock(async () => {}),
    subscribe: async function* () {},
  },
}));

mock.module("./session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    promptCalls.push([sessionName, payload]);
  }),
}));

mock.module("../slash/index.js", () => ({
  handleSlashCommand: mock(async () => false),
}));

mock.module("../router/index.js", () => ({
  expandHome: (cwd: string) => cwd,
  resolveRoute: () => ({
    sessionKey: "agent:main:whatsapp:main:group:120363424772797713",
    sessionName: "dev",
    dmScope: "main",
    route: { pattern: "group:120363424772797713", priority: 0, session: "dev" },
    agent: {
      id: "main",
      cwd: "/tmp/ravi-agent",
      mode: "active",
    },
  }),
}));

mock.module("../config-store.js", () => ({
  configStore: {
    getConfig: () => ({
      instanceToAccount: { "instance-1": "main" },
      instances: { main: { name: "main", agent: "main", enabled: true, groupPolicy: "open", dmPolicy: "open" } },
      routes: [],
      agents: {},
      defaultAgent: "main",
      defaultDmScope: "main",
      accountAgents: {},
      ignoredOmniInstanceIds: [],
    }),
  },
}));

mock.module("../contacts.js", () => ({
  isContactAllowedForAgent: () => true,
  saveAccountPending: () => false,
  resolvePlatformIdentity: (input: { platformUserId: string }) =>
    platformIdentityByUser.get(input.platformUserId) ?? null,
  upsertAgentPlatformIdentity: mock((input: Record<string, unknown>) => {
    agentPlatformIdentityCalls.push(input);
    return {
      id: "pi_agent_connected",
      ownerType: "agent",
      ownerId: input.agentId,
      channel: input.channel,
      instanceId: input.instanceId,
      platformUserId: input.platformUserId,
      normalizedPlatformUserId: input.platformUserId,
      confidence: 1,
    };
  }),
  getContact: () => ({ status: "allowed" }),
  getContactName: (identity: string) => {
    if (identity === "group:120363424772797713") return "Ravi - Dev";
    if (identity === "5511947879044") return "Luis";
    return null;
  },
}));

mock.module("../router/router-db.js", () => ({
  ...actualRouterDbModule,
  dbSaveMessageMeta: mock((messageId: string, chatId: string, opts: Record<string, unknown>) => {
    messageMetaSaveCalls.push([messageId, chatId, opts]);
    return actualDbSaveMessageMeta(messageId, chatId, opts);
  }),
  dbGetMessageMeta: mock((messageId: string) => messageMetaById.get(messageId) ?? actualDbGetMessageMeta(messageId)),
  dbUpsertChat: mock((input: Parameters<typeof actualDbUpsertChat>[0]) => actualDbUpsertChat(input)),
  dbUpsertChatParticipant: mock((input: Parameters<typeof actualDbUpsertChatParticipant>[0]) => {
    chatParticipantCalls.push(input);
    return actualDbUpsertChatParticipant(input);
  }),
  dbBindSessionToChat: mock((input: Parameters<typeof actualDbBindSessionToChat>[0]) =>
    actualDbBindSessionToChat(input),
  ),
  dbUpsertSessionParticipant: mock((input: Parameters<typeof actualDbUpsertSessionParticipant>[0]) => {
    sessionParticipantCalls.push(input);
    return actualDbUpsertSessionParticipant(input);
  }),
}));

mock.module("../session-trace/channel-trace.js", () => ({
  recordChannelMessageReceivedTrace: mock(() => ({})),
  recordRouteResolvedTrace: mock(() => ({})),
}));

mock.module("../utils/media.js", () => ({
  fetchOmniMedia: mock(async () => null),
  saveToAgentAttachments: mock(async () => null),
  MAX_AUDIO_BYTES: 16 * 1024 * 1024,
}));

mock.module("../transcribe/openai.js", () => ({
  transcribeAudio: mock(async () => ""),
}));

const loggerChildSpy = spyOn(logger, "child").mockImplementation(
  () =>
    ({
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    }) as never,
);

const { OmniConsumer } = await import("./consumer.js");

afterAll(() => {
  loggerChildSpy.mockRestore();
  mock.restore();
});

describe("OmniConsumer channel context", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-omni-consumer-context-");
    actualGetOrCreateSession("agent:main:whatsapp:main:group:120363424772797713", "main", "/tmp/ravi-agent");
    promptCalls.length = 0;
    chatParticipantCalls.length = 0;
    sessionParticipantCalls.length = 0;
    messageMetaSaveCalls.length = 0;
    agentPlatformIdentityCalls.length = 0;
    platformIdentityByUser.clear();
    messageMetaById.clear();
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("publishes group and sender metadata from the omni message payload", async () => {
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => ({
        accountId: "main",
        instanceId: "instance-1",
        chatId: "120363424772797713@g.us",
        name: "ravi - dev",
        participants: [
          { platformUserId: "5511947879044", displayName: "Luis Filipe", role: "-" },
          { platformUserId: "63295117615153", displayName: "R M", role: "-" },
        ],
        fetchedAt: Date.now(),
      }),
      formatGroupMembers: (metadata) =>
        metadata?.participants?.map((participant) => participant.displayName ?? participant.platformUserId),
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
      id: "evt-1",
      type: "message.received",
      payload: {
        externalId: "msg-1",
        chatId: "120363424772797713@g.us",
        from: "178035101794451",
        content: {
          type: "text",
          text: "oi",
        },
        rawPayload: {
          pushName: "Luis Filipe",
          chatName: "ravi - dev",
          resolvedSenderPhone: "5511947879044",
          isGroup: true,
        },
      },
      metadata: {
        instanceId: "instance-1",
        channelType: "whatsapp-baileys",
        ingestMode: "realtime",
      },
      timestamp: Date.now(),
    });

    expect(promptCalls).toHaveLength(1);
    const [, prompt] = promptCalls[0];
    expect(prompt.context).toMatchObject({
      channelId: "whatsapp-baileys",
      channelName: "WhatsApp",
      accountId: "main",
      instanceId: "instance-1",
      chatId: "120363424772797713@g.us",
      messageId: "msg-1",
      senderId: "178035101794451",
      senderName: "Luis Filipe",
      senderPhone: "5511947879044",
      isGroup: true,
      groupName: "ravi - dev",
      groupId: "120363424772797713",
      groupMembers: ["Luis Filipe", "R M"],
    });
  });

  it("resolves an agent-owned platform identity as an agent actor", async () => {
    platformIdentityByUser.set("5511000000000", {
      id: "pi_agent_sender",
      ownerType: "agent",
      ownerId: "dev",
      channel: "whatsapp",
      instanceId: "instance-1",
      platformUserId: "5511000000000@s.whatsapp.net",
      normalizedPlatformUserId: "5511000000000",
      confidence: 1,
    });

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
      id: "evt-agent",
      type: "message.received",
      payload: {
        externalId: "msg-agent",
        chatId: "5511999999999@s.whatsapp.net",
        from: "5511000000000@s.whatsapp.net",
        content: {
          type: "text",
          text: "status",
        },
        rawPayload: {
          pushName: "Ravi Dev",
          isGroup: false,
        },
      },
      metadata: {
        instanceId: "instance-1",
        channelType: "whatsapp-baileys",
        ingestMode: "realtime",
      },
      timestamp: Date.now(),
    });

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0][1].context).toMatchObject({
      actorType: "agent",
      actorAgentId: "dev",
      platformIdentityId: "pi_agent_sender",
      rawSenderId: "5511000000000",
      normalizedSenderId: "5511000000000",
    });
    expect(chatParticipantCalls[0]).toMatchObject({
      agentId: "dev",
      contactId: null,
      platformIdentityId: "pi_agent_sender",
      role: "agent",
    });
    expect(sessionParticipantCalls[0]).toMatchObject({
      ownerType: "agent",
      ownerId: "dev",
      platformIdentityId: "pi_agent_sender",
      role: "agent",
    });
    expect(messageMetaSaveCalls[0][2]).toMatchObject({
      actorType: "agent",
      agentId: "dev",
      platformIdentityId: "pi_agent_sender",
    });
  });

  it("registers a connected channel account as an agent platform identity", async () => {
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key");

    await consumer["handleInstanceEvent"]("instance.connected.whatsapp-baileys.instance-1", {
      id: "evt-connected",
      type: "instance.connected",
      payload: {
        instanceId: "instance-1",
        channelType: "whatsapp-baileys",
        profileName: "Ravi Dev",
        ownerIdentifier: "5511000000000@s.whatsapp.net",
      },
      metadata: {
        instanceId: "instance-1",
        channelType: "whatsapp-baileys",
      },
      timestamp: Date.now(),
    });

    expect(agentPlatformIdentityCalls[0]).toMatchObject({
      agentId: "main",
      channel: "whatsapp-baileys",
      instanceId: "instance-1",
      platformUserId: "5511000000000@s.whatsapp.net",
      platformDisplayName: "Ravi Dev",
      linkedBy: "auto",
      linkReason: "omni_instance_connected",
    });
  });

  it("includes stored audio transcription when replying to a quoted WhatsApp audio", async () => {
    messageMetaById.set("quoted-audio-1", {
      messageId: "quoted-audio-1",
      chatId: "120363424772797713@g.us",
      transcription: "transcrição completa do áudio citado",
      mediaType: "audio",
      createdAt: Date.now(),
    });

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
      id: "evt-quoted-audio",
      type: "message.received",
      payload: {
        externalId: "reply-1",
        chatId: "120363424772797713@g.us",
        from: "178035101794451",
        content: {
          type: "text",
          text: "ouviu?",
        },
        replyToId: "quoted-audio-1",
        rawPayload: {
          pushName: "Luis Filipe",
          resolvedSenderPhone: "5511947879044",
          isGroup: true,
          message: {
            extendedTextMessage: {
              text: "ouviu?",
              contextInfo: {
                stanzaId: "quoted-audio-1",
                participant: "5511947879044@s.whatsapp.net",
                quotedMessage: {
                  audioMessage: {
                    mimetype: "audio/ogg; codecs=opus",
                  },
                },
              },
            },
          },
        },
      },
      metadata: {
        instanceId: "instance-1",
        channelType: "whatsapp-baileys",
        ingestMode: "realtime",
      },
      timestamp: Date.now(),
    });

    expect(promptCalls).toHaveLength(1);
    const [, prompt] = promptCalls[0];
    expect(prompt.prompt).toContain("[Replying to Luis mid:quoted-audio-1]");
    expect(prompt.prompt).toContain("[Audio]\nTranscript:\ntranscrição completa do áudio citado");
    expect(prompt.prompt).not.toContain("\n[audio]\n");
  });

  it("uses stored transcription when only normalized replyToId is available", async () => {
    messageMetaById.set("quoted-audio-2", {
      messageId: "quoted-audio-2",
      chatId: "120363424772797713@g.us",
      transcription: "histórico recuperado pelo metadata db",
      mediaType: "audio",
      createdAt: Date.now(),
    });

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
      id: "evt-reply-id-only",
      type: "message.received",
      payload: {
        externalId: "reply-2",
        chatId: "120363424772797713@g.us",
        from: "178035101794451",
        content: {
          type: "text",
          text: "sim",
        },
        replyToId: "quoted-audio-2",
        rawPayload: {
          pushName: "Luis Filipe",
          resolvedSenderPhone: "5511947879044",
          isGroup: true,
        },
      },
      metadata: {
        instanceId: "instance-1",
        channelType: "whatsapp-baileys",
        ingestMode: "realtime",
      },
      timestamp: Date.now(),
    });

    expect(promptCalls).toHaveLength(1);
    const [, prompt] = promptCalls[0];
    expect(prompt.prompt).toContain("[Replying to unknown mid:quoted-audio-2]");
    expect(prompt.prompt).toContain("[Audio]\nTranscript:\nhistórico recuperado pelo metadata db");
  });
});
