import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../utils/logger.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { RuntimeAbortProvenance } from "../../runtime/session-dispatcher.js";
import type { MessageMetadata } from "../../router/router-db.js";
import type { RouteConfig } from "../../router/types.js";
import type { InboundSourceHooks } from "./types.js";
import { inboundEventFromSubject, noopHooks, type SubjectEnvelope } from "./__tests__/fixtures.js";

const actualRouterDbModule = await import("../../router/router-db.js");
const actualRouterIndexModule = await import("../../router/index.js");
const actualRouterSessionsModule = await import("../../router/sessions.js");
const actualChatDbModule = await import("../../db.js");
const actualSessionStreamModule = await import("../../session-prompts/stream.js");
// Cópia: o namespace é mutado in-place por mock.module.
const actualContactsModule = { ...(await import("../../contacts.js")) };
const actualNatsModule = { ...(await import("../../nats.js")) };
const actualMediaModule = { ...(await import("../../utils/media.js")) };
const actualDbSaveMessageMeta = actualRouterDbModule.dbSaveMessageMeta;
const actualDbGetMessageMeta = actualRouterDbModule.dbGetMessageMeta;
const actualDbUpsertChat = actualRouterDbModule.dbUpsertChat;
const actualDbCanonicalizeDmChatForContact = actualRouterDbModule.dbCanonicalizeDmChatForContact;
const actualDbContactDmNormalizedChatId = actualRouterDbModule.dbContactDmNormalizedChatId;
const actualDbUpsertChatMessage = actualRouterDbModule.dbUpsertChatMessage;
const actualDbUpsertChatParticipant = actualRouterDbModule.dbUpsertChatParticipant;
const actualDbUpsertSessionParticipant = actualRouterDbModule.dbUpsertSessionParticipant;
const actualGetOrCreateSession = actualRouterSessionsModule.getOrCreateSession;
const actualGetSession = actualRouterSessionsModule.getSession;
const actualUpdateProviderSession = actualRouterSessionsModule.updateProviderSession;

const promptCalls: Array<[string, Record<string, unknown>]> = [];
const chatMessageCalls: Array<Parameters<typeof actualDbUpsertChatMessage>[0]> = [];
const chatParticipantCalls: Array<Parameters<typeof actualDbUpsertChatParticipant>[0]> = [];
const sessionParticipantCalls: Array<Parameters<typeof actualDbUpsertSessionParticipant>[0]> = [];
const messageMetaSaveCalls: Array<[string, string, Record<string, unknown>]> = [];
const agentPlatformIdentityCalls: Array<Record<string, unknown>> = [];
const ensureContactFromInboundCalls: Array<Record<string, unknown>> = [];
const platformIdentityByUser = new Map<string, Record<string, unknown>>();
const platformIdentityByLookup = new Map<string, Record<string, unknown>>();
const agentPlatformIdentityByUser = new Map<string, Record<string, unknown>>();
const contactByRef = new Map<string, Record<string, unknown>>();
const messageMetaById = new Map<string, MessageMetadata>();
const recordInboundCalls: string[] = [];
const channelMessageTraceCalls: Array<Record<string, unknown>> = [];
const saveToAgentAttachmentsMock = mock(async () => null as string | null);
const transcribeAudioMock = mock(async () => ({ text: "" }));
const handleSlashCommandMock = mock(async (_input: Record<string, unknown>) => false);
let stateDir: string | null = null;
let agentCwd = "/tmp/ravi-agent";
let contactIntakeMode: "off" | "discovered" | "pending" = "off";
let routeResult: Record<string, unknown> | null = null;
let configuredAgentMode: "active" | "sentinel" = "active";
let configuredRoutes: RouteConfig[] = [];
let useAccountAgentFallback = true;
const commitMatchedRouteCalls: Array<{
  matched: { agentId: string; route?: { pattern?: string } };
  params: { phone: string };
}> = [];

function defaultRouteResult(): Record<string, unknown> {
  return {
    sessionKey: "agent:main:whatsapp:main:group:120363424772797713",
    sessionName: "dev",
    dmScope: "main",
    route: { pattern: "group:120363424772797713", priority: 0, session: "dev" },
    agent: {
      id: "main",
      cwd: agentCwd,
      mode: configuredAgentMode,
    },
  };
}

function platformIdentityLookupKey(input: {
  channel?: string | null;
  instanceId?: string | null;
  platformUserId: string;
}) {
  return `${input.channel ?? ""}:${input.instanceId ?? ""}:${input.platformUserId}`;
}

mock.module("../../nats.js", () => ({
  getNats: () => {
    throw new Error("not used in this test");
  },
  isExplicitConnect: () => false,
  publish: mock(async () => {}),
  nats: {
    emit: mock(async () => {}),
    subscribe: async function* () {},
    close: mock(async () => {}),
  },
}));

mock.module("../../session-prompts/stream.js", () => ({
  ...actualSessionStreamModule,
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    promptCalls.push([sessionName, payload]);
  }),
}));

mock.module("../../slash/index.js", () => ({
  handleSlashCommand: handleSlashCommandMock,
}));

// Note: we intentionally do NOT override `matchRoute` here. Overriding a
// re-exported symbol in `../router/index.js` leaks into direct imports
// from `../router/resolver.js` (a bun quirk where the live binding is
// mutated in place), which would break `resolver.test.ts`. Instead we
// fix the config so the real `matchRoute` returns a valid match, and
// only override `commitMatchedRoute` to inject the test's routeResult.
mock.module("../../router/index.js", () => ({
  ...actualRouterIndexModule,
  expandHome: (cwd: string) => cwd,
  commitMatchedRoute: (matched: { agentId: string; route?: { pattern?: string } }, params: { phone: string }) => {
    commitMatchedRouteCalls.push({ matched, params });
    return routeResult;
  },
}));

mock.module("../../config-store.js", () => ({
  configStore: {
    getConfig: () => ({
      instanceToAccount: { "instance-1": "main" },
      instances: {
        main: {
          name: "main",
          agent: "main",
          enabled: true,
          groupPolicy: "open",
          dmPolicy: "open",
          contactIntakeMode,
        },
      },
      routes: configuredRoutes,
      agents: {
        main: {
          id: "main",
          cwd: agentCwd,
          dmScope: "main",
          mode: configuredAgentMode,
        },
        john: {
          id: "john",
          cwd: agentCwd,
          dmScope: "per-peer",
          mode: configuredAgentMode,
        },
      },
      defaultAgent: "main",
      defaultDmScope: "main",
      // When routeResult is null, the test wants to exercise the "no route"
      // fallback in the consumer. We mirror that by leaving accountAgents
      // empty so the real matchRoute hits its "no route for account, skip"
      // branch. When routeResult is set, accountAgents maps main→main so
      // matchRoute returns a valid match; commitMatchedRoute is then mocked
      // to inject the test's routeResult for downstream assertions.
      accountAgents: useAccountAgentFallback && routeResult ? { main: "main" } : {},
      ignoredOmniInstanceIds: [],
    }),
  },
}));

