import "reflect-metadata";
import { Arg, Command, Group, Option, Scope } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import {
  dbAddChatToReadingList,
  dbBackfillChatMessageProviderTimestamps,
  dbCreateChatReadingList,
  dbFindChatByRef,
  dbFindChatReadingList,
  dbGetChat,
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

function resolveReadingList(listRef: string, owner?: string): ChatReadingListRecord {
  const parsedOwner = owner ? parseScopedRef(owner, defaultOwner()) : undefined;
  if (parsedOwner) {
    const list = dbFindChatReadingList({ ref: listRef, ownerType: parsedOwner.type, ownerId: parsedOwner.id });
    if (!list) fail(`Reading list not found: ${listRef} (${parsedOwner.type}:${parsedOwner.id})`);
    return list;
  }

  const inferredOwner = currentAgentOwner();
  if (inferredOwner) {
    const ownedList = dbFindChatReadingList({ ref: listRef, ownerType: inferredOwner.type, ownerId: inferredOwner.id });
    if (ownedList) return ownedList;
  }

  try {
    const list = dbFindChatReadingList({ ref: listRef });
    if (!list) fail(`Reading list not found: ${listRef}`);
    return list;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function resolveInstanceId(instance?: string): string | undefined {
  const raw = instance?.trim();
  if (!raw) return undefined;
  return dbGetInstance(raw)?.instanceId ?? raw;
}

function resolveContactId(contactRef?: string): string | undefined {
  const raw = contactRef?.trim();
  if (!raw) return undefined;
  const contact = getContact(raw);
  if (!contact) fail(`Contact not found: ${raw}`);
  return contact.id;
}

function resolveChatId(ref: string, input: { instance?: string; channel?: string; type?: string } = {}): string {
  const direct = dbGetChat(ref.trim());
  if (direct) return direct.id;
  const chat = dbFindChatByRef({
    ref,
    instanceId: resolveInstanceId(input.instance),
    channel: input.channel,
    chatType: input.type as never,
  });
  if (!chat) fail(`Chat not found: ${ref}`);
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
    actorType: message.actorType,
    contactId: message.contactId,
    agentId: message.agentId,
    platformIdentityId: message.platformIdentityId,
    messageType: message.messageType,
    content: message.content,
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
  @Command({ name: "list", aliases: ["recent"], description: "List recent canonical chats" })
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
  ) {
    const instanceId = resolveInstanceId(instance);
    const page = dbListChats({
      instanceId,
      channel,
      chatType: type as never,
      contactId: resolveContactId(contact),
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
    const items = page.items.map((item) => serializeChatListItem(item, includeRaw));
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
  @Command({ name: "read", aliases: ["messages"], description: "Read messages from one chat" })
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
    const chatId = resolveChatId(chatRef, { instance, channel, type });
    const chat = dbGetChat(chatId);
    if (!chat) fail(`Chat not found: ${chatRef}`);
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

  @Scope("admin")
  @Command({
    name: "backfill-provider-timestamps",
    description: "Backfill message provider timestamps from raw provenance",
  })
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
  name: "chats.lists",
  description: "Manage chat reading lists and cursors",
})
export class ChatReadingListCommands {
  @Scope("admin")
  @Command({ name: "list", description: "List chat reading lists" })
  list(
    @Option({ flags: "--owner <type:id>", description: "Filter by owner, e.g. agent:ravi-crm" }) owner?: string,
    @Option({ flags: "--include-archived", description: "Include archived lists" }) includeArchived?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching lists to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
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
    const payload = { total: page.total, pagination, lists: page.items, items: page.items };
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
  @Command({ name: "create", description: "Create or restore a chat reading list" })
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
    const list = resolveReadingList(listRef, owner);
    const chatId = resolveChatId(chatRef, { instance, channel });
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
  remove(
    @Arg("list", { description: "List id or name" }) listRef: string,
    @Arg("chat", { description: "Chat id, phone, group id, or normalized chat id" }) chatRef: string,
    @Option({ flags: "--instance <name-or-id>", description: "Resolve chat within an instance" }) instance?: string,
    @Option({ flags: "--channel <channel>", description: "Resolve chat within a channel" }) channel?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--owner <type:id>", description: "Owner scope when resolving list by name" }) owner?: string,
  ) {
    const list = resolveReadingList(listRef, owner);
    const chatId = resolveChatId(chatRef, { instance, channel });
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
  ) {
    const list = resolveReadingList(listRef, owner);
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
    const items = page.items.map((item) => serializeReadingListMemberItem(item, includeRaw));
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
  @Command({ name: "delta", description: "Read what changed in a chat since this list reader cursor" })
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
    const list = resolveReadingList(listRef, owner);
    const chatId = resolveChatId(chatRef, { instance, channel });
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
    const list = resolveReadingList(listRef, owner);
    const chatId = resolveChatId(chatRef, { instance, channel });
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
