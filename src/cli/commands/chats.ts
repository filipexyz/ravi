import "reflect-metadata";
import { z } from "zod";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Scope } from "../decorators.js";
import { ContractError, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import { jsonObjectSchema, strictCliOffsetPaginationSchema } from "../return-schemas.js";
import { commandEnvelopeReturnSchema, declareCommandReturns } from "./operational-return-schemas.js";
import {
  inspectChatReadingList,
  previewChatReadingListMembers,
  recomputeChatReadingListMembers,
  type ChatReadingListInspectionResult,
  type ChatReadingListMembershipDiff,
  type ChatReadingListPreviewResult,
  type ChatReadingListRecomputeResult,
} from "../../chats/reading-lists.js";
import {
  dbAddChatToReadingList,
  dbBackfillChatMessageProviderTimestamps,
  dbCreateCanonicalActorMessage,
  dbCreateChatReadingList,
  dbEnsureActorAgentChat,
  dbFindChatByRef,
  dbFindChatReadingList,
  dbGetChat,
  dbGetChatReadingList,
  dbGetInstance,
  dbGetChatReadingDelta,
  dbListChatMessagesPage,
  dbListChatReadingListMembers,
  dbListChatReadingLists,
  dbListChats,
  dbMarkChatReadingCursor,
  dbRemoveChatFromReadingList,
  type ChatListItem,
  type ChatRecord,
  type ChatReadingDelta,
  type ChatReadingListMemberItem,
  type ChatReadingListRecord,
  type ChatMessageWithSortKey,
} from "../../router/router-db.js";
import { getContact } from "../../contacts.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

const jsonValueReturnSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueReturnSchema),
    z.record(z.string(), jsonValueReturnSchema),
  ]),
);

const chatReadingListReturnSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  ownerType: z.string(),
  ownerId: z.string(),
  visibility: z.string(),
  mode: z.string(),
  selector: z.record(z.string(), jsonValueReturnSchema).optional(),
  metadata: z.record(z.string(), jsonValueReturnSchema).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().optional(),
});

const chatReadingListPublicReturnSchema = chatReadingListReturnSchema.omit({
  selector: true,
  metadata: true,
});

const READING_LIST_ID_PATTERN_SOURCE = "^crl_[0-9a-f]{24}$";
const CHAT_ID_PATTERN_SOURCE = "^chat_[0-9a-f]{24}$";
const OPAQUE_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$";
const opaqueIdArgSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(new RegExp(OPAQUE_ID_PATTERN_SOURCE), "Must be an opaque URL-safe identifier");
const chatIdArgSchema = z
  .string()
  .regex(new RegExp(CHAT_ID_PATTERN_SOURCE), "Chat id must use the canonical chat_<24 hex> form");
const messageContentArgSchema = z.string().min(1).max(1_000_000);
const readingListIdArgSchema = z
  .string()
  .regex(new RegExp(READING_LIST_ID_PATTERN_SOURCE), "Reading-list id must use the canonical crl_<24 hex> form");

const chatReadingListRecomputeReturnSchema = z.object({
  list: chatReadingListPublicReturnSchema,
  recompute: z.object({
    list: chatReadingListPublicReturnSchema,
    added: z.number(),
    removed: z.number(),
    kept: z.number(),
    preserved: z.number(),
    eligible: z.number(),
  }),
});

const chatReadingListSelectorIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  path: z.string().optional(),
});

const chatReadingListSelectorValidationSchema = z.object({
  valid: z.boolean(),
  canApply: z.boolean(),
  riskLevel: z.enum(["low", "high"]),
  scope: z.enum(["contact", "chat"]),
  match: z.enum(["all", "any"]),
  conditions: z.object({
    total: z.number(),
    supported: z.number(),
    positive: z.number(),
    negative: z.number(),
  }),
  issues: z.array(chatReadingListSelectorIssueSchema),
});

const chatReadingListCurrentMembersSchema = z.object({
  total: z.number(),
  selector: z.number(),
  preserved: z.number(),
});

const chatReadingListMembershipDiffSchema = z.object({
  added: z.number(),
  removed: z.number(),
  kept: z.number(),
  preserved: z.number(),
  eligible: z.number(),
});

const chatReadingListShowReturnSchema = z.object({
  list: chatReadingListPublicReturnSchema,
  validation: chatReadingListSelectorValidationSchema,
  current: chatReadingListCurrentMembersSchema,
});

const chatReadingListPreviewReturnSchema = z.object({
  list: chatReadingListPublicReturnSchema,
  preview: z.object({
    list: chatReadingListPublicReturnSchema,
    dryRun: z.literal(true),
    validation: chatReadingListSelectorValidationSchema,
    current: chatReadingListCurrentMembersSchema,
    diff: chatReadingListMembershipDiffSchema.nullable(),
  }),
});

const chatReturnSchema = z
  .object({
    id: z.string(),
    channel: z.string(),
    instanceId: z.string(),
    actorId: z.string().optional(),
    agentId: z.string().optional(),
    chatType: z.enum(["dm", "group", "room", "thread", "channel", "unknown"]),
    title: z.string().optional(),
    avatarUrl: z.string().optional(),
    metadata: jsonObjectSchema.optional(),
    firstSeenAt: z.number(),
    lastSeenAt: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    platformChatId: z.string().optional(),
    normalizedChatId: z.string().optional(),
    rawProvenance: jsonObjectSchema.optional(),
  })
  .strict();

const chatMessageReturnSchema = z
  .object({
    id: z.string(),
    chatId: z.string(),
    clientMessageId: z.string().optional(),
    actorType: z.string(),
    actorId: z.string().optional(),
    contactId: z.string().optional(),
    agentId: z.string().optional(),
    platformIdentityId: z.string().optional(),
    messageType: z.string().optional(),
    content: jsonObjectSchema.optional(),
    revision: z.number().int().positive().optional(),
    state: z.string().optional(),
    providerTimestamp: z.number().optional(),
    ingestedAt: z.number(),
    sortKey: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    channel: z.string().optional(),
    instanceId: z.string().optional(),
    providerMessageId: z.string().optional(),
    rawChatId: z.string().optional(),
    rawSenderId: z.string().optional(),
    normalizedSenderId: z.string().optional(),
    rawProvenance: jsonObjectSchema.optional(),
  })
  .strict();