mock.module("../../contacts.js", () => ({
  ...actualContactsModule,
  isContactAllowedForAgent: () => true,
  saveAccountPending: () => false,
  buildMentionedContactPromptContexts: mock((input: { mentions?: Array<{ id: string; displayName?: string }> }) =>
    (input.mentions ?? []).map((mention) => ({
      displayName: mention.displayName ?? "Contato mencionado",
      summaryLines: ["Contexto CRM de teste para a pessoa mencionada."],
    })),
  ),
  recordInbound: mock((contactRef: string) => {
    recordInboundCalls.push(contactRef);
  }),
  ensureContactFromInbound: mock((input: Record<string, unknown>) => {
    ensureContactFromInboundCalls.push(input);
    return {
      contact: {
        id: "contact_auto",
        phone: input.contactIdentity,
        name: input.displayName ?? null,
        status: input.intakeMode ?? "pending",
      },
      policy: {
        contactId: "contact_auto",
        status: input.intakeMode ?? "pending",
      },
      platformIdentity: {
        id: "pi_auto",
        ownerType: "contact",
        ownerId: "contact_auto",
        channel: input.channel,
        instanceId: input.instanceId,
        platformUserId: input.platformSenderId,
        normalizedPlatformUserId: input.contactIdentity,
        confidence: 1,
      },
      createdContact: true,
      createdPlatformIdentity: true,
      eventIds: [],
    };
  }),
  resolvePlatformIdentity: (input: { channel?: string | null; instanceId?: string | null; platformUserId: string }) =>
    platformIdentityByLookup.get(platformIdentityLookupKey(input)) ??
    platformIdentityByUser.get(input.platformUserId) ??
    null,
  resolveAgentPlatformIdentity: (input: { platformUserId: string }) =>
    agentPlatformIdentityByUser.get(input.platformUserId) ?? null,
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
  getContact: (identity: string) => contactByRef.get(identity) ?? { status: "allowed" },
  getContactName: (identity: string) => {
    if (identity === "group:120363424772797713") return "Ravi - Dev";
    if (identity === "5511947879044") return "Luis";
    return null;
  },
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
  dbSaveMessageMeta: mock((messageId: string, chatId: string, opts: Record<string, unknown>) => {
    messageMetaSaveCalls.push([messageId, chatId, opts]);
    return actualDbSaveMessageMeta(messageId, chatId, opts);
  }),
  dbGetMessageMeta: mock((messageId: string) => messageMetaById.get(messageId) ?? actualDbGetMessageMeta(messageId)),
  dbUpsertChat: mock((input: Parameters<typeof actualDbUpsertChat>[0]) => actualDbUpsertChat(input)),
  dbCanonicalizeDmChatForContact: mock((input: Parameters<typeof actualDbCanonicalizeDmChatForContact>[0]) =>
    actualDbCanonicalizeDmChatForContact(input),
  ),
  dbContactDmNormalizedChatId: actualDbContactDmNormalizedChatId,
  dbUpsertChatMessage: mock((input: Parameters<typeof actualDbUpsertChatMessage>[0]) => {
    chatMessageCalls.push(input);
    return actualDbUpsertChatMessage(input);
  }),
  dbUpsertChatParticipant: mock((input: Parameters<typeof actualDbUpsertChatParticipant>[0]) => {
    chatParticipantCalls.push(input);
    return actualDbUpsertChatParticipant(input);
  }),
  dbUpsertSessionParticipant: mock((input: Parameters<typeof actualDbUpsertSessionParticipant>[0]) => {
    sessionParticipantCalls.push(input);
    return actualDbUpsertSessionParticipant(input);
  }),
}));

mock.module("../../session-trace/channel-trace.js", () => ({
  recordChannelMessageReceivedTrace: mock((input: Record<string, unknown>) => {
    channelMessageTraceCalls.push(input);
    return {};
  }),
  recordPresenceTrace: mock(() => ({})),
  recordRouteRejectedTrace: mock(() => ({})),
  recordRouteResolvedTrace: mock(() => ({})),
}));

mock.module("../../session-trace/runtime-trace.js", () => ({
  recordRuntimeTraceEvent: mock(() => ({})),
}));

mock.module("../../utils/media.js", () => ({
  ...actualMediaModule,
  saveToAgentAttachments: saveToAgentAttachmentsMock,
  MAX_AUDIO_BYTES: 16 * 1024 * 1024,
}));

