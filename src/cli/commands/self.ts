/**
 * Self Commands - read-only orientation for the current agent/session context.
 */

import "reflect-metadata";
import { Command, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import {
  declareCommandReturns,
  selfContextReturnSchema,
  selfExplainReturnSchema,
  selfSectionOnlyReturnSchema,
  selfWhoamiReturnSchema,
} from "./operational-return-schemas.js";
import { RAVI_CONTEXT_KEY_ENV, resolveRuntimeContextOrThrow } from "../../runtime/context-registry.js";
import { resolveSession } from "../../router/sessions.js";
import type { RouteConfig, SessionEntry } from "../../router/types.js";
import {
  dbGetChat,
  dbGetRouteById,
  dbGetSessionChatBinding,
  dbListChatParticipants,
  dbListMessageMetaByChatId,
  dbListRoutesBySessionName,
  type ChatParticipantRecord,
  type ChatRecord,
  type ContextCapability,
  type ContextRecord,
  type MessageMetadata,
  type SessionChatBindingRecord,
} from "../../router/router-db.js";

type SectionStatus = "ok" | "partial" | "missing" | "unavailable";
type SelfDepth = "summary" | "normal" | "full";

interface SelfSection<T> {
  status: SectionStatus;
  reason?: string;
  data?: T;
}

interface SelfContextSummary {
  contextId: string;
  kind: string;
  agentId: string | null;
  sessionKey: string | null;
  sessionName: string | null;
  source: ContextRecord["source"] | null;
  metadata: Record<string, unknown> | null;
  capabilitiesCount: number;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface SelfSessionSummary {
  sessionKey: string;
  name: string | null;
  agentId: string;
  agentCwd: string;
  runtimeProvider: string | null;
  runtimeSessionDisplayId: string | null;
  modelOverride: string | null;
  thinkingLevel: string | null;
  channel: string | null;
  accountId: string | null;
  chatType: string | null;
  displayName: string | null;
  subject: string | null;
  lastTarget: {
    channel: string | null;
    accountId: string | null;
    chatId: string | null;
    threadId: string | null;
  };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    contextTokens: number | null;
    compactionCount: number | null;
  };
  updatedAt: number;
  createdAt: number;
  ephemeral: boolean;
  expiresAt: number | null;
}

interface SelfChatSummary {
  binding: {
    sessionKey: string;
    chatId: string;
    routeId: number | null;
    bindingReason: string | null;
    updatedAt: number;
  } | null;
  chat: {
    id: string;
    channel: string;
    instanceId: string;
    platformChatId: string;
    normalizedChatId: string;
    chatType: string;
    title: string | null;
    firstSeenAt: number;
    lastSeenAt: number;
    updatedAt: number;
  } | null;
  sourceFallback: ContextRecord["source"] | null;
  participants?: Array<{
    id: string;
    participantType: string;
    contactId: string | null;
    agentId: string | null;
    platformIdentityId: string | null;
    rawPlatformUserId: string | null;
    role: string;
    status: string;
    source: string;
    lastSeenAt: number;
  }>;
}

interface SelfRouteSummary {
  boundRoute: SerializedRoute | null;
  sessionRoutes: SerializedRoute[];
}

interface SerializedRoute {
  id: number;
  pattern: string;
  accountId: string;
  agent: string;
  dmScope: string | null;
  session: string | null;
  priority: number;
  policy: string | null;
  channel: string | null;
}

interface SelfRecentSummary {
  limit: number;
  sourceChatId: string | null;
  messages: Array<{
    messageId: string;
    chatId: string;
    canonicalChatId: string | null;
    actorType: string | null;
    contactId: string | null;
    agentId: string | null;
    platformIdentityId: string | null;
    mediaType: string | null;
    hasTranscription: boolean;
    createdAt: number;
  }>;
}

interface SelfPermissionsSummary {
  capabilities: ContextCapability[];
  count: number;
  byPermission: Record<string, number>;
  byObjectType: Record<string, number>;
}

interface SelfKnowledgeSummary {
  status: "not_implemented";
  specIds: string[];
  expectedCommandFamily: string;
}

interface SelfExplainStep {
  step: string;
  status: SectionStatus;
  detail: string;
}

interface SelfContextPacket {
  generatedAt: number;
  depth: SelfDepth;
  limit: number;
  identity: SelfContextSummary;
  session: SelfSection<SelfSessionSummary>;
  chat: SelfSection<SelfChatSummary>;
  route: SelfSection<SelfRouteSummary>;
  recent: SelfSection<SelfRecentSummary>;
  permissions: SelfSection<SelfPermissionsSummary>;
  knowledge: SelfSection<SelfKnowledgeSummary>;
  explain: SelfExplainStep[];
  nextReads: string[];
}

@Group({
  name: "self",
  description: "Read the current Ravi agent/session/chat context",
  scope: "open",
})
export class SelfCommands {
  @Command({ name: "whoami", description: "Show the current agent/session identity" })
  whoami(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    const packet = this.buildPacket({ depth: "summary", limit: 5 });
    const payload = {
      generatedAt: packet.generatedAt,
      identity: packet.identity,
      session: packet.session,
      chat: packet.chat,
      route: packet.route,
      nextReads: packet.nextReads,
    };
    this.printPayload(payload, asJson, () => this.printWhoami(packet));
    return payload;
  }

  @Command({ name: "context", description: "Show the full current self-context packet" })
  context(
    @Option({ flags: "--depth <depth>", description: "Depth: summary, normal, or full" }) depth?: string,
    @Option({ flags: "--limit <limit>", description: "Maximum recent messages to inspect" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const packet = this.buildPacket({ depth: parseDepth(depth), limit: parseLimit(limit, 10) });
    this.printPayload(packet, asJson, () => this.printContext(packet));
    return packet;
  }

  @Command({ name: "chat", description: "Show the current chat binding and participants" })
  chat(
    @Option({ flags: "--depth <depth>", description: "Depth: summary, normal, or full" }) depth?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const packet = this.buildPacket({ depth: parseDepth(depth), limit: 5 });
    const payload = packet.chat;
    this.printPayload(payload, asJson, () => this.printSection("Chat", packet.chat));
    return payload;
  }

  @Command({ name: "route", description: "Show route information that led to the current session" })
  route(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    const packet = this.buildPacket({ depth: "normal", limit: 5 });
    const payload = packet.route;
    this.printPayload(payload, asJson, () => this.printSection("Route", packet.route));
    return payload;
  }

  @Command({ name: "recent", description: "Show bounded recent message metadata for the current chat" })
  recent(
    @Option({ flags: "--limit <limit>", description: "Maximum recent messages to inspect" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const packet = this.buildPacket({ depth: "normal", limit: parseLimit(limit, 10) });
    const payload = packet.recent;
    this.printPayload(payload, asJson, () => this.printSection("Recent", packet.recent));
    return payload;
  }

  @Command({ name: "permissions", description: "Show capabilities inherited by the current context" })
  permissions(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    const packet = this.buildPacket({ depth: "summary", limit: 5 });
    const payload = packet.permissions;
    this.printPayload(payload, asJson, () => this.printSection("Permissions", packet.permissions));
    return payload;
  }

  @Command({ name: "knowledge", description: "Show current knowledge integration status for this context" })
  knowledge(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    const packet = this.buildPacket({ depth: "summary", limit: 5 });
    const payload = packet.knowledge;
    this.printPayload(payload, asJson, () => this.printSection("Knowledge", packet.knowledge));
    return payload;
  }

  @Command({ name: "explain", description: "Explain how Ravi resolved the current self-context" })
  explain(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    const packet = this.buildPacket({ depth: "full", limit: 5 });
    const payload = {
      generatedAt: packet.generatedAt,
      explain: packet.explain,
      nextReads: packet.nextReads,
    };
    this.printPayload(payload, asJson, () => {
      console.log("\nSelf Resolution\n");
      for (const step of packet.explain) {
        console.log(`- ${step.step}: ${step.status} - ${step.detail}`);
      }
    });
    return payload;
  }

  private buildPacket(options: { depth: SelfDepth; limit: number }): SelfContextPacket {
    const context = this.requireResolvedContext();
    const session = this.resolveCurrentSession(context);
    const binding = session.data ? dbGetSessionChatBinding(session.data.sessionKey) : null;
    const chatRecord = binding ? dbGetChat(binding.chatId) : null;
    const route = this.buildRouteSection(session.data, binding);
    const chat = this.buildChatSection(context, binding, chatRecord, options.depth);
    const recent = this.buildRecentSection(context, binding, chatRecord, options.limit);
    const permissions = this.buildPermissionsSection(context);
    const knowledge = this.buildKnowledgeSection();
    const sessionSection: SelfSection<SelfSessionSummary> =
      session.status === "ok" && session.data
        ? { status: "ok", data: serializeSession(session.data) }
        : { status: session.status, reason: session.reason };

    const packet: SelfContextPacket = {
      generatedAt: Date.now(),
      depth: options.depth,
      limit: options.limit,
      identity: serializeContext(context),
      session: sessionSection,
      chat,
      route,
      recent,
      permissions,
      knowledge,
      explain: [],
      nextReads: [
        "ravi self context --json",
        "ravi self recent --limit 20 --json",
        "ravi context capabilities --json",
        "ravi sessions info <session>",
      ],
    };

    packet.explain = buildExplainSteps({ context, session: packet.session, chat, route, recent, knowledge });
    return packet;
  }

  private requireResolvedContext(): ContextRecord {
    const inlineContext = getContext()?.context;
    if (inlineContext) return inlineContext;

    const contextKey = process.env[RAVI_CONTEXT_KEY_ENV];
    if (!contextKey) {
      fail(`Missing ${RAVI_CONTEXT_KEY_ENV}`);
    }

    try {
      return resolveRuntimeContextOrThrow(contextKey, { touch: false, readOnly: true });
    } catch (error) {
      fail(`Failed to resolve context: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private resolveCurrentSession(context: ContextRecord): SelfSection<SessionEntry> {
    const candidates = [context.sessionKey, context.sessionName].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      const session = resolveSession(candidate);
      if (session) return { status: "ok", data: session };
    }

    if (candidates.length === 0) {
      return { status: "missing", reason: "current context has no session key/name" };
    }
    return { status: "missing", reason: `session not found for ${candidates.join(" / ")}` };
  }

  private buildChatSection(
    context: ContextRecord,
    binding: SessionChatBindingRecord | null,
    chat: ChatRecord | null,
    depth: SelfDepth,
  ): SelfSection<SelfChatSummary> {
    if (!binding && !context.source) {
      return { status: "missing", reason: "no canonical chat binding or source context found" };
    }

    const data: SelfChatSummary = {
      binding: binding
        ? {
            sessionKey: binding.sessionKey,
            chatId: binding.chatId,
            routeId: binding.routeId ?? null,
            bindingReason: binding.bindingReason ?? null,
            updatedAt: binding.updatedAt,
          }
        : null,
      chat: chat ? serializeChat(chat) : null,
      sourceFallback: context.source ?? null,
    };

    if (depth === "full" && binding) {
      data.participants = dbListChatParticipants(binding.chatId).map(serializeChatParticipant);
    }

    if (binding && !chat) {
      return { status: "partial", reason: `chat binding points to missing chat ${binding.chatId}`, data };
    }
    return { status: binding ? "ok" : "partial", reason: binding ? undefined : "using source fallback only", data };
  }

  private buildRouteSection(
    session: SessionEntry | undefined,
    binding: SessionChatBindingRecord | null,
  ): SelfSection<SelfRouteSummary> {
    if (!session && !binding?.routeId) {
      return { status: "missing", reason: "no session or route binding available" };
    }

    const boundRoute = binding?.routeId ? dbGetRouteById(binding.routeId) : null;
    const sessionRoutes = session?.name ? dbListRoutesBySessionName(session.name) : [];
    return {
      status: boundRoute || sessionRoutes.length > 0 ? "ok" : "missing",
      reason: boundRoute || sessionRoutes.length > 0 ? undefined : "no route is explicitly bound to this session",
      data: {
        boundRoute: boundRoute ? serializeRoute(boundRoute) : null,
        sessionRoutes: sessionRoutes.map(serializeRoute),
      },
    };
  }

  private buildRecentSection(
    context: ContextRecord,
    binding: SessionChatBindingRecord | null,
    chat: ChatRecord | null,
    limit: number,
  ): SelfSection<SelfRecentSummary> {
    const chatId = binding?.chatId ?? chat?.id ?? context.source?.chatId ?? null;
    if (!chatId) {
      return { status: "missing", reason: "no chat id available for recent message lookup" };
    }

    const messages = dbListMessageMetaByChatId(chatId, limit).map(serializeMessageMetadata);
    return {
      status: messages.length > 0 ? "ok" : "partial",
      reason: messages.length > 0 ? undefined : "no recent message metadata found for this chat id",
      data: {
        limit,
        sourceChatId: chatId,
        messages,
      },
    };
  }

  private buildPermissionsSection(context: ContextRecord): SelfSection<SelfPermissionsSummary> {
    return {
      status: "ok",
      data: {
        capabilities: context.capabilities,
        count: context.capabilities.length,
        byPermission: countBy(context.capabilities, (capability) => capability.permission),
        byObjectType: countBy(context.capabilities, (capability) => capability.objectType),
      },
    };
  }

  private buildKnowledgeSection(): SelfSection<SelfKnowledgeSummary> {
    return {
      status: "unavailable",
      reason: "knowledge specs exist, but the knowledge runtime/CLI has not been implemented yet",
      data: {
        status: "not_implemented",
        specIds: ["knowledge", "knowledge/threads", "knowledge/profiles", "knowledge/publishers"],
        expectedCommandFamily: "ravi knowledge",
      },
    };
  }

  private printPayload(payload: unknown, asJson: boolean, printer: () => void): void {
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    printer();
  }

  private printWhoami(packet: SelfContextPacket): void {
    console.log("\nRavi Self\n");
    console.log(`Agent: ${packet.identity.agentId ?? "-"}`);
    console.log(`Session: ${packet.identity.sessionName ?? packet.identity.sessionKey ?? "-"}`);
    console.log(`Context: ${packet.identity.contextId} (${packet.identity.kind})`);
    console.log(`Source: ${formatSource(packet.identity.source)}`);
    console.log(
      `Chat: ${formatSectionRef(packet.chat, (data) => data.chat?.title ?? data.chat?.id ?? data.binding?.chatId ?? "-")}`,
    );
    console.log(
      `Route: ${formatSectionRef(packet.route, (data) => data.boundRoute?.pattern ?? data.sessionRoutes[0]?.pattern ?? "-")}`,
    );
  }

  private printContext(packet: SelfContextPacket): void {
    this.printWhoami(packet);
    this.printSection("Session", packet.session);
    this.printSection("Chat", packet.chat);
    this.printSection("Route", packet.route);
    this.printSection("Recent", packet.recent);
    this.printSection("Permissions", packet.permissions);
    this.printSection("Knowledge", packet.knowledge);
    console.log("\nNext Reads");
    for (const command of packet.nextReads) {
      console.log(`- ${command}`);
    }
  }

  private printSection<T>(name: string, section: SelfSection<T>): void {
    console.log(`\n${name}: ${section.status}${section.reason ? ` (${section.reason})` : ""}`);
    if (!section.data) return;
    console.log(JSON.stringify(section.data, null, 2));
  }
}

declareCommandReturns(SelfCommands, {
  chat: selfSectionOnlyReturnSchema,
  context: selfContextReturnSchema,
  explain: selfExplainReturnSchema,
  knowledge: selfSectionOnlyReturnSchema,
  permissions: selfSectionOnlyReturnSchema,
  recent: selfSectionOnlyReturnSchema,
  route: selfSectionOnlyReturnSchema,
  whoami: selfWhoamiReturnSchema,
});

function parseDepth(value: string | undefined): SelfDepth {
  if (!value) return "normal";
  if (value === "summary" || value === "normal" || value === "full") return value;
  fail(`Invalid --depth: ${value}. Expected summary, normal, or full.`);
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    fail(`Invalid --limit: ${value}. Expected integer between 1 and 100.`);
  }
  return parsed;
}

function serializeContext(context: ContextRecord): SelfContextSummary {
  return {
    contextId: context.contextId,
    kind: context.kind,
    agentId: context.agentId ?? null,
    sessionKey: context.sessionKey ?? null,
    sessionName: context.sessionName ?? null,
    source: context.source ?? null,
    metadata: context.metadata ? redactSensitiveMetadata(context.metadata) : null,
    capabilitiesCount: context.capabilities.length,
    createdAt: context.createdAt,
    expiresAt: context.expiresAt ?? null,
    lastUsedAt: context.lastUsedAt ?? null,
    revokedAt: context.revokedAt ?? null,
  };
}

function serializeSession(session: SessionEntry): SelfSessionSummary {
  return {
    sessionKey: session.sessionKey,
    name: session.name ?? null,
    agentId: session.agentId,
    agentCwd: session.agentCwd,
    runtimeProvider: session.runtimeProvider ?? null,
    runtimeSessionDisplayId: session.runtimeSessionDisplayId ?? null,
    modelOverride: session.modelOverride ?? null,
    thinkingLevel: session.thinkingLevel ?? null,
    channel: session.channel ?? null,
    accountId: session.accountId ?? null,
    chatType: session.chatType ?? null,
    displayName: session.displayName ?? null,
    subject: session.subject ?? null,
    lastTarget: {
      channel: session.lastChannel ?? null,
      accountId: session.lastAccountId ?? null,
      chatId: session.lastTo ?? null,
      threadId: session.lastThreadId ?? null,
    },
    usage: {
      inputTokens: session.inputTokens ?? null,
      outputTokens: session.outputTokens ?? null,
      totalTokens: session.totalTokens ?? null,
      contextTokens: session.contextTokens ?? null,
      compactionCount: session.compactionCount ?? null,
    },
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    ephemeral: session.ephemeral ?? false,
    expiresAt: session.expiresAt ?? null,
  };
}

function serializeChat(chat: ChatRecord): SelfChatSummary["chat"] {
  return {
    id: chat.id,
    channel: chat.channel,
    instanceId: chat.instanceId,
    platformChatId: chat.platformChatId,
    normalizedChatId: chat.normalizedChatId,
    chatType: chat.chatType,
    title: chat.title ?? null,
    firstSeenAt: chat.firstSeenAt,
    lastSeenAt: chat.lastSeenAt,
    updatedAt: chat.updatedAt,
  };
}

function serializeChatParticipant(participant: ChatParticipantRecord) {
  return {
    id: participant.id,
    participantType: participant.participantType,
    contactId: participant.contactId ?? null,
    agentId: participant.agentId ?? null,
    platformIdentityId: participant.platformIdentityId ?? null,
    rawPlatformUserId: participant.rawPlatformUserId ?? null,
    role: participant.role,
    status: participant.status,
    source: participant.source,
    lastSeenAt: participant.lastSeenAt,
  };
}

function serializeRoute(route: RouteConfig & { id: number }): SerializedRoute {
  return {
    id: route.id,
    pattern: route.pattern,
    accountId: route.accountId,
    agent: route.agent,
    dmScope: route.dmScope ?? null,
    session: route.session ?? null,
    priority: route.priority ?? 0,
    policy: route.policy ?? null,
    channel: route.channel ?? null,
  };
}

function serializeMessageMetadata(message: MessageMetadata): SelfRecentSummary["messages"][number] {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    canonicalChatId: message.canonicalChatId ?? null,
    actorType: message.actorType ?? null,
    contactId: message.contactId ?? null,
    agentId: message.agentId ?? null,
    platformIdentityId: message.platformIdentityId ?? null,
    mediaType: message.mediaType ?? null,
    hasTranscription: Boolean(message.transcription?.trim()),
    createdAt: message.createdAt,
  };
}

function countBy<T>(items: T[], selector: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function redactSensitiveMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isSensitiveKey(key)) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = redactSensitiveValue(value);
  }
  return result;
}

function redactSensitiveValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(input)) {
    output[key] = isSensitiveKey(key) ? "[redacted]" : redactSensitiveValue(nested);
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  return /key|token|secret|password|credential/i.test(key);
}

function buildExplainSteps(input: {
  context: ContextRecord;
  session: SelfSection<SelfSessionSummary>;
  chat: SelfSection<SelfChatSummary>;
  route: SelfSection<SelfRouteSummary>;
  recent: SelfSection<SelfRecentSummary>;
  knowledge: SelfSection<SelfKnowledgeSummary>;
}): SelfExplainStep[] {
  return [
    {
      step: "context",
      status: "ok",
      detail: `resolved context ${input.context.contextId} without exposing its context key`,
    },
    {
      step: "session",
      status: input.session.status,
      detail: input.session.data
        ? `resolved session ${input.session.data.name ?? input.session.data.sessionKey}`
        : (input.session.reason ?? "session unavailable"),
    },
    {
      step: "chat",
      status: input.chat.status,
      detail: input.chat.data?.chat?.id ?? input.chat.reason ?? "chat unavailable",
    },
    {
      step: "route",
      status: input.route.status,
      detail:
        input.route.data?.boundRoute?.pattern ??
        input.route.data?.sessionRoutes[0]?.pattern ??
        input.route.reason ??
        "route unavailable",
    },
    {
      step: "recent",
      status: input.recent.status,
      detail:
        input.recent.data?.messages.length != null
          ? `${input.recent.data.messages.length} message metadata rows loaded`
          : (input.recent.reason ?? "recent unavailable"),
    },
    {
      step: "knowledge",
      status: input.knowledge.status,
      detail: input.knowledge.reason ?? "knowledge status unavailable",
    },
  ];
}

function formatSource(source: ContextRecord["source"] | null): string {
  if (!source) return "-";
  return `${source.channel}/${source.accountId}/${source.chatId}${source.threadId ? `#${source.threadId}` : ""}`;
}

function formatSectionRef<T>(section: SelfSection<T>, formatter: (data: T) => string): string {
  if (!section.data) return `${section.status}${section.reason ? ` (${section.reason})` : ""}`;
  return `${formatter(section.data)} [${section.status}]`;
}