const chatListItemReturnSchema = z
  .object({
    chat: chatReturnSchema,
    messageCount: z.number(),
    participantCount: z.number(),
    lastMessage: chatMessageReturnSchema.nullable(),
  })
  .strict();

export const chatsListReturnSchema = z
  .object({
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema.strict(),
    items: z.array(chatListItemReturnSchema),
    chats: z.array(chatListItemReturnSchema),
  })
  .strict();

export const chatsReadReturnSchema = z
  .object({
    chat: chatReturnSchema,
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema.strict(),
    messages: z.array(chatMessageReturnSchema),
  })
  .strict();

const ensuredChatReturnSchema = chatReturnSchema.extend({
  actorId: z.string(),
  agentId: z.string(),
});

const canonicalActorMessageReturnSchema = chatMessageReturnSchema.extend({
  clientMessageId: z.string(),
  actorType: z.literal("actor"),
  actorId: z.string(),
  content: jsonObjectSchema,
  revision: z.literal(1),
  state: z.literal("created"),
});

export const chatsEnsureReturnSchema = z
  .object({
    disposition: z.enum(["created", "existing"]),
    clientRequestId: z.string(),
    chat: ensuredChatReturnSchema,
  })
  .strict();

export const chatsMessageCreateReturnSchema = z
  .object({
    disposition: z.enum(["created", "duplicate"]),
    clientMessageId: z.string(),
    messageId: z.string(),
    message: canonicalActorMessageReturnSchema,
  })
  .strict();

function summarizeCurrent(current: ChatReadingListInspectionResult["current"]) {
  return { total: current.total, selector: current.selector, preserved: current.preserved };
}

function summarizeMembershipDiff(diff: ChatReadingListMembershipDiff) {
  return {
    added: diff.added,
    removed: diff.removed,
    kept: diff.kept,
    preserved: diff.preserved,
    eligible: diff.eligible,
  };
}

function publicReadingList(list: ChatReadingListRecord) {
  const { selector: _selector, metadata: _metadata, ...safeList } = list;
  return safeList;
}

function publicInspection(inspection: ChatReadingListInspectionResult) {
  return {
    list: publicReadingList(inspection.list),
    validation: inspection.validation,
    current: summarizeCurrent(inspection.current),
  };
}

function publicPreview(preview: ChatReadingListPreviewResult) {
  return {
    list: publicReadingList(preview.list),
    dryRun: preview.dryRun,
    validation: preview.validation,
    current: summarizeCurrent(preview.current),
    diff: preview.diff ? summarizeMembershipDiff(preview.diff) : null,
  };
}

function publicRecompute(recompute: ChatReadingListRecomputeResult) {
  return {
    list: publicReadingList(recompute.list),
    ...summarizeMembershipDiff(recompute),
  };
}