mock.module("../../transcribe/openai.js", () => ({
  transcribeAudio: transcribeAudioMock,
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

const { ChannelInboundPipeline, supportsReadReceipts } = await import("./pipeline.js");
const { createLocalMediaLoader } = await import("../whatsapp/inbound-source.js");

/** Hand one Omni-shaped `(subject, envelope)` fixture to the pipeline (transport from the subject). */
function receive(
  pipeline: InstanceType<typeof ChannelInboundPipeline>,
  subject: string,
  envelope: SubjectEnvelope,
  hooks: InboundSourceHooks = noopHooks(),
): Promise<void> {
  return pipeline.handle(inboundEventFromSubject(subject, envelope), hooks);
}

afterAll(() => {
  loggerChildSpy.mockRestore();
  mock.restore();
  // mock.restore() não desfaz mock.module: o getContact fake (fallback
  // { status: "allowed" } sem identities) vazava para outros arquivos.
  mock.module("../../contacts.js", () => actualContactsModule);
  // Idem para nats: o `nats.emit` fake é um mock(); um spyOn(nats, "emit")
  // + mockRestore() posterior (ephemeral/runner.test.ts) zera a implementação
  // e emit passa a retornar undefined, quebrando `nats.emit(...).catch`.
  mock.module("../../nats.js", () => actualNatsModule);
});

describe("supportsReadReceipts", () => {
  it("only enables read receipts for canonical WhatsApp (the only channel with real receipt semantics)", () => {
    expect(supportsReadReceipts("whatsapp")).toBe(true);
    expect(supportsReadReceipts("whatsapp-baileys")).toBe(true);
    expect(supportsReadReceipts("WhatsApp Baileys")).toBe(true);
    // WhatsApp-family providers other than Baileys are unsupported (D9): their events never reach the pipeline.
    expect(supportsReadReceipts("twilio-whatsapp")).toBe(false);
    expect(supportsReadReceipts("gupshup")).toBe(false);
    expect(supportsReadReceipts("slack")).toBe(false);
    expect(supportsReadReceipts("discord")).toBe(false);
    expect(supportsReadReceipts("telegram")).toBe(false);
  });
});

describe("ChannelInboundPipeline channel context", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-channel-inbound-pipeline-context-");
    agentCwd = join(stateDir, "agent");
    configuredAgentMode = "active";
    routeResult = defaultRouteResult();
    contactIntakeMode = "off";
    configuredRoutes = [];
    useAccountAgentFallback = true;
    commitMatchedRouteCalls.length = 0;
    actualGetOrCreateSession("agent:main:whatsapp:main:group:120363424772797713", "main", agentCwd);
    promptCalls.length = 0;
    chatMessageCalls.length = 0;
    chatParticipantCalls.length = 0;
    sessionParticipantCalls.length = 0;
    messageMetaSaveCalls.length = 0;
    agentPlatformIdentityCalls.length = 0;
    ensureContactFromInboundCalls.length = 0;
    platformIdentityByUser.clear();
    platformIdentityByLookup.clear();
    agentPlatformIdentityByUser.clear();
    contactByRef.clear();
    messageMetaById.clear();
    recordInboundCalls.length = 0;
    channelMessageTraceCalls.length = 0;
    saveToAgentAttachmentsMock.mockClear();
    transcribeAudioMock.mockClear();
    handleSlashCommandMock.mockClear();
    saveToAgentAttachmentsMock.mockImplementation(async () => null);
    transcribeAudioMock.mockImplementation(async () => ({ text: "" }));
    handleSlashCommandMock.mockImplementation(async () => false);
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
    const consumer = new ChannelInboundPipeline(sender as never, {
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

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
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

  it("includes the required execution confirmation in sentinel reply guidance", async () => {
    configuredAgentMode = "sentinel";
    routeResult = defaultRouteResult();
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-sentinel-guidance",
      type: "message.received",
      payload: {
        externalId: "msg-sentinel-guidance",
        chatId: "120363424772797713@g.us",
        from: "5511947879044@s.whatsapp.net",
        content: { type: "text", text: "observe" },
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
    expect(promptCalls[0]?.[1].prompt).toContain("whatsapp dm send --execute to reply if instructed");
    expect(sender.sendTyping).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  describe("leading message prefixes", () => {
    function createConsumer() {
      const sender = {
        send: mock(async () => {}),
        sendTyping: mock(async () => {}),
        markRead: mock(async () => {}),
      };
      const consumer = new ChannelInboundPipeline(sender as never, {
        resolveGroupMetadata: async () => null,
      });
      return { consumer, sender };
    }

    async function receiveText(consumer: InstanceType<typeof ChannelInboundPipeline>, text: string, id = "prefix") {
      await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
        id: `evt-${id}`,
        type: "message.received",
        payload: {
          externalId: `msg-${id}`,
          chatId: "120363424772797713@g.us",
          from: "5511947879044@s.whatsapp.net",
          content: { type: "text", text },
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
    }

    it("publishes >> messages for the end of the current turn with the prefix stripped", async () => {
      const { consumer, sender } = createConsumer();

      await receiveText(consumer, ">> check the deploy");

      expect(promptCalls).toHaveLength(1);
      const [sessionName, prompt] = promptCalls[0];
      expect(sessionName).toBe("dev");
      expect(prompt.prompt).toEndWith("Luis Filipe: check the deploy");
      expect(prompt.prompt).not.toContain(">>");
      expect(prompt).toMatchObject({
        deliveryBarrier: "after_response",
        deliveryBarrierSource: "explicit",
        _humanUrgent: false,
        source: { channel: "whatsapp-baileys", chatId: "120363424772797713@g.us", sourceMessageId: "msg-prefix" },
      });
      expect(prompt._skipTurn).toBeUndefined();
      expect(sender.sendTyping).toHaveBeenCalled();
    });

    it("publishes !! messages as normal user messages that skip the turn and typing", async () => {
      const { consumer, sender } = createConsumer();

      await receiveText(consumer, "!!budget is 10k");

      expect(promptCalls).toHaveLength(1);
      const [sessionName, prompt] = promptCalls[0];
      expect(sessionName).toBe("dev");
      expect(prompt.prompt).toEndWith("Luis Filipe: budget is 10k");
      expect(prompt.prompt).not.toContain("!!");
      expect(prompt).toMatchObject({
        _skipTurn: true,
        _humanUrgent: false,
        source: { channel: "whatsapp-baileys", chatId: "120363424772797713@g.us", sourceMessageId: "msg-prefix" },
        context: { messageId: "msg-prefix", senderName: "Luis Filipe" },
      });
      expect(prompt.deliveryBarrier).toBeUndefined();
      expect(sender.sendTyping).not.toHaveBeenCalled();
    });

    it("expands Ravi commands from the text after the prefix", async () => {
      const commandsDir = join(agentCwd, ".ravi", "commands");
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(
        join(commandsDir, "restart.md"),
        [
          "---",
          "description: Restart with a reason.",
          "arguments:",
          "  - reason",
          "---",
          'Use `ravi daemon restart -m "$reason"`.',
          "",
        ].join("\n"),
      );
      const { consumer } = createConsumer();

      await receiveText(consumer, '>> #restart "depois do turno"');

      expect(promptCalls).toHaveLength(1);
      const [, prompt] = promptCalls[0];
      expect(prompt.prompt).toContain("## Ravi Command: #restart");
      expect(prompt.prompt).toContain('Use `ravi daemon restart -m "depois do turno"`.');
      expect(prompt.commands).toMatchObject([{ id: "restart", originalText: '#restart "depois do turno"' }]);
      expect(prompt.deliveryBarrier).toBe("after_response");
    });

    it("passes a bare prefix or a prefix followed only by whitespace to the agent literally", async () => {
      const { consumer } = createConsumer();
      const texts = [">>", "!!", ">>   ", "!!  \n"];

      for (const [index, text] of texts.entries()) {
        await receiveText(consumer, text, `bare-${index}`);
      }

      expect(promptCalls).toHaveLength(texts.length);
      for (const [index, text] of texts.entries()) {
        const prompt = promptCalls[index]?.[1];
        expect(prompt?.prompt).toEndWith(`Luis Filipe: ${text}`);
        expect(prompt?.deliveryBarrier).toBeUndefined();
        expect(prompt?._skipTurn).toBeUndefined();
        expect(prompt?._humanUrgent).toBe(false);
      }
    });

    it("ignores prefixes that are not at the start and keeps urgent words urgent", async () => {
      const { consumer } = createConsumer();

      await receiveText(consumer, "hello >> world", "mid-end");
      await receiveText(consumer, "hello !! world", "mid-skip");
      await receiveText(consumer, "urgente: para tudo", "urgent");

      expect(promptCalls).toHaveLength(3);
      expect(promptCalls[0]?.[1].prompt).toEndWith("Luis Filipe: hello >> world");
      expect(promptCalls[1]?.[1].prompt).toEndWith("Luis Filipe: hello !! world");
      for (const [, prompt] of promptCalls.slice(0, 2)) {
        expect(prompt.deliveryBarrier).toBeUndefined();
        expect(prompt._skipTurn).toBeUndefined();
        expect(prompt._humanUrgent).toBe(false);
      }
      expect(promptCalls[2]?.[1]._humanUrgent).toBe(true);
    });
  });

  it("passes the provider message identifier to intercepted slash commands", async () => {
    handleSlashCommandMock.mockImplementation(async () => true);
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-native-action",
      type: "message.received",
      payload: {
        externalId: "msg-native-action",
        chatId: "120363424772797713@g.us",
        from: "178035101794451",
        content: {
          type: "text",
          text: "/connect",
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

    expect(handleSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(handleSlashCommandMock.mock.calls[0]?.[0]).toMatchObject({
      text: "/connect",
      messageId: "msg-native-action",
      senderId: "178035101794451",
      chatId: "120363424772797713@g.us",
      channelType: "whatsapp-baileys",
      accountId: "main",
    });
    expect(promptCalls).toHaveLength(0);
  });

  it("resolves new WhatsApp LID group senders through contact intake without canonicalizing the group as a DM", async () => {
    contactIntakeMode = "discovered";
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-group-lid-intake",
      type: "message.received",
      payload: {
        externalId: "msg-group-lid-intake",
        chatId: "120363424772797713@g.us",
        from: "35082198892544@lid",
        content: {
          type: "text",
          text: "oi",
        },
        rawPayload: {
          pushName: "Tars",
          chatName: "Rbbt <> Nubank",
          isGroup: true,
          key: {
            participantAlt: "551148637337@s.whatsapp.net",
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

    expect(ensureContactFromInboundCalls).toHaveLength(1);
    expect(ensureContactFromInboundCalls[0]).toMatchObject({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformSenderId: "35082198892544@lid",
      contactIdentity: "551148637337",
      displayName: "Tars",
      chatType: "group",
      providerMessageId: "msg-group-lid-intake",
      intakeMode: "discovered",
    });
    expect(chatMessageCalls[0]).toMatchObject({
      providerMessageId: "msg-group-lid-intake",
      rawChatId: "120363424772797713@g.us",
      rawSenderId: "35082198892544",
      normalizedSenderId: "551148637337",
      actorType: "contact",
      contactId: "contact_auto",
      platformIdentityId: "pi_auto",
      messageType: "text",
    });
    expect(chatParticipantCalls[0]).toMatchObject({
      contactId: "contact_auto",
      platformIdentityId: "pi_auto",
      rawPlatformUserId: "35082198892544",
      normalizedPlatformUserId: "551148637337",
      source: "inbound_message",
    });
    expect(sessionParticipantCalls[0]).toMatchObject({
      ownerType: "contact",
      ownerId: "contact_auto",
      platformIdentityId: "pi_auto",
      role: "human",
    });
    const groupChat = actualRouterDbModule.dbFindChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "120363424772797713@g.us",
      chatType: "group",
    });
    expect(groupChat).toMatchObject({
      chatType: "group",
      normalizedChatId: "group:120363424772797713",
    });
  });

  it("links a group WhatsApp LID through contact intake when intake mode is off and a phone is resolved", async () => {
    contactIntakeMode = "off";
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-group-lid-intake-off",
      type: "message.received",
      payload: {
        externalId: "msg-group-lid-intake-off",
        chatId: "120363424772797713@g.us",
        from: "35082198892544@lid",
        content: {
          type: "text",
          text: "oi",
        },
        rawPayload: {
          pushName: "Tars",
          chatName: "Rbbt <> Nubank",
          isGroup: true,
          key: {
            participantAlt: "551148637337@s.whatsapp.net",
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

    expect(ensureContactFromInboundCalls).toHaveLength(1);
    expect(ensureContactFromInboundCalls[0]).toMatchObject({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformSenderId: "35082198892544@lid",
      contactIdentity: "551148637337",
      displayName: "Tars",
      chatType: "group",
      providerMessageId: "msg-group-lid-intake-off",
      intakeMode: "off",
    });
    expect(chatMessageCalls[0]).toMatchObject({
      providerMessageId: "msg-group-lid-intake-off",
      rawSenderId: "35082198892544",
      normalizedSenderId: "551148637337",
      actorType: "contact",
      contactId: "contact_auto",
      platformIdentityId: "pi_auto",
    });
  });

  it("does not run contact intake for a group WhatsApp LID without a resolved phone when intake is off", async () => {
    contactIntakeMode = "off";
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-group-lid-unresolved",
      type: "message.received",
      payload: {
        externalId: "msg-group-lid-unresolved",
        chatId: "120363424772797713@g.us",
        from: "35082198892544@lid",
        content: {
          type: "text",
          text: "oi",
        },
        rawPayload: {
          pushName: "Tars",
          chatName: "Rbbt <> Nubank",
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

    expect(ensureContactFromInboundCalls).toHaveLength(0);
    expect(chatMessageCalls[0]).toMatchObject({
      providerMessageId: "msg-group-lid-unresolved",
      rawSenderId: "35082198892544",
      normalizedSenderId: "35082198892544",
      contactId: null,
      platformIdentityId: null,
    });
  });

  it("does not run contact intake for an agent-owned WhatsApp LID", async () => {
    contactIntakeMode = "off";
    agentPlatformIdentityByUser.set("lid:35082198892544", {
      id: "pi_agent_lid",
      ownerType: "agent",
      ownerId: "dev",
      channel: "whatsapp",
      instanceId: "agent-instance",
      platformUserId: "35082198892544@lid",
      normalizedPlatformUserId: "lid:35082198892544",
      confidence: 1,
    });
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-group-lid-agent",
      type: "message.received",
      payload: {
        externalId: "msg-group-lid-agent",
        chatId: "120363424772797713@g.us",
        from: "35082198892544@lid",
        content: {
          type: "text",
          text: "oi",
        },
        rawPayload: {
          pushName: "Ravi",
          chatName: "Rbbt <> Nubank",
          isGroup: true,
          resolvedSenderPhone: "551148637337",
        },
      },
      metadata: {
        instanceId: "instance-1",
        channelType: "whatsapp-baileys",
        ingestMode: "realtime",
      },
      timestamp: Date.now(),
    });

    expect(ensureContactFromInboundCalls).toHaveLength(0);
    expect(chatMessageCalls[0]).toMatchObject({
      providerMessageId: "msg-group-lid-agent",
      actorType: "agent",
      contactId: null,
      agentId: "dev",
      platformIdentityId: "pi_agent_lid",
    });
    expect(promptCalls).toHaveLength(0);
  });

  it("routes WhatsApp LID DMs through the resolved sender phone", async () => {
    const route: RouteConfig = {
      pattern: "5511947879044",
      accountId: "main",
      agent: "main",
      dmScope: "main",
      channel: "whatsapp",
    };
    configuredRoutes = [route];
    useAccountAgentFallback = false;
    routeResult = {
      sessionKey: "agent:main:main",
      sessionName: "main",
      dmScope: "main",
      route,
      agent: {
        id: "main",
        cwd: agentCwd,
        mode: "active",
      },
    };
    actualGetOrCreateSession("agent:main:main", "main", agentCwd);

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-dm-lid-route",
      type: "message.received",
      payload: {
        externalId: "msg-dm-lid-route",
        chatId: "178035101794451@lid",
        from: "178035101794451@lid",
        content: {
          type: "text",
          text: "oi",
        },
        rawPayload: {
          pushName: "Luis Filipe",
          resolvedSenderPhone: "5511947879044",
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
    expect(promptCalls[0]?.[1].context).toMatchObject({
      senderId: "178035101794451",
      senderPhone: "5511947879044",
      isGroup: false,
    });
    expect(commitMatchedRouteCalls).toHaveLength(1);
    expect(commitMatchedRouteCalls[0]?.params.phone).toBe("5511947879044");
    expect(commitMatchedRouteCalls[0]?.matched.agentId).toBe("main");
  });

  it("routes unresolved WhatsApp LID DMs by lid: identity instead of falling through to main", async () => {
    const lidRoute: RouteConfig = {
      pattern: "lid:224420715061374",
      accountId: "main",
      agent: "john",
      priority: 10,
      channel: "whatsapp",
    };
    const fallbackRoute: RouteConfig = {
      pattern: "*",
      accountId: "main",
      agent: "main",
      priority: 0,
    };
    configuredRoutes = [lidRoute, fallbackRoute];
    useAccountAgentFallback = true;
    routeResult = {
      sessionKey: "agent:john:dm:lid:224420715061374",
      sessionName: "john-dm-061374",
      dmScope: "per-peer",
      route: lidRoute,
      agent: {
        id: "john",
        cwd: agentCwd,
        mode: "active",
      },
    };
    actualGetOrCreateSession("agent:john:dm:lid:224420715061374", "john", agentCwd);

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-dm-lid-unresolved",
      type: "message.received",
      payload: {
        externalId: "msg-dm-lid-unresolved",
        chatId: "224420715061374@lid",
        from: "224420715061374@lid",
        content: {
          type: "text",
          text: "oi",
        },
        rawPayload: {
          pushName: "Dudu",
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

    expect(commitMatchedRouteCalls).toHaveLength(1);
    expect(commitMatchedRouteCalls[0]?.params.phone).toBe("lid:224420715061374");
    expect(commitMatchedRouteCalls[0]?.matched.agentId).toBe("john");
    expect(commitMatchedRouteCalls[0]?.matched.route?.pattern).toBe("lid:224420715061374");
    expect(promptCalls).toHaveLength(1);
  });

  it("does not canonicalize Slack U-ids when routing DMs", async () => {
    const slackRoute: RouteConfig = {
      pattern: "U012ABCDEF",
      accountId: "main",
      agent: "john",
      priority: 10,
      channel: "slack",
    };
    configuredRoutes = [slackRoute];
    useAccountAgentFallback = false;
    routeResult = {
      sessionKey: "agent:john:slack:dm:U012ABCDEF",
      sessionName: "john-dm-abcdef",
      dmScope: "per-peer",
      route: slackRoute,
      agent: {
        id: "john",
        cwd: agentCwd,
        mode: "active",
      },
    };
    actualGetOrCreateSession("agent:john:slack:dm:U012ABCDEF", "john", agentCwd);

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.slack.instance-1", {
      id: "evt-slack-uid",
      type: "message.received",
      payload: {
        externalId: "msg-slack-uid",
        chatId: "D012ABCDEF",
        from: "U012ABCDEF",
        content: {
          type: "text",
          text: "hello",
        },
        rawPayload: {
          isDm: true,
        },
      },
      metadata: {
        instanceId: "instance-1",
        channelType: "slack",
        ingestMode: "realtime",
      },
      timestamp: Date.now(),
    });

    expect(commitMatchedRouteCalls).toHaveLength(1);
    expect(commitMatchedRouteCalls[0]?.params.phone).toBe("U012ABCDEF");
    expect(commitMatchedRouteCalls[0]?.matched.agentId).toBe("john");
  });

  it("keeps an existing primary output subscription on repeated inbound from the same chat", async () => {
    const sessionKey = "agent:main:whatsapp:main:group:120363424772797713";
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    for (const externalId of ["msg-primary-first", "msg-primary-second"]) {
      await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
        id: `evt-${externalId}`,
        type: "message.received",
        payload: {
          externalId,
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
    }

    const subscriptions = actualRouterSessionsModule.listSessionSubscriptions(sessionKey);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      role: "primary",
    });
    expect(subscriptions[0].outputAttachedAt).toBeDefined();
    expect(actualRouterDbModule.dbLegacySessionChatBindingsTableExists()).toBe(false);
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[1][1].prompt).not.toContain("[session surface");
  });

  it("records consumer lag from plugin received timestamps in channel traces", async () => {
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });
    const pluginReceivedAt = Date.now() - 2_000;

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-consumer-lag",
      type: "message.received",
      payload: {
        externalId: "msg-consumer-lag",
        chatId: "120363424772797713@g.us",
        from: "178035101794451",
        content: {
          type: "text",
          text: "lag trace",
        },
        rawPayload: {
          pushName: "Luis Filipe",
          chatName: "ravi - dev",
          resolvedSenderPhone: "5511947879044",
          pluginReceivedAt,
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

    expect(channelMessageTraceCalls).toHaveLength(1);
    expect(channelMessageTraceCalls[0].payloadJson).toMatchObject({
      pluginReceivedAtMs: pluginReceivedAt,
    });
    expect(
      (channelMessageTraceCalls[0].payloadJson as { consumerLagMs?: number }).consumerLagMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("renders inbound WhatsApp numeric mention placeholders as mentioned contact names", async () => {
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-mention",
      type: "message.received",
      payload: {
        externalId: "msg-mention",
        chatId: "120363424772797713@g.us",
        from: "178035101794451",
        content: {
          type: "text",
          text: "@91015272759397 viu quem marquei aqui?",
        },
        rawPayload: {
          pushName: "Luis Filipe",
          chatName: "ravi - dev",
          resolvedSenderPhone: "5511947879044",
          isGroup: true,
          mentionedJids: ["91015272759397@lid"],
          mentionedContacts: [{ jid: "91015272759397@lid", name: "ravi" }],
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
    expect(prompt.prompt).toContain("@ravi viu quem marquei aqui?");
    expect(prompt.prompt).not.toContain("@91015272759397 viu quem marquei aqui?");
    expect(prompt.prompt).not.toContain("Contexto CRM de teste");
    expect(prompt.prompt).not.toContain("[Nota privada do Ravi");
    expect(prompt.prompt).not.toContain("Nota privada de identidade");
    expect(prompt.prompt).not.toContain("## Pessoas Mencionadas");
    expect(prompt.prompt).not.toContain("foi mencionado nesta mensagem");
    expect(prompt.context).toMatchObject({
      mentionedContactsContext: [
        {
          displayName: "ravi",
          summaryLines: ["Contexto CRM de teste para a pessoa mencionada."],
        },
      ],
    });
    expect(chatMessageCalls[0].content).toMatchObject({
      type: "text",
      text: "@ravi viu quem marquei aqui?",
    });
    expect(chatMessageCalls[0].rawProvenance).toMatchObject({
      rawPayload: {
        mentionedJids: ["91015272759397@lid"],
        mentionedContacts: [{ jid: "91015272759397@lid", name: "ravi" }],
      },
    });
  });

  it("leaves session-surface instructions to the central dispatcher", async () => {
    const sessionKey = "agent:main:whatsapp:main:group:120363424772797713";
    const primaryChat = actualDbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "120363424772797713@g.us",
      chatType: "group",
      title: "ravi - dev",
    });
    actualRouterSessionsModule.attachChatToSession({
      sessionKey,
      chatId: primaryChat.id,
      role: "primary",
      attachedByType: "system",
      attachedReason: "test-primary",
    });

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-attached-input",
      type: "message.received",
      payload: {
        externalId: "msg-attached-input",
        chatId: "120363424704882209@g.us",
        from: "178035101794451",
        content: {
          type: "text",
          text: "boa",
        },
        rawPayload: {
          pushName: "Luis Filipe",
          chatName: "ravi - dev - test",
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

    const inputChat = actualRouterDbModule.dbFindChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "120363424704882209@g.us",
      chatType: "group",
    });
    expect(promptCalls).toHaveLength(1);
    const [, prompt] = promptCalls[0];
    expect(prompt.prompt).not.toContain("[session surface");
    expect(prompt.prompt).not.toContain("ravi sessions unmute");
    expect(actualRouterSessionsModule.findSessionByAttachedChat(inputChat!.id)?.sessionKey).toBe(sessionKey);
  });

  it("stores inbound DM messages and runs contact intake before no-route return", async () => {
    routeResult = null;
    contactIntakeMode = "pending";
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-intake-dm",
      type: "message.received",
      payload: {
        externalId: "msg-intake-dm",
        chatId: "5511999901234@s.whatsapp.net",
        from: "5511999901234@s.whatsapp.net",
        content: {
          type: "text",
          text: "olá, quero orçamento",
        },
        rawPayload: {
          pushName: "Lead Novo",
          resolvedSenderPhone: "5511999901234",
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

    expect(promptCalls).toHaveLength(0);
    expect(ensureContactFromInboundCalls).toHaveLength(1);
    expect(ensureContactFromInboundCalls[0]).toMatchObject({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformSenderId: "5511999901234@s.whatsapp.net",
      contactIdentity: "5511999901234",
      displayName: "Lead Novo",
      chatType: "dm",
      providerMessageId: "msg-intake-dm",
      intakeMode: "pending",
    });
    expect(chatMessageCalls).toHaveLength(1);
    expect(chatMessageCalls[0]).toMatchObject({
      providerMessageId: "msg-intake-dm",
      rawChatId: "5511999901234@s.whatsapp.net",
      rawSenderId: "5511999901234",
      normalizedSenderId: "5511999901234",
      actorType: "contact",
      contactId: "contact_auto",
      platformIdentityId: "pi_auto",
      messageType: "text",
    });
  });

  it("captures history-sync messages without replaying them to runtime", async () => {
    contactIntakeMode = "pending";
    const originalMessageTimestamp = 1_761_059_699;
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-history-sync-dm",
      type: "message.received",
      payload: {
        externalId: "msg-history-sync-dm",
        chatId: "5511999904321@s.whatsapp.net",
        from: "5511999904321@s.whatsapp.net",
        content: {
          type: "text",
          text: "mensagem antiga importada",
        },
        rawPayload: {
          pushName: "Lead Importado",
          resolvedSenderPhone: "5511999904321",
          isGroup: false,
          messageTimestamp: originalMessageTimestamp,
        },
      },
      metadata: {
        instanceId: "instance-1",
        channelType: "whatsapp-baileys",
        ingestMode: "history-sync",
      },
      timestamp: 1_777_777_777_000,
    });

    expect(ensureContactFromInboundCalls).toHaveLength(1);
    expect(chatMessageCalls).toHaveLength(1);
    expect(chatParticipantCalls).toHaveLength(1);
    expect(promptCalls).toHaveLength(0);
    expect(sessionParticipantCalls).toHaveLength(0);
    expect(chatMessageCalls[0]).toMatchObject({
      providerMessageId: "msg-history-sync-dm",
      actorType: "contact",
      contactId: "contact_auto",
      platformIdentityId: "pi_auto",
      providerTimestamp: originalMessageTimestamp * 1000,
      rawProvenance: {
        ingestMode: "history-sync",
        rawPayload: {
          messageTimestamp: originalMessageTimestamp,
        },
      },
    });
  });

  it("ignores WhatsApp Status before chat or contact persistence", async () => {
    contactIntakeMode = "pending";
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-status-broadcast",
      type: "message.received",
      payload: {
        externalId: "msg-status-broadcast",
        chatId: "status@broadcast",
        from: "5511999904321@s.whatsapp.net",
        content: {
          type: "image",
          text: "status must not become a private chat",
        },
        rawPayload: {
          pushName: "Status Author",
          resolvedSenderPhone: "5511999904321",
          isGroup: false,
        },
      },
      metadata: {
        instanceId: "instance-1",
        channelType: "whatsapp-baileys",
        ingestMode: "history-sync",
      },
      timestamp: 1_777_777_777_000,
    });

    expect(ensureContactFromInboundCalls).toHaveLength(0);
    expect(chatMessageCalls).toHaveLength(0);
    expect(chatParticipantCalls).toHaveLength(0);
    expect(messageMetaSaveCalls).toHaveLength(0);
    expect(promptCalls).toHaveLength(0);
    expect(sessionParticipantCalls).toHaveLength(0);
  });

  it("captures old timestamp messages without replaying them to runtime", async () => {
    contactIntakeMode = "pending";
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-old-timestamp-dm",
      type: "message.received",
      payload: {
        externalId: "msg-old-timestamp-dm",
        chatId: "5511999909876@s.whatsapp.net",
        from: "5511999909876@s.whatsapp.net",
        content: {
          type: "text",
          text: "mensagem antiga sem flag",
        },
        rawPayload: {
          pushName: "Lead Antigo",
          resolvedSenderPhone: "5511999909876",
          isGroup: false,
        },
      },
      metadata: {
        instanceId: "instance-1",
        channelType: "whatsapp-baileys",
        ingestMode: "realtime",
      },
      timestamp: Date.now() - 60_000,
    });

    expect(ensureContactFromInboundCalls).toHaveLength(1);
    expect(chatMessageCalls).toHaveLength(1);
    expect(chatParticipantCalls).toHaveLength(1);
    expect(promptCalls).toHaveLength(0);
    expect(sessionParticipantCalls).toHaveLength(0);
    expect(chatMessageCalls[0]).toMatchObject({
      providerMessageId: "msg-old-timestamp-dm",
      actorType: "contact",
      contactId: "contact_auto",
      platformIdentityId: "pi_auto",
      rawProvenance: {
        ingestMode: "realtime",
      },
    });
  });

  it("expands registered Ravi commands before building the channel envelope", async () => {
    const commandsDir = join(agentCwd, ".ravi", "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(
      join(commandsDir, "restart.md"),
      [
        "---",
        "description: Restart with a reason.",
        "arguments:",
        "  - reason",
        "---",
        'Use `ravi daemon restart -m "$reason"`.',
        "",
      ].join("\n"),
    );

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-command",
      type: "message.received",
      payload: {
        externalId: "msg-command",
        chatId: "120363424772797713@g.us",
        from: "178035101794451",
        content: {
          type: "text",
          text: '#restart "ativar commands"',
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
    expect(prompt.prompt).toContain("Luis Filipe:");
    expect(prompt.prompt).toContain("## Ravi Command: #restart");
    expect(prompt.prompt).toContain('Use `ravi daemon restart -m "ativar commands"`.');
    expect(prompt.commands).toMatchObject([
      {
        id: "restart",
        scope: "agent",
        originalText: '#restart "ativar commands"',
        arguments: '"ativar commands"',
      },
    ]);
  });

  it("publishes hash-space messages as normal chat instead of command failures", async () => {
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-hash-space",
      type: "message.received",
      payload: {
        externalId: "msg-hash-space",
        chatId: "120363424772797713@g.us",
        from: "178035101794451",
        content: {
          type: "text",
          text: "# nota comum",
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
    expect(prompt.prompt).toContain("Luis Filipe:");
    expect(prompt.prompt).toContain("# nota comum");
    expect(prompt.prompt).not.toContain("## Ravi Command:");
    expect(prompt.commands).toBeUndefined();
  });

  it("resets the runtime session and republishes a channel message edit as a rebase replay", async () => {
    const sessionKey = "agent:main:whatsapp:main:group:120363424772797713";
    actualUpdateProviderSession(sessionKey, "codex", "provider-before-edit");
    actualChatDbModule.saveMessage("dev", "user", "[WhatsApp Ravi - Dev mid:msg-original] Luis: texto antigo", null, {
      agentId: "main",
      channel: "whatsapp-baileys",
      accountId: "main",
      chatId: "120363424772797713@g.us",
      sourceMessageId: "msg-original",
    });
    actualChatDbModule.saveMessage("dev", "user", "[WhatsApp Ravi - Dev mid:msg-secret] Luis: senha: 132", null, {
      agentId: "main",
      channel: "whatsapp-baileys",
      accountId: "main",
      chatId: "120363424772797713@g.us",
      sourceMessageId: "msg-secret",
    });
    messageMetaById.set("msg-original", {
      messageId: "msg-original",
      chatId: "120363424772797713@g.us",
      canonicalChatId: "chat_ravi_dev",
      actorType: "contact",
      contactId: "contact_luis",
      rawSenderId: "178035101794451",
      normalizedSenderId: "5511947879044",
      createdAt: Date.now(),
    });
    const abortRuntimeSession = mock((_sessionName: string, _provenance: RuntimeAbortProvenance) => true);
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
      abortRuntimeSession,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-edit",
      type: "message.received",
      payload: {
        externalId: "msg-original-edit-1",
        chatId: "120363424772797713@g.us",
        from: "120363424772797713@g.us",
        content: {
          type: "edit",
          text: "texto editado",
        },
        rawPayload: {
          editedMessageId: "msg-original",
          newText: "texto editado",
          editedAt: 1778000000000,
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

    expect(abortRuntimeSession.mock.calls[0]?.[0]).toBe("dev");
    expect(abortRuntimeSession.mock.calls[0]?.[1]).toMatchObject({
      source: "whatsapp",
      action: "message.edited",
      reason: "message_edited_restart",
      correlationId: "msg-original-edit-1",
      request: {
        messageId: "msg-original",
        editEventId: "msg-original-edit-1",
      },
    });
    expect(actualGetSession(sessionKey)?.sdkSessionId).toBeUndefined();
    expect(actualGetSession(sessionKey)?.runtimeProvider).toBeUndefined();
    expect(promptCalls).toHaveLength(1);
    const [, prompt] = promptCalls[0];
    expect(prompt.prompt).toContain("## Mensagem editada detectada pelo canal");
    expect(prompt.prompt).toContain("## Runtime session rebase");
    expect(prompt.prompt).toContain("Mensagem original: msg-original");
    expect(prompt.prompt).toContain("[Message edited]\ntexto editado");
    expect(prompt.prompt).toContain("senha: 132");
    expect(prompt.prompt).not.toContain("texto antigo\n</message>");
    expect(prompt._humanUrgent).toBe(true);
    expect(prompt.context).toMatchObject({
      isEditedMessage: true,
      editedMessageId: "msg-original",
      editEventId: "msg-original-edit-1",
      editedAt: 1778000000000,
      actorType: "contact",
      contactId: "contact_luis",
      rawSenderId: "178035101794451",
      normalizedSenderId: "5511947879044",
    });
  });

  it("observes same-instance agent messages without publishing a prompt", async () => {
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
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
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

    expect(promptCalls).toHaveLength(0);
    expect(sessionParticipantCalls).toHaveLength(0);
    expect(chatParticipantCalls[0]).toMatchObject({
      agentId: "dev",
      contactId: null,
      platformIdentityId: "pi_agent_sender",
      role: "agent",
    });
    expect(chatMessageCalls[0]).toMatchObject({
      actorType: "agent",
      agentId: "dev",
      platformIdentityId: "pi_agent_sender",
      rawSenderId: "5511000000000",
      normalizedSenderId: "5511000000000",
    });
    expect(messageMetaSaveCalls[0][2]).toMatchObject({
      actorType: "agent",
      agentId: "dev",
      platformIdentityId: "pi_agent_sender",
      rawSenderId: "5511000000000",
      normalizedSenderId: "5511000000000",
    });
  });

  it("observes cross-instance agent messages without publishing a prompt", async () => {
    platformIdentityByLookup.set(
      platformIdentityLookupKey({ channel: "phone", instanceId: "", platformUserId: "551153045142" }),
      {
        id: "pi_legacy_hana_contact",
        ownerType: "contact",
        ownerId: "contact_hana_legacy",
        channel: "phone",
        instanceId: "",
        platformUserId: "551153045142",
        normalizedPlatformUserId: "551153045142",
        confidence: 0.9,
      },
    );
    agentPlatformIdentityByUser.set("551153045142", {
      id: "pi_hana_agent",
      ownerType: "agent",
      ownerId: "dev",
      channel: "whatsapp",
      instanceId: "instance-hana",
      platformUserId: "551153045142@s.whatsapp.net",
      normalizedPlatformUserId: "551153045142",
      confidence: 1,
    });

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-agent-cross-instance",
      type: "message.received",
      payload: {
        externalId: "msg-agent-cross-instance",
        chatId: "120363424772797713@g.us",
        from: "551153045142@s.whatsapp.net",
        content: {
          type: "text",
          text: "resposta da outra conta-agent",
        },
        rawPayload: {
          pushName: "Hana",
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

    expect(promptCalls).toHaveLength(0);
    expect(sessionParticipantCalls).toHaveLength(0);
    expect(chatMessageCalls[0]).toMatchObject({
      actorType: "agent",
      agentId: "dev",
      platformIdentityId: "pi_hana_agent",
      rawSenderId: "551153045142",
      normalizedSenderId: "551153045142",
    });
    expect(chatParticipantCalls[0]).toMatchObject({
      agentId: "dev",
      contactId: null,
      platformIdentityId: "pi_hana_agent",
      role: "agent",
    });
    expect(messageMetaSaveCalls[0][2]).toMatchObject({
      actorType: "agent",
      agentId: "dev",
      platformIdentityId: "pi_hana_agent",
      rawSenderId: "551153045142",
      normalizedSenderId: "551153045142",
    });
  });

  it("updates inbound contact interaction when a group sender resolves to a contact", async () => {
    contactByRef.set("contact_luis", {
      id: "contact_luis",
      status: "allowed",
      name: "Luis",
    });
    platformIdentityByUser.set("5511947879044", {
      id: "pi_luis",
      ownerType: "contact",
      ownerId: "contact_luis",
      channel: "whatsapp",
      instanceId: "instance-1",
      platformUserId: "5511947879044@s.whatsapp.net",
      normalizedPlatformUserId: "5511947879044",
      confidence: 1,
    });

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
      id: "evt-contact-inbound",
      type: "message.received",
      payload: {
        externalId: "msg-contact-inbound",
        chatId: "120363424772797713@g.us",
        from: "178035101794451",
        content: {
          type: "text",
          text: "oi",
        },
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

    expect(recordInboundCalls).toEqual(["contact_luis"]);
    expect(messageMetaSaveCalls[0][2]).toMatchObject({
      actorType: "contact",
      contactId: "contact_luis",
      platformIdentityId: "pi_luis",
    });
    expect(sessionParticipantCalls[0]).toMatchObject({
      ownerType: "contact",
      ownerId: "contact_luis",
      platformIdentityId: "pi_luis",
      role: "human",
    });
  });

  it("registers a connected channel account as an agent platform identity", async () => {
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never);

    await receive(consumer, "instance.connected.whatsapp-baileys.instance-1", {
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
      linkReason: "whatsapp_instance_connected",
    });
  });

  it("saves transcribed inbound audio and exposes the attachment path in the prompt", async () => {
    const audioBuffer = Buffer.from("audio-bytes");
    const audioPath = join(agentCwd, "attachments", "msg-audio.ogg");
    const loadMedia = mock(async (_event: unknown, _request: unknown) => audioBuffer as Buffer | null);
    saveToAgentAttachmentsMock.mockImplementation(async () => audioPath);
    transcribeAudioMock.mockImplementation(async () => ({ text: "fala transcrita" }));

    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(
      consumer,
      "message.received.whatsapp-baileys.instance-1",
      {
        id: "evt-audio",
        type: "message.received",
        payload: {
          externalId: "msg-audio",
          chatId: "120363424772797713@g.us",
          from: "5511947879044@s.whatsapp.net",
          content: {
            type: "audio",
            mediaUrl: "https://omni.local/media/msg-audio",
            mimeType: "audio/ogg; codecs=opus",
          },
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
      },
      noopHooks({ loadMedia }),
    );

    expect(loadMedia).toHaveBeenCalledTimes(1);
    expect(loadMedia.mock.calls[0]?.[0]).toMatchObject({
      type: "message.received",
      instanceId: "instance-1",
      payload: { externalId: "msg-audio", chatId: "120363424772797713@g.us" },
    });
    expect(loadMedia.mock.calls[0]?.[1]).toEqual({ maxBytes: 16 * 1024 * 1024, mimeType: "audio/ogg; codecs=opus" });
    expect(saveToAgentAttachmentsMock).toHaveBeenCalledWith(
      audioBuffer,
      agentCwd,
      "msg-audio",
      "audio/ogg; codecs=opus",
    );
    expect(transcribeAudioMock).toHaveBeenCalledWith(audioBuffer, "audio/ogg; codecs=opus");
    expect(promptCalls).toHaveLength(1);
    const [, prompt] = promptCalls[0];
    expect(prompt.prompt).toContain("[Audio]\nTranscript:\nfala transcrita");
    expect(prompt.prompt).toContain(`file: ${audioPath}`);
    expect(messageMetaSaveCalls.at(-1)).toMatchObject([
      "msg-audio",
      "120363424772797713@g.us",
      {
        transcription: "fala transcrita",
        mediaPath: audioPath,
        mediaType: "audio",
      },
    ]);
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
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
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
    const consumer = new ChannelInboundPipeline(sender as never, {
      resolveGroupMetadata: async () => null,
    });

    await receive(consumer, "message.received.whatsapp-baileys.instance-1", {
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

  describe("sources, transports and hooks", () => {
    const subject = "message.received.whatsapp-baileys.instance-1";

    function createSender() {
      return {
        send: mock(async () => {}),
        sendTyping: mock(async () => {}),
        markRead: mock(async () => {}),
      };
    }

    function groupMessageEvent(id: string, timestamp: number, content?: Record<string, unknown>): SubjectEnvelope {
      return {
        id: `evt-${id}`,
        type: "message.received",
        payload: {
          externalId: id,
          chatId: "120363424772797713@g.us",
          from: "178035101794451",
          content: content ?? { type: "text", text: "oi do transporte" },
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
        timestamp,
      };
    }

    it("runs WhatsApp and legacy-bridge events through the same pipeline (only provenance differs)", async () => {
      const timestamp = Date.now();
      const pipeline = new ChannelInboundPipeline(createSender() as never, {
        resolveGroupMetadata: async () => null,
      });
      await pipeline.handle(
        inboundEventFromSubject(subject, groupMessageEvent("msg-omni", timestamp), "omni"),
        noopHooks(),
      );
      await pipeline.handle(
        inboundEventFromSubject(subject, groupMessageEvent("msg-whatsapp", timestamp), "whatsapp"),
        noopHooks(),
      );

      expect(promptCalls).toHaveLength(2);
      const [omniSession, omniPrompt] = promptCalls[0];
      const [whatsappSession, whatsappPrompt] = promptCalls[1];
      expect(whatsappSession).toBe(omniSession);
      expect(String(whatsappPrompt.prompt).replaceAll("msg-whatsapp", "msg-omni")).toBe(String(omniPrompt.prompt));
      expect(whatsappPrompt.context).toMatchObject({
        channelId: "whatsapp-baileys",
        accountId: "main",
        instanceId: "instance-1",
        chatId: "120363424772797713@g.us",
        messageId: "msg-whatsapp",
        senderPhone: "5511947879044",
        isGroup: true,
      });
      expect(chatMessageCalls.map((call) => call.providerMessageId)).toEqual(["msg-omni", "msg-whatsapp"]);
      expect(chatMessageCalls.map((call) => (call.rawProvenance as { source?: string }).source)).toEqual([
        "omni.message.received",
        "whatsapp.message.received",
      ]);
    });

    it("writes eventType on the received trace, and omniType only for the legacy bridge", async () => {
      const pipeline = new ChannelInboundPipeline(createSender() as never, {
        resolveGroupMetadata: async () => null,
      });
      await pipeline.handle(
        inboundEventFromSubject(subject, groupMessageEvent("msg-trace-wa", Date.now()), "whatsapp"),
        noopHooks(),
      );
      await pipeline.handle(
        inboundEventFromSubject(subject, groupMessageEvent("msg-trace-omni", Date.now()), "omni"),
        noopHooks(),
      );

      const payloads = channelMessageTraceCalls.map((call) => call.payloadJson as Record<string, unknown>);
      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toMatchObject({ eventType: "message.received", subject });
      expect(payloads[0]).not.toHaveProperty("omniType");
      expect(payloads[1]).toMatchObject({ eventType: "message.received", omniType: "message.received" });
    });

    it("persists history-sync messages without replaying them to runtime", async () => {
      contactIntakeMode = "pending";
      const pipeline = new ChannelInboundPipeline(createSender() as never, {
        resolveGroupMetadata: async () => null,
      });

      await receive(pipeline, subject, {
        id: "evt-native-history",
        type: "message.received",
        payload: {
          externalId: "msg-native-history",
          chatId: "5511999904321@s.whatsapp.net",
          from: "5511999904321",
          content: { type: "text", text: "mensagem antiga" },
          rawPayload: { pushName: "Lead", resolvedSenderPhone: "5511999904321", isGroup: false },
        },
        metadata: {
          instanceId: "instance-1",
          channelType: "whatsapp-baileys",
          ingestMode: "history-sync",
        },
        timestamp: Date.now(),
      });

      expect(chatMessageCalls).toHaveLength(1);
      expect(chatMessageCalls[0]).toMatchObject({
        providerMessageId: "msg-native-history",
        rawProvenance: { ingestMode: "history-sync" },
      });
      expect(chatParticipantCalls).toHaveLength(1);
      expect(ensureContactFromInboundCalls).toHaveLength(1);
      expect(ensureContactFromInboundCalls[0]).toMatchObject({
        profileData: { source: "whatsapp.message.received" },
        provenance: { providerChannelType: "whatsapp-baileys" },
      });
      expect(promptCalls).toHaveLength(0);
    });

    it("relays WhatsApp QR codes and connected events on the WhatsApp pairing topics", async () => {
      const { nats: mockedNats } = await import("../../nats.js");
      const emit = mockedNats.emit as unknown as ReturnType<typeof mock>;
      emit.mockClear();
      const pipeline = new ChannelInboundPipeline(createSender() as never);

      await receive(pipeline, "instance.qr_code.whatsapp-baileys.instance-1", {
        id: "evt-native-qr",
        type: "instance.qr_code",
        payload: { qrCode: "QR-DATA", expiresAt: 1 },
        timestamp: Date.now(),
      });
      await receive(pipeline, "instance.connected.whatsapp-baileys.instance-1", {
        id: "evt-native-connected",
        type: "instance.connected",
        payload: { profileName: "Ravi Native", ownerIdentifier: "5511000000000@s.whatsapp.net" },
        timestamp: Date.now(),
      });
      // Disconnections are accepted and ignored.
      await receive(pipeline, "instance.disconnected.whatsapp-baileys.instance-1", {
        id: "evt-native-disconnected",
        type: "instance.disconnected",
        payload: { willReconnect: true },
        timestamp: Date.now(),
      });

      expect(emit).toHaveBeenCalledWith("ravi.whatsapp.qr.instance-1", {
        type: "qr",
        instanceId: "instance-1",
        qr: "QR-DATA",
        channelType: "whatsapp-baileys",
      });
      expect(emit).toHaveBeenCalledWith(
        "ravi.whatsapp.connected.instance-1",
        expect.objectContaining({ type: "connected", profileName: "Ravi Native" }),
      );
      expect(emit).toHaveBeenCalledTimes(2);
      expect(agentPlatformIdentityCalls[0]).toMatchObject({
        agentId: "main",
        instanceId: "instance-1",
        platformUserId: "5511000000000@s.whatsapp.net",
        profileData: { source: "whatsapp.instance.connected" },
        linkReason: "whatsapp_instance_connected",
      });
    });

    it("relays legacy-bridge QR codes on the bridge pairing topics", async () => {
      const { nats: mockedNats } = await import("../../nats.js");
      const emit = mockedNats.emit as unknown as ReturnType<typeof mock>;
      emit.mockClear();
      const pipeline = new ChannelInboundPipeline(createSender() as never);

      await receive(pipeline, "instance.qr_code.telegram.instance-1", {
        id: "evt-tg-qr",
        type: "instance.qr_code",
        payload: { instanceId: "instance-1", channelType: "telegram", qrCode: "TG-QR", expiresAt: 1 },
        timestamp: Date.now(),
      });

      expect(emit).toHaveBeenCalledWith("ravi.bridge.qr.instance-1", {
        type: "qr",
        instanceId: "instance-1",
        qr: "TG-QR",
        channelType: "telegram",
      });
    });

    it("loads file:// media with the WhatsApp local media loader", async () => {
      const mediaRoot = join(stateDir as string, "media");
      const mediaDir = join(mediaRoot, "whatsapp", "instance-1", "2026-10");
      mkdirSync(mediaDir, { recursive: true });
      const mediaPath = join(mediaDir, "msg-native-image.jpg");
      writeFileSync(mediaPath, Buffer.from("jpeg-bytes"));
      const attachmentPath = join(agentCwd, "attachments", "msg-native-image.jpg");
      saveToAgentAttachmentsMock.mockImplementation(async () => attachmentPath);

      const pipeline = new ChannelInboundPipeline(createSender() as never, {
        resolveGroupMetadata: async () => null,
      });
      await receive(
        pipeline,
        subject,
        groupMessageEvent("msg-native-image", Date.now(), {
          type: "image",
          text: "legenda",
          mediaUrl: `file://${mediaPath}`,
          localPath: mediaPath,
          mimeType: "image/jpeg",
        }),
        noopHooks({ loadMedia: createLocalMediaLoader([mediaRoot]) }),
      );

      expect(saveToAgentAttachmentsMock).toHaveBeenCalledWith(
        Buffer.from("jpeg-bytes"),
        agentCwd,
        "msg-native-image",
        "image/jpeg",
      );
      expect(promptCalls).toHaveLength(1);
      expect(String(promptCalls[0]?.[1].prompt)).toContain(attachmentPath);
    });

    it("transcribes WhatsApp audio read from an absolute localPath", async () => {
      const mediaRoot = join(stateDir as string, "media");
      mkdirSync(mediaRoot, { recursive: true });
      const audioPath = join(mediaRoot, "voice.ogg");
      writeFileSync(audioPath, Buffer.from("ogg-bytes"));
      saveToAgentAttachmentsMock.mockImplementation(async () => join(agentCwd, "attachments", "voice.ogg"));
      transcribeAudioMock.mockImplementation(async () => ({ text: "audio nativo" }));

      const pipeline = new ChannelInboundPipeline(createSender() as never, {
        resolveGroupMetadata: async () => null,
      });
      await receive(
        pipeline,
        subject,
        groupMessageEvent("msg-native-audio", Date.now(), {
          type: "audio",
          localPath: audioPath,
          mimeType: "audio/ogg; codecs=opus",
          isVoiceNote: true,
        }),
        noopHooks({ loadMedia: createLocalMediaLoader([mediaRoot]) }),
      );

      expect(transcribeAudioMock).toHaveBeenCalledWith(Buffer.from("ogg-bytes"), "audio/ogg; codecs=opus");
      expect(String(promptCalls[0]?.[1].prompt)).toContain("Transcript:\naudio nativo");
    });

    it("refuses file:// media outside the Ravi media root", async () => {
      const mediaRoot = join(stateDir as string, "media");
      mkdirSync(mediaRoot, { recursive: true });
      mkdirSync(agentCwd, { recursive: true });
      const secretPath = join(agentCwd, "secret.txt");
      writeFileSync(secretPath, "do not copy");

      const pipeline = new ChannelInboundPipeline(createSender() as never, {
        resolveGroupMetadata: async () => null,
      });
      await receive(
        pipeline,
        subject,
        groupMessageEvent("msg-native-escape", Date.now(), {
          type: "document",
          mediaUrl: `file://${secretPath}`,
          mimeType: "text/plain",
        }),
        noopHooks({ loadMedia: createLocalMediaLoader([mediaRoot]) }),
      );

      expect(saveToAgentAttachmentsMock).not.toHaveBeenCalled();
    });

    it("does not call the media hook for text or media-less messages", async () => {
      const loadMedia = mock(async () => Buffer.from("x") as Buffer | null);
      const pipeline = new ChannelInboundPipeline(createSender() as never, {
        resolveGroupMetadata: async () => null,
      });
      await receive(pipeline, subject, groupMessageEvent("msg-text", Date.now()), noopHooks({ loadMedia }));
      await receive(
        pipeline,
        subject,
        groupMessageEvent("msg-no-media", Date.now(), { type: "image", text: "sem arquivo" }),
        noopHooks({ loadMedia }),
      );

      expect(loadMedia).not.toHaveBeenCalled();
      expect(promptCalls).toHaveLength(2);
    });

    it("passes the source's group metadata fetcher to the group metadata resolver", async () => {
      const resolveInputs: Array<Record<string, unknown>> = [];
      const resolveGroupMetadata = async (input: unknown) => {
        resolveInputs.push(input as Record<string, unknown>);
        return null;
      };
      const pipeline = new ChannelInboundPipeline(createSender() as never, { resolveGroupMetadata });
      const fetcher = mock(async () => null);

      await receive(
        pipeline,
        subject,
        groupMessageEvent("msg-fetcher-group", Date.now()),
        noopHooks({ fetchGroupMetadata: fetcher }),
      );
      await receive(pipeline, subject, groupMessageEvent("msg-cache-group", Date.now()), noopHooks());

      expect(resolveInputs).toHaveLength(2);
      expect(resolveInputs[0]).toMatchObject({
        accountId: "main",
        instanceId: "instance-1",
        chatId: "120363424772797713@g.us",
        channel: "whatsapp-baileys",
      });
      expect(resolveInputs[0]?.fetcher).toBe(fetcher);
      expect(resolveInputs[1]?.fetcher).toBeNull();
    });
  });
});
