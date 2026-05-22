import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeAbortProvenance } from "../runtime/session-dispatcher.js";
import type { MessageMetadata } from "../router/router-db.js";

const actualRouterDbModule = await import("../router/router-db.js");
const actualRouterIndexModule = await import("../router/index.js");
const actualRouterSessionsModule = await import("../router/sessions.js");
const actualChatDbModule = await import("../db.js");
const actualDbSaveMessageMeta = actualRouterDbModule.dbSaveMessageMeta;
const actualDbGetMessageMeta = actualRouterDbModule.dbGetMessageMeta;
const actualDbUpsertChat = actualRouterDbModule.dbUpsertChat;
const actualDbUpsertChatMessage = actualRouterDbModule.dbUpsertChatMessage;
const actualDbUpsertChatParticipant = actualRouterDbModule.dbUpsertChatParticipant;
const actualDbBindSessionToChat = actualRouterDbModule.dbBindSessionToChat;
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
let stateDir: string | null = null;
let agentCwd = "/tmp/ravi-agent";
let contactIntakeMode: "off" | "discovered" | "pending" = "off";
let routeResult: Record<string, unknown> | null = null;

function defaultRouteResult(): Record<string, unknown> {
  return {
    sessionKey: "agent:main:whatsapp:main:group:120363424772797713",
    sessionName: "dev",
    dmScope: "main",
    route: { pattern: "group:120363424772797713", priority: 0, session: "dev" },
    agent: {
      id: "main",
      cwd: agentCwd,
      mode: "active",
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

// Note: we intentionally do NOT override `matchRoute` here. Overriding a
// re-exported symbol in `../router/index.js` leaks into direct imports
// from `../router/resolver.js` (a bun quirk where the live binding is
// mutated in place), which would break `resolver.test.ts`. Instead we
// fix the config so the real `matchRoute` returns a valid match, and
// only override `commitMatchedRoute` to inject the test's routeResult.
mock.module("../router/index.js", () => ({
  ...actualRouterIndexModule,
  expandHome: (cwd: string) => cwd,
  commitMatchedRoute: () => routeResult,
}));

mock.module("../config-store.js", () => ({
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
      routes: [],
      agents: {
        main: {
          id: "main",
          cwd: agentCwd,
          dmScope: "main",
          mode: "active",
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
      accountAgents: routeResult ? { main: "main" } : {},
      ignoredOmniInstanceIds: [],
    }),
  },
}));

mock.module("../contacts.js", () => ({
  isContactAllowedForAgent: () => true,
  saveAccountPending: () => false,
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

mock.module("../router/router-db.js", () => ({
  ...actualRouterDbModule,
  dbSaveMessageMeta: mock((messageId: string, chatId: string, opts: Record<string, unknown>) => {
    messageMetaSaveCalls.push([messageId, chatId, opts]);
    return actualDbSaveMessageMeta(messageId, chatId, opts);
  }),
  dbGetMessageMeta: mock((messageId: string) => messageMetaById.get(messageId) ?? actualDbGetMessageMeta(messageId)),
  dbUpsertChat: mock((input: Parameters<typeof actualDbUpsertChat>[0]) => actualDbUpsertChat(input)),
  dbUpsertChatMessage: mock((input: Parameters<typeof actualDbUpsertChatMessage>[0]) => {
    chatMessageCalls.push(input);
    return actualDbUpsertChatMessage(input);
  }),
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
  recordRouteRejectedTrace: mock(() => ({})),
  recordRouteResolvedTrace: mock(() => ({})),
}));

mock.module("../session-trace/runtime-trace.js", () => ({
  recordRuntimeTraceEvent: mock(() => ({})),
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
    agentCwd = join(stateDir, "agent");
    routeResult = defaultRouteResult();
    contactIntakeMode = "off";
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

  it("renders inbound WhatsApp numeric mention placeholders as mentioned contact names", async () => {
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
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

  it("renders attached input origin hints with attach-as-output guidance", async () => {
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
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
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
    expect(prompt.prompt).toContain(
      `[origin] inbound veio de ${inputChat?.id} (subscription da sessão "dev"). Este chat já está atachado como input.`,
    );
    expect(prompt.prompt).toContain("Para fazer respostas saírem neste chat");
    expect(prompt.prompt).not.toContain("ravi sessions focus");
  });

  it("stores inbound DM messages and runs contact intake before no-route return", async () => {
    routeResult = null;
    contactIntakeMode = "pending";
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
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
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
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

  it("captures old timestamp messages without replaying them to runtime", async () => {
    contactIntakeMode = "pending";
    const sender = {
      send: mock(async () => {}),
      sendTyping: mock(async () => {}),
      markRead: mock(async () => {}),
    };
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
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
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
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

  it("resets the runtime session and republishes an Omni message edit as a rebase replay", async () => {
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
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
      abortRuntimeSession,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
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
      source: "omni",
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
    expect(prompt.prompt).toContain("## Mensagem editada detectada pelo Omni");
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
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
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
    const consumer = new OmniConsumer(sender as never, "http://omni.local", "test-key", {
      resolveGroupMetadata: async () => null,
    });

    await consumer["handleMessageEvent"]("message.received.whatsapp-baileys.instance-1", {
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