function parseScopedRef(
  value: string | undefined,
  fallback: { type: string; id: string },
): { type: string; id: string } {
  const raw = value?.trim();
  if (!raw) return fallback;
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    fail("Scoped refs must use <type:id>, e.g. agent:ravi-crm or system:crm");
  }
  return { type: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

function defaultReader(): { type: string; id: string } {
  const ctx = getContext();
  return { type: "agent", id: ctx?.agentId ?? ctx?.sessionName ?? "ravi" };
}

function defaultOwner(): { type: string; id: string } {
  const ctx = getContext();
  return ctx?.agentId ? { type: "agent", id: ctx.agentId } : { type: "system", id: "ravi" };
}

function currentAgentOwner(): { type: string; id: string } | null {
  const ctx = getContext();
  return ctx?.agentId ? { type: "agent", id: ctx.agentId } : null;
}

// ============================================================
// Manual v2 contract helpers (error envelope + suggestions).
// Text mode keeps the legacy `fail()` behavior; `--json` emits the
// {success:false, error:{code, ...suggestions}} envelope. Exit taxonomy:
// 1 not-found/provider · 2 usage · 3 policy (write brake / dry-run).
//
// SCOPE NOTE: chats and reading lists are admin-scoped and fully enumerable
// through `chats list` / `chats lists list`, so suggestions built from those
// same local listings never reveal anything the caller could not already
// list. Reading-list candidates honor the same optional `--owner` filter the
// listing accepts. Contacts, however, enforce contactScope inside their own
// domain; chats cannot cheaply reproduce that filter here, so
// CONTACT_NOT_FOUND omits suggestions and points to the scoped listing.
// ============================================================

interface ContractCallSite {
  op: string;
  asJson?: boolean;
}

function failChatNotFound(op: string, chatRef: string, asJson?: boolean): never {
  const candidates = dbListChats({ limit: 40 }).items.flatMap((item) => [
    item.chat.id,
    item.chat.title,
    item.chat.normalizedChatId,
  ]);
  contractFail(op, "CHAT_NOT_FOUND", `Chat not found: ${chatRef}`, {
    asJson,
    details: {
      suggestedAction: "Check the chat ref (see suggestions; list with: ravi chats list --json)",
      suggestions: suggestSimilar(chatRef, candidates),
    },
  });
}

function failReadingListNotFound(
  op: string,
  listRef: string,
  asJson?: boolean,
  owner?: { type: string; id: string },
): never {
  // Same owner filter `chats lists list --owner` applies, so an owner-scoped
  // miss only suggests lists from that owner.
  const candidates = dbListChatReadingLists({
    ownerType: owner?.type,
    ownerId: owner?.id,
    limit: 50,
  }).items.flatMap((list) => [list.id, list.name]);
  const ownerSuffix = owner ? ` (${owner.type}:${owner.id})` : "";
  contractFail(op, "READING_LIST_NOT_FOUND", `Reading list not found: ${listRef}${ownerSuffix}`, {
    asJson,
    details: {
      suggestedAction: "Check the list ref (see suggestions; list with: ravi chats lists list --json)",
      suggestions: suggestSimilar(listRef, candidates),
    },
  });
}

function resolveReadingList(listRef: string, owner: string | undefined, site: ContractCallSite): ChatReadingListRecord {
  const parsedOwner = owner ? parseScopedRef(owner, defaultOwner()) : undefined;
  if (parsedOwner) {
    const list = dbFindChatReadingList({ ref: listRef, ownerType: parsedOwner.type, ownerId: parsedOwner.id });
    if (!list) failReadingListNotFound(site.op, listRef, site.asJson, parsedOwner);
    return list;
  }

  const inferredOwner = currentAgentOwner();
  if (inferredOwner) {
    const ownedList = dbFindChatReadingList({ ref: listRef, ownerType: inferredOwner.type, ownerId: inferredOwner.id });
    if (ownedList) return ownedList;
  }

  try {
    const list = dbFindChatReadingList({ ref: listRef });
    if (!list) failReadingListNotFound(site.op, listRef, site.asJson);
    return list;
  } catch (err) {
    // The not-found branch above throws a ContractError in agent context; the
    // catch exists for dbFindChatReadingList's own errors (e.g. ambiguous
    // refs), so the envelope must pass through untouched.
    if (err instanceof ContractError) throw err;
    fail(err instanceof Error ? err.message : String(err));
  }
}

function resolveReadingListById(
  listId: string,
  owner: string | undefined,
  site: ContractCallSite,
): ChatReadingListRecord {
  const parsed = readingListIdArgSchema.safeParse(listId.trim());
  if (!parsed.success) {
    fail(
      "Reading-list show, preview, and recompute require the canonical crl_<24 hex> id from `ravi chats lists list`.",
    );
  }
  const parsedOwner = owner ? parseScopedRef(owner, defaultOwner()) : undefined;
  const list = dbGetChatReadingList({
    id: parsed.data,
    ownerType: parsedOwner?.type,
    ownerId: parsedOwner?.id,
  });
  if (!list) {
    failReadingListNotFound(site.op, parsed.data, site.asJson, parsedOwner);
  }
  return list;
}

function resolveInstanceId(instance?: string): string | undefined {
  const raw = instance?.trim();
  if (!raw) return undefined;
  return dbGetInstance(raw)?.instanceId ?? raw;
}

function resolveContactId(contactRef: string | undefined, site: ContractCallSite): string | undefined {
  const raw = contactRef?.trim();
  if (!raw) return undefined;
  const contact = getContact(raw);
  if (!contact) {
    contractFail(site.op, "CONTACT_NOT_FOUND", `Contact not found: ${raw}`, {
      asJson: site.asJson,
      details: { suggestedAction: "List visible contacts with: ravi contacts list --json" },
    });
  }
  return contact.id;
}

function resolveChatId(
  ref: string,
  input: { instance?: string; channel?: string; type?: string },
  site: ContractCallSite,
): string {
  const direct = dbGetChat(ref.trim());
  if (direct) return direct.id;
  const chat = dbFindChatByRef({
    ref,
    instanceId: resolveInstanceId(input.instance),
    channel: input.channel,
    chatType: input.type as never,
  });
  if (!chat) failChatNotFound(site.op, ref, site.asJson);
  return chat.id;
}

function extractText(message: ChatMessageWithSortKey | null): string {
  if (!message) return "-";
  const content = message.content ?? {};
  const text = content.text;
  if (typeof text === "string" && text.trim()) return text.trim();
  const type = typeof content.type === "string" ? content.type : message.messageType;
  if (type) return `[${type}]`;
  return "[message]";
}

function formatTime(ts?: number): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function actorLabel(message: ChatMessageWithSortKey): string {
  if (message.actorId) return `actor:${message.actorId}`;
  if (message.contactId) return `contact:${message.contactId}`;
  if (message.agentId) return `agent:${message.agentId}`;
  if (message.normalizedSenderId) return message.normalizedSenderId;
  return message.actorType;
}

function renderMessage(message: ChatMessageWithSortKey): void {
  console.log(
    `- ${formatTime(message.providerTimestamp ?? message.ingestedAt)} ${actorLabel(message)} ${message.id}: ${extractText(message)}`,
  );
}

function serializeChat(chat: ChatRecord, includeRaw?: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: chat.id,
    channel: chat.channel,
    instanceId: chat.instanceId,
    actorId: chat.actorId,
    agentId: chat.agentId,
    chatType: chat.chatType,
    title: chat.title,
    avatarUrl: chat.avatarUrl,
    metadata: chat.metadata,
    firstSeenAt: chat.firstSeenAt,
    lastSeenAt: chat.lastSeenAt,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
  if (includeRaw) {
    base.platformChatId = chat.platformChatId;
    base.normalizedChatId = chat.normalizedChatId;
    base.rawProvenance = chat.rawProvenance;
  }
  return base;
}

function serializeMessage(message: ChatMessageWithSortKey, includeRaw?: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: message.id,
    chatId: message.chatId,
    clientMessageId: message.clientMessageId,
    actorType: message.actorType,
    actorId: message.actorId,
    contactId: message.contactId,
    agentId: message.agentId,
    platformIdentityId: message.platformIdentityId,
    messageType: message.messageType,
    content: message.content,
    revision: message.revision,
    state: message.state,
    providerTimestamp: message.providerTimestamp,
    ingestedAt: message.ingestedAt,
    sortKey: message.sortKey,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
  if (includeRaw) {
    base.channel = message.channel;
    base.instanceId = message.instanceId;
    base.providerMessageId = message.providerMessageId;
    base.rawChatId = message.rawChatId;
    base.rawSenderId = message.rawSenderId;
    base.normalizedSenderId = message.normalizedSenderId;
    base.rawProvenance = message.rawProvenance;
  }
  return base;
}

function serializeChatListItem(item: ChatListItem, includeRaw?: boolean): Record<string, unknown> {
  return {
    chat: serializeChat(item.chat, includeRaw),
    messageCount: item.messageCount,
    participantCount: item.participantCount,
    lastMessage: item.lastMessage ? serializeMessage(item.lastMessage, includeRaw) : null,
  };
}

function serializeReadingListMemberItem(
  item: ChatReadingListMemberItem,
  includeRaw?: boolean,
): Record<string, unknown> {
  return {
    member: item.member,
    chat: serializeChat(item.chat, includeRaw),
    messageCount: item.messageCount,
    unreadMessageCount: item.unreadMessageCount,
    lastMessage: item.lastMessage ? serializeMessage(item.lastMessage, includeRaw) : null,
    cursor: item.cursor,
  };
}

function serializeReadingDelta(delta: ChatReadingDelta, includeRaw?: boolean): Record<string, unknown> {
  return {
    list: delta.list,
    chat: serializeChat(delta.chat, includeRaw),
    reader: delta.reader,
    previousCursor: delta.previousCursor,
    nextCursor: delta.nextCursor,
    messages: delta.messages.map((message) => serializeMessage(message, includeRaw)),
    events: delta.events,
    newMessageCount: delta.newMessageCount,
    editedMessageCount: delta.editedMessageCount,
    deletedMessageCount: delta.deletedMessageCount,
    participantChanges: delta.participantChanges,
    firstUnreadMessage: delta.firstUnreadMessage ? serializeMessage(delta.firstUnreadMessage, includeRaw) : null,
    lastUnreadMessage: delta.lastUnreadMessage ? serializeMessage(delta.lastUnreadMessage, includeRaw) : null,
  };
}

@Group({
  name: "chats",
  description: "Inspect canonical chats, messages, and reading queues",
})
export class ChatsCommands {
  @Scope("admin")
  @Command({
    name: "ensure",
    description: "Ensure one canonical direct chat between an actor and an agent",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "agent",
    action: "ensure-chat",
    risk: "medium",
    resourceId: "agentId",
    requireConcreteResource: true,
    resourceIdPattern: OPAQUE_ID_PATTERN_SOURCE,
    input: ["actorId", "agentId", "clientRequestId"],
  })
  ensure(
    @Arg("actorId", { description: "Canonical actor id", schema: opaqueIdArgSchema }) actorId: string,
    @Arg("agentId", { description: "Target agent id", schema: opaqueIdArgSchema }) agentId: string,
    @Arg("clientRequestId", { description: "Caller-owned request id", schema: opaqueIdArgSchema })
    clientRequestId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = dbEnsureActorAgentChat({ actorId, agentId, clientRequestId });
    const payload = {
      disposition: result.created ? ("created" as const) : ("existing" as const),
      clientRequestId: result.clientRequestId,
      chat: serializeChat(result.chat),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(
      `${result.created ? "Created" : "Found"} chat ${result.chat.id} for actor ${actorId} and agent ${agentId}.`,
    );
    return payload;
  }

  @Scope("admin")
  @Command({ name: "list", aliases: ["recent"], description: "List recent canonical chats" })
  @CommandAccess({ kind: "read", resource: "chats", action: "list", risk: "low" })
  list(
    @Option({ flags: "--instance <name-or-id>", description: "Filter by instance name or Omni instance id" })
    instance?: string,
    @Option({ flags: "--channel <channel>", description: "Filter by channel, e.g. whatsapp" }) channel?: string,
    @Option({ flags: "--type <type>", description: "Filter by chat type: dm|group|thread|room" }) type?: string,
    @Option({ flags: "--contact <contact>", description: "Filter by contact id, phone, or identity" }) contact?: string,
    @Option({ flags: "--agent <agent>", description: "Filter by agent id" }) agent?: string,
    @Option({ flags: "--query <text>", description: "Search chat ids, titles, and message content" }) query?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 25, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching chats to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--include-raw", description: "Include raw provider ids and provenance in JSON output" })
    includeRaw?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const instanceId = resolveInstanceId(instance);
    const page = dbListChats({
      instanceId,
      channel,
      chatType: type as never,
      contactId: resolveContactId(contact, { op: "chats list", asJson }),
      agentId: agent,
      query,
      limit,
      offset,
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "chats", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [
        "--instance",
        instance,
        "--channel",
        channel,
        "--type",
        type,
        "--contact",
        contact,
        "--agent",
        agent,
        "--query",
        query,
        includeRaw ? "--include-raw" : undefined,
      ],
    });
    const items = pickFields(
      page.items.map((item) => serializeChatListItem(item, includeRaw)),
      fields,
    );
    const payload = { total: page.total, pagination, items, chats: items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No chats found.");
      return payload;
    }
    console.log(`\nChats (${page.items.length} returned of ${page.total}):\n`);
    for (const item of page.items) {
      console.log(`- ${item.chat.id} ${item.chat.chatType} ${item.chat.channel}/${item.chat.instanceId}`);
      console.log(`  title: ${item.chat.title ?? item.chat.normalizedChatId}`);
      console.log(`  messages: ${item.messageCount} | participants: ${item.participantCount}`);
      console.log(
        `  last: ${item.lastMessage ? `${formatTime(item.lastMessage.providerTimestamp ?? item.lastMessage.ingestedAt)} ${extractText(item.lastMessage)}` : "-"}`,
      );
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "read", description: "Read messages from one chat" })
  @CommandAccess({ kind: "read", resource: "chats", action: "read", risk: "low" })
  read(
    @Arg("chat", { description: "Chat id, platform chat id, phone, group id, or normalized chat id" }) chatRef: string,
    @Option({ flags: "--instance <name-or-id>", description: "Resolve chat within an instance" }) instance?: string,
    @Option({ flags: "--channel <channel>", description: "Resolve chat within a channel" }) channel?: string,
    @Option({ flags: "--type <type>", description: "Resolve chat type: dm|group|thread|room" }) type?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching messages to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--order <asc|desc>", description: "Message order (default: asc)" }) order?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--include-raw", description: "Include raw provider ids and provenance in JSON output" })
    includeRaw?: boolean,
  ) {
    const chatId = resolveChatId(chatRef, { instance, channel, type }, { op: "chats read", asJson });
    const chat = dbGetChat(chatId);
    if (!chat) failChatNotFound("chats read", chatRef, asJson);
    const page = dbListChatMessagesPage({
      chatId,
      limit,
      offset,
      order: order === "desc" ? "desc" : "asc",
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "chats", "read", chatRef],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [
        "--instance",
        instance,
        "--channel",
        channel,
        "--type",
        type,
        "--order",
        order,
        includeRaw ? "--include-raw" : undefined,
      ],
    });
    const payload = {
      chat: serializeChat(chat, includeRaw),
      total: page.total,
      pagination,
      messages: page.items.map((message) => serializeMessage(message, includeRaw)),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`\nChat: ${chat.id} (${chat.chatType})`);
    console.log(`Target: ${chat.title ?? chat.normalizedChatId}`);
    console.log(`Messages (${page.items.length} returned of ${page.total}):\n`);
    for (const message of page.items) renderMessage(message);
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @CliOnly()
  @Scope("admin")
  @Command({
    name: "messages",
    description: "Read messages from one chat (compatibility command; prefer chats read)",
  })
  @CommandAccess({ kind: "read", resource: "chats", action: "read", risk: "low" })
  messages(
    @Arg("chat", { description: "Chat id, platform chat id, phone, group id, or normalized chat id" }) chatRef: string,
    @Option({ flags: "--instance <name-or-id>", description: "Resolve chat within an instance" }) instance?: string,
    @Option({ flags: "--channel <channel>", description: "Resolve chat within a channel" }) channel?: string,
    @Option({ flags: "--type <type>", description: "Resolve chat type: dm|group|thread|room" }) type?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching messages to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--order <asc|desc>", description: "Message order (default: asc)" }) order?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--include-raw", description: "Include raw provider ids and provenance in JSON output" })
    includeRaw?: boolean,
  ) {
    return this.read(chatRef, instance, channel, type, limit, offset, order, asJson, includeRaw);
  }

  @Scope("admin")
  @Command({
    name: "backfill-provider-timestamps",
    description: "Backfill message provider timestamps from raw provenance",
  })
  @CommandAccess({ kind: "mutate", resource: "chats", action: "backfill-provider-timestamps", risk: "medium" })
  backfillProviderTimestamps(
    @Option({ flags: "--limit <n>", description: "Maximum matching messages to inspect/apply" }) limit?: string,
    @Option({ flags: "--apply", description: "Write corrected provider timestamps. Without this, runs dry-run." })
    apply?: boolean,
    @Option({ flags: "--dry-run", description: "Force preview mode even if --apply is present" }) dryRun?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (apply && dryRun) {
      fail("Use either --apply or --dry-run, not both");
    }

    const result = dbBackfillChatMessageProviderTimestamps({
      limit,
      dryRun: apply !== true,
    });
    const nextCommand = result.dryRun
      ? ["ravi", "chats", "backfill-provider-timestamps", limit ? `--limit ${limit}` : null, "--apply"]
          .filter(Boolean)
          .join(" ")
      : null;
    const payload = {
      action: "chats.backfill-provider-timestamps",
      ...result,
      nextCommand,
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    const title = result.dryRun ? "Provider timestamp backfill dry-run" : "Provider timestamp backfill applied";
    console.log(`\n${title}`);
    console.log(`  Scanned: ${result.scanned}`);
    console.log(`  Candidates: ${result.candidates}`);
    console.log(`  Skipped: ${result.skipped}`);
    console.log(`  Already correct: ${result.unchanged}`);
    console.log(`  Would update: ${result.wouldUpdate}`);
    if (!result.dryRun) console.log(`  Updated: ${result.updated}`);
    if (result.items.length > 0) {
      console.log("\nSample:");
      for (const item of result.items.slice(0, 10)) {
        console.log(
          `- ${item.id} ${item.providerMessageId}: ${item.previousProviderTimestamp ?? "-"} -> ${item.providerTimestamp}`,
        );
      }
    }
    if (nextCommand) console.log(`\nApply:\n  ${nextCommand}`);
    return payload;
  }
}

