import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "../utils/logger.js";

const promptCalls: Array<[string, Record<string, unknown>]> = [];
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
      instances: { main: { name: "main", enabled: true, groupPolicy: "open", dmPolicy: "open" } },
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
  getContact: () => ({ status: "allowed" }),
  getContactName: (identity: string) => {
    if (identity === "group:120363424772797713") return "Ravi - Dev";
    if (identity === "5511947879044") return "Luis";
    return null;
  },
}));

mock.module("../router/router-db.js", () => ({
  dbSaveMessageMeta: mock(() => {}),
  dbGetMessageMeta: mock((messageId: string) => messageMetaById.get(messageId) ?? null),
  getDb: mock(() => ({
    prepare: () => ({
      get: () => null,
      all: () => [],
      run: () => ({}),
    }),
  })),
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
  beforeEach(() => {
    promptCalls.length = 0;
    messageMetaById.clear();
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