@Group({
  name: "chats.messages",
  description: "Create canonical chat messages",
})
export class ChatMessageCommands {
  @Scope("admin")
  @Command({
    name: "create",
    description: "Create one idempotent actor-authored message in a canonical chat",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "chat",
    action: "create-message",
    risk: "medium",
    resourceId: "chatId",
    requireConcreteResource: true,
    resourceIdPattern: CHAT_ID_PATTERN_SOURCE,
    input: ["chatId", "actorId", "clientMessageId", "content"],
    redactions: ["content"],
  })
  create(
    @Arg("chatId", { description: "Canonical chat id", schema: chatIdArgSchema }) chatId: string,
    @Arg("actorId", { description: "Canonical actor id", schema: opaqueIdArgSchema }) actorId: string,
    @Arg("clientMessageId", { description: "Caller-owned message id", schema: opaqueIdArgSchema })
    clientMessageId: string,
    @Arg("content", { description: "Message text", schema: messageContentArgSchema }) content: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = dbCreateCanonicalActorMessage({
      chatId,
      actorId,
      clientMessageId,
      content: { type: "text", text: content },
      messageType: "text",
    });
    const payload = {
      disposition: result.created ? ("created" as const) : ("duplicate" as const),
      clientMessageId: result.clientMessageId,
      messageId: result.canonicalMessageId,
      message: serializeMessage(result.message),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`${result.created ? "Created" : "Found"} message ${result.canonicalMessageId} in chat ${chatId}.`);
    return payload;
  }
}

@Group({
  name: "chats.lists",
  description: "Manage chat reading lists and cursors",
})
export class ChatReadingListCommands {
  @Scope("admin")
  @Command({ name: "list", description: "List chat reading lists" })
  @CommandAccess({ kind: "read", resource: "chats.lists", action: "list", risk: "low" })
  list(
    @Option({ flags: "--owner <type:id>", description: "Filter by owner, e.g. agent:ravi-crm" }) owner?: string,
    @Option({ flags: "--include-archived", description: "Include archived lists" }) includeArchived?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching lists to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const parsedOwner = owner ? parseScopedRef(owner, defaultOwner()) : undefined;
    const page = dbListChatReadingLists({
      ownerType: parsedOwner?.type,
      ownerId: parsedOwner?.id,
      includeArchived,
      limit,
      offset,
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "chats", "lists", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--owner", owner, includeArchived ? "--include-archived" : undefined],
    });
    const listRows = pickFields(page.items, fields);
    const payload = { total: page.total, pagination, lists: listRows, items: listRows };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No reading lists found.");
      return payload;
    }
    console.log(`\nChat reading lists (${page.items.length} returned of ${page.total}):\n`);
    for (const list of page.items) {
      console.log(`- ${list.name} (${list.id}) ${list.ownerType}:${list.ownerId} ${list.mode}`);
      if (list.description) console.log(`  ${list.description}`);
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("admin")
  @Command({
    name: "show",
    description: "Show one reading list and explain whether its selector is safe",
    helpAfter: `
USE
  Inspect one list's selector and safety gate without changing membership.

DO NOT USE
  This command does not calculate the prospective diff. Use:
  ravi chats lists preview <list-id> --json

EXAMPLES
  ravi chats lists show crl_86244e77d183316cb5034a6a --json

OUTPUT
  Returns safe list metadata, deterministic selector validation, and current member counts. Selector, metadata, and chat/contact ids are omitted. Read-only; exit 0 even when canApply=false.

ON ERROR
  Non-canonical ref -> obtain the crl_... id with ravi chats lists list and retry.

FONTES
  .ravi/specs/channels/chats/reading-lists/SPEC.md
  src/chats/reading-lists.ts
`,
  })
  @CommandAccess({
    kind: "read",
    resource: "chats.lists",
    action: "show",
    risk: "low",
    resourceId: "listId",
    requireConcreteResource: true,
    resourceIdPattern: READING_LIST_ID_PATTERN_SOURCE,
    input: ["listId", "owner"],
  })
  show(
    @Arg("listId", { description: "Canonical reading-list id (crl_<24 hex>)", schema: readingListIdArgSchema })
    listId: string,
    @Option({ flags: "--owner <type:id>", description: "Optional owner assertion for the canonical list id" })
    owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const list = resolveReadingListById(listId, owner, { op: "chats lists show", asJson });
    const inspection = inspectChatReadingList(list);
    const publicResult = publicInspection(inspection);
    const payload = { list: publicResult.list, validation: publicResult.validation, current: publicResult.current };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Reading list: ${list.name} (${list.id})`);
    console.log(`Mode: ${list.mode}; owner: ${list.ownerType}:${list.ownerId}`);
    console.log(
      `Selector summary: scope=${inspection.validation.scope} match=${inspection.validation.match} conditions=${inspection.validation.conditions.total}`,
    );
    console.log(
      `Safety: ${inspection.validation.canApply ? "SAFE" : "BLOCKED"} (${inspection.validation.riskLevel}); current=${inspection.current.total}`,
    );
    for (const issue of inspection.validation.issues) {
      console.log(`- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
    }
    return payload;
  }

  @Scope("admin")
  @Command({
    name: "preview",
    description: "Validate a dynamic selector and preview membership diff without writes",
    helpAfter: `
USE
  Run before recompute to inspect eligible, added, removed, kept and preserved chats.

DO NOT USE
  This command never applies the diff. Apply only after reviewing canApply=true with:
  ravi chats lists recompute <list-id> --owner <type:id> --json

RULES HARD
  match:any + any not-has-tag condition is BLOCKED because it can match almost the entire scope.
  Invalid selectors return canApply=false and diff=null without changing membership.

EXAMPLES
  ravi chats lists preview crl_86244e77d183316cb5034a6a --json

OUTPUT
  JSON includes dryRun=true, validation, current membership counts, and a nullable count-only diff. Chat ids are omitted to avoid cross-resource disclosure. This command is read-only.

ON ERROR
  canApply=false -> inspect validation.issues, correct the selector through an approved write path, then preview again.

FONTES
  .ravi/specs/channels/chats/reading-lists/SPEC.md
  src/chats/reading-lists.ts
`,
  })
  @CommandAccess({
    kind: "read",
    resource: "chats.lists",
    action: "preview",
    risk: "low",
    resourceId: "listId",
    requireConcreteResource: true,
    resourceIdPattern: READING_LIST_ID_PATTERN_SOURCE,
    input: ["listId", "owner"],
  })
  preview(
    @Arg("listId", { description: "Canonical reading-list id (crl_<24 hex>)", schema: readingListIdArgSchema })
    listId: string,
    @Option({ flags: "--owner <type:id>", description: "Optional owner assertion for the canonical list id" })
    owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const list = resolveReadingListById(listId, owner, { op: "chats lists preview", asJson });
    const preview = previewChatReadingListMembers(list);
    const payload = { list: publicReadingList(list), preview: publicPreview(preview) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Reading-list preview: ${list.name} (${list.id})`);
    console.log(`Safety: ${preview.validation.canApply ? "SAFE" : "BLOCKED"}; dry-run: yes`);
    for (const issue of preview.validation.issues) {
      console.log(`- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
    }
    if (preview.diff) {
      console.log(
        `Diff: eligible=${preview.diff.eligible} add=${preview.diff.added} remove=${preview.diff.removed} keep=${preview.diff.kept} preserve=${preview.diff.preserved}`,
      );
    } else {
      console.log("Diff: not evaluated because the selector is unsafe or invalid.");
    }
    return payload;
  }

  @Scope("admin")
  @Command({ name: "create", description: "Create or restore a chat reading list" })
  @CommandAccess({ kind: "mutate", resource: "chats.lists", action: "create", risk: "medium" })
  create(
    @Arg("name", { description: "Reading list name" }) name: string,
    @Option({ flags: "--owner <type:id>", description: "Owner scope (default: current agent or system:ravi)" })
    owner?: string,
    @Option({ flags: "--description <text>", description: "List description" }) description?: string,
    @Option({ flags: "--visibility <visibility>", description: "private|team|system (default: system)" })
    visibility?: string,
    @Option({ flags: "--mode <mode>", description: "static|dynamic|hybrid (default: static)" }) mode?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const parsedOwner = parseScopedRef(owner, defaultOwner());
    const list = dbCreateChatReadingList({
      name,
      description,
      ownerType: parsedOwner.type,
      ownerId: parsedOwner.id,
      visibility,
      mode,
    });
    const payload = { list };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Created reading list: ${list.name} (${list.id})`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "add", description: "Add a chat to a reading list" })
  @CommandAccess({ kind: "mutate", resource: "chats.lists", action: "add", risk: "medium" })
  add(
    @Arg("list", { description: "List id or name" }) listRef: string,
    @Arg("chat", { description: "Chat id, phone, group id, or normalized chat id" }) chatRef: string,
    @Option({ flags: "--instance <name-or-id>", description: "Resolve chat within an instance" }) instance?: string,
    @Option({ flags: "--channel <channel>", description: "Resolve chat within a channel" }) channel?: string,
    @Option({ flags: "--reason <text>", description: "Why this chat is in the list" }) reason?: string,
    @Option({ flags: "--priority <n>", description: "Sort priority (default: 0)" }) priority?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--owner <type:id>", description: "Owner scope when resolving list by name" }) owner?: string,
    @Option({ flags: "--include-raw", description: "Include raw provider ids and provenance in JSON output" })
    includeRaw?: boolean,
  ) {
    const list = resolveReadingList(listRef, owner, { op: "chats lists add", asJson });
    const chatId = resolveChatId(chatRef, { instance, channel }, { op: "chats lists add", asJson });
    const member = dbAddChatToReadingList({ listId: list.id, chatId, reason, priority });
    const chat = dbGetChat(chatId);
    const payload = { list, member, chat: chat ? serializeChat(chat, includeRaw) : null };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Added chat ${chatId} to ${list.name}.`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "remove", description: "Remove a chat from a reading list without deleting cursor history" })
  @CommandAccess({ kind: "mutate", resource: "chats.lists", action: "remove", risk: "medium" })
  remove(
    @Arg("list", { description: "List id or name" }) listRef: string,
    @Arg("chat", { description: "Chat id, phone, group id, or normalized chat id" }) chatRef: string,
    @Option({ flags: "--instance <name-or-id>", description: "Resolve chat within an instance" }) instance?: string,
    @Option({ flags: "--channel <channel>", description: "Resolve chat within a channel" }) channel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--owner <type:id>", description: "Owner scope when resolving list by name" }) owner?: string,
  ) {
    const list = resolveReadingList(listRef, owner, { op: "chats lists remove", asJson });
    const chatId = resolveChatId(chatRef, { instance, channel }, { op: "chats lists remove", asJson });
    const removed = dbRemoveChatFromReadingList({ listId: list.id, chatId });
    const payload = { list, chatId, removed };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(
      removed ? `Removed chat ${chatId} from ${list.name}.` : `Chat ${chatId} was not active in ${list.name}.`,
    );
    return payload;
  }

  @Scope("admin")
  @Command({ name: "members", description: "List chats in a reading list with unread counts" })
  @CommandAccess({ kind: "read", resource: "chats.lists", action: "members", risk: "low" })
  members(
    @Arg("list", { description: "List id or name" }) listRef: string,
    @Option({ flags: "--reader <type:id>", description: "Reader cursor scope (default: current agent)" })
    reader?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching members to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--owner <type:id>", description: "Owner scope when resolving list by name" }) owner?: string,
    @Option({ flags: "--include-raw", description: "Include raw provider ids and provenance in JSON output" })
    includeRaw?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const list = resolveReadingList(listRef, owner, { op: "chats lists members", asJson });
    const parsedReader = parseScopedRef(reader, defaultReader());
    const page = dbListChatReadingListMembers({
      listId: list.id,
      readerType: parsedReader.type,
      readerId: parsedReader.id,
      limit,
      offset,
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "chats", "lists", "members", listRef],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--reader", reader, "--owner", owner, includeRaw ? "--include-raw" : undefined],
    });
    const items = pickFields(
      page.items.map((item) => serializeReadingListMemberItem(item, includeRaw)),
      fields,
    );
    const payload = { list, reader: parsedReader, total: page.total, pagination, members: items, items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`\n${list.name} members (${page.items.length} returned of ${page.total}):\n`);
    for (const item of page.items) {
      console.log(
        `- ${item.chat.id} ${item.chat.chatType} unread=${item.unreadMessageCount} total=${item.messageCount}`,
      );
      console.log(
        `  last: ${item.lastMessage ? `${formatTime(item.lastMessage.providerTimestamp ?? item.lastMessage.ingestedAt)} ${extractText(item.lastMessage)}` : "-"}`,
      );
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("admin")
  @Command({
    name: "recompute",
    description: "Materialize dynamic reading-list selector membership",
    helpAfter: `
RULES HARD
  Unsafe or invalid selectors are blocked before writes. Always review the read-only diff first.

EXAMPLES
  ravi chats lists preview <list-id> --owner <type:id> --json
  ravi chats lists recompute <list-id> --owner <type:id> --json

ON ERROR
  Unsafe reading-list selector -> run the preview command, inspect validation.issues, and correct the selector through an approved write path.

FONTES
  .ravi/specs/channels/chats/reading-lists/SPEC.md
  src/chats/reading-lists.ts
`,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "chats.lists",
    action: "recompute",
    risk: "medium",
    resourceId: "listId",
    requireConcreteResource: true,
    resourceIdPattern: READING_LIST_ID_PATTERN_SOURCE,
    input: ["listId", "owner"],
  })
  recompute(
    @Arg("listId", { description: "Canonical reading-list id (crl_<24 hex>)", schema: readingListIdArgSchema })
    listId: string,
    @Option({ flags: "--owner <type:id>", description: "Optional owner assertion for the canonical list id" })
    owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const list = resolveReadingListById(listId, owner, { op: "chats lists recompute", asJson });
    const recompute = recomputeChatReadingListMembers(list);
    const payload = { list: publicReadingList(recompute.list), recompute: publicRecompute(recompute) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(
      `Recomputed ${list.name}: eligible=${recompute.eligible} added=${recompute.added} removed=${recompute.removed} kept=${recompute.kept} preserved=${recompute.preserved}`,
    );
    return payload;
  }

  @Scope("admin")
  @Command({ name: "delta", description: "Read what changed in a chat since this list reader cursor" })
  @CommandAccess({ kind: "mutate", resource: "chats.lists", action: "delta", risk: "low" })
  delta(
    @Arg("list", { description: "List id or name" }) listRef: string,
    @Arg("chat", { description: "Chat id, phone, group id, or normalized chat id" }) chatRef: string,
    @Option({ flags: "--reader <type:id>", description: "Reader cursor scope (default: current agent)" })
    reader?: string,
    @Option({ flags: "--instance <name-or-id>", description: "Resolve chat within an instance" }) instance?: string,
    @Option({ flags: "--channel <channel>", description: "Resolve chat within a channel" }) channel?: string,
    @Option({ flags: "--limit <n>", description: "Max delta messages (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--mark-read", description: "Advance the cursor to the last returned message" })
    markRead?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--owner <type:id>", description: "Owner scope when resolving list by name" }) owner?: string,
    @Option({ flags: "--include-raw", description: "Include raw provider ids and provenance in JSON output" })
    includeRaw?: boolean,
  ) {
    const list = resolveReadingList(listRef, owner, { op: "chats lists delta", asJson });
    const chatId = resolveChatId(chatRef, { instance, channel }, { op: "chats lists delta", asJson });
    const parsedReader = parseScopedRef(reader, defaultReader());
    const delta = dbGetChatReadingDelta({
      listId: list.id,
      chatId,
      readerType: parsedReader.type,
      readerId: parsedReader.id,
      limit,
    });
    if (!delta) fail(`Could not build delta for ${listRef}/${chatRef}`);
    const cursor =
      markRead && delta.lastUnreadMessage
        ? dbMarkChatReadingCursor({
            listId: list.id,
            chatId,
            readerType: parsedReader.type,
            readerId: parsedReader.id,
            messageId: delta.lastUnreadMessage.id,
            reason: "cli_delta_mark_read",
          })
        : null;
    const payload = { ...serializeReadingDelta(delta, includeRaw), committedCursor: cursor };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`\nDelta: ${list.name} / ${delta.chat.id}`);
    console.log(`Reader: ${parsedReader.type}:${parsedReader.id}`);
    console.log(`New messages: ${delta.newMessageCount}`);
    for (const message of delta.messages) renderMessage(message);
    if (cursor) console.log(`\nMarked read through ${cursor.lastReadMessageId}.`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "mark-read", description: "Explicitly advance one reading-list cursor" })
  @CommandAccess({ kind: "mutate", resource: "chats.lists", action: "mark-read", risk: "medium" })
  markRead(
    @Arg("list", { description: "List id or name" }) listRef: string,
    @Arg("chat", { description: "Chat id, phone, group id, or normalized chat id" }) chatRef: string,
    @Option({
      flags: "--message <message-id>",
      description: "Mark read through this durable message id (default: latest)",
    })
    messageId?: string,
    @Option({ flags: "--reader <type:id>", description: "Reader cursor scope (default: current agent)" })
    reader?: string,
    @Option({ flags: "--instance <name-or-id>", description: "Resolve chat within an instance" }) instance?: string,
    @Option({ flags: "--channel <channel>", description: "Resolve chat within a channel" }) channel?: string,
    @Option({ flags: "--reason <reason>", description: "Cursor update reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--owner <type:id>", description: "Owner scope when resolving list by name" }) owner?: string,
    @Option({ flags: "--include-raw", description: "Include raw provider ids and provenance in JSON output" })
    includeRaw?: boolean,
  ) {
    const list = resolveReadingList(listRef, owner, { op: "chats lists mark-read", asJson });
    const chatId = resolveChatId(chatRef, { instance, channel }, { op: "chats lists mark-read", asJson });
    const parsedReader = parseScopedRef(reader, defaultReader());
    const cursor = dbMarkChatReadingCursor({
      listId: list.id,
      chatId,
      readerType: parsedReader.type,
      readerId: parsedReader.id,
      messageId,
      reason,
    });
    const chat = dbGetChat(chatId);
    const payload = { list, chat: chat ? serializeChat(chat, includeRaw) : null, cursor };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Marked ${list.name}/${chatId} read through ${cursor.lastReadMessageId ?? "now"}.`);
    return payload;
  }
}

declareCommandReturns(ChatsCommands, {
  backfillProviderTimestamps: commandEnvelopeReturnSchema,
  ensure: chatsEnsureReturnSchema,
  list: chatsListReturnSchema,
  read: chatsReadReturnSchema,
});

declareCommandReturns(ChatMessageCommands, {
  create: chatsMessageCreateReturnSchema,
});

declareCommandReturns(ChatReadingListCommands, {
  add: commandEnvelopeReturnSchema,
  create: commandEnvelopeReturnSchema,
  delta: commandEnvelopeReturnSchema,
  list: commandEnvelopeReturnSchema,
  markRead: commandEnvelopeReturnSchema,
  members: commandEnvelopeReturnSchema,
  preview: chatReadingListPreviewReturnSchema,
  recompute: chatReadingListRecomputeReturnSchema,
  remove: commandEnvelopeReturnSchema,
  show: chatReadingListShowReturnSchema,
});
