import { randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import {
  dbGetChat,
  dbListChatIdsByContactIds,
  dbListChats,
  getDb,
  type ChatReadingListRecord,
  type ChatType,
} from "../router/router-db.js";
import { canonicalAssetIdsForTag } from "../tags/helpers.js";

type TagTarget = "contact" | "chat";
type SelectorMatchMode = "all" | "any";

interface ActiveReadingListMemberRow {
  id: string;
  chat_id: string;
  source: string;
}

interface ReadingListSelectorCriteria {
  chatIds: string[];
  contactIds: string[];
  contactAllTags: string[];
  contactAnyTags: string[];
  chatAllTags: string[];
  chatAnyTags: string[];
  channel?: string;
  instanceId?: string;
  chatType?: ChatType;
}

export interface ChatReadingListRecomputeResult {
  list: ChatReadingListRecord;
  selector: Record<string, unknown>;
  eligibleChatIds: string[];
  addedChatIds: string[];
  removedChatIds: string[];
  keptChatIds: string[];
  preservedChatIds: string[];
  added: number;
  removed: number;
  kept: number;
  preserved: number;
  eligible: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringList(...values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pushOne = (value: unknown): void => {
    const normalized = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  };
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const part of value.split(",")) pushOne(part);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    pushOne(value);
  };

  for (const value of values) visit(value);
  return result;
}

function normalizeMatchMode(selector: Record<string, unknown>): SelectorMatchMode {
  const raw = stringValue(selector.tagMode) ?? stringValue(selector.tagsMode) ?? stringValue(selector.match);
  return raw === "any" || raw === "or" ? "any" : "all";
}

function normalizeTagTargets(selector: Record<string, unknown>): TagTarget[] {
  const raw = stringValue(selector.tagTarget) ?? stringValue(selector.tagsTarget) ?? stringValue(selector.assetType);
  if (raw === "chat" || raw === "chats") return ["chat"];
  if (raw === "contact" || raw === "contacts") return ["contact"];
  return ["contact"];
}

function addTagsByMode(
  input: {
    selector: Record<string, unknown>;
    targets: TagTarget[];
    mode: SelectorMatchMode;
  },
  criteria: ReadingListSelectorCriteria,
): void {
  const genericAll = normalizeStringList(input.selector.allTags);
  const genericAny = normalizeStringList(input.selector.anyTags);
  const genericTags = normalizeStringList(input.selector.tag, input.selector.tags);
  const defaultGenericAll = input.mode === "all" ? genericTags : [];
  const defaultGenericAny = input.mode === "any" ? genericTags : [];

  if (input.targets.includes("contact")) {
    criteria.contactAllTags.push(
      ...genericAll,
      ...defaultGenericAll,
      ...normalizeStringList(input.selector.contactTag, input.selector.contactTags, input.selector.allContactTags),
    );
    criteria.contactAnyTags.push(
      ...genericAny,
      ...defaultGenericAny,
      ...normalizeStringList(input.selector.anyContactTags),
    );
  }

  if (input.targets.includes("chat")) {
    criteria.chatAllTags.push(
      ...genericAll,
      ...defaultGenericAll,
      ...normalizeStringList(input.selector.chatTag, input.selector.chatTags, input.selector.allChatTags),
    );
    criteria.chatAnyTags.push(...genericAny, ...defaultGenericAny, ...normalizeStringList(input.selector.anyChatTags));
  }
}

function selectorCriteria(selector: Record<string, unknown>): ReadingListSelectorCriteria {
  const criteria: ReadingListSelectorCriteria = {
    chatIds: normalizeStringList(selector.chat, selector.chatId, selector.chats, selector.chatIds),
    contactIds: normalizeStringList(selector.contact, selector.contactId, selector.contacts, selector.contactIds),
    contactAllTags: [],
    contactAnyTags: [],
    chatAllTags: [],
    chatAnyTags: [],
    channel: stringValue(selector.channel),
    instanceId: stringValue(selector.instanceId) ?? stringValue(selector.instance),
    chatType: (stringValue(selector.chatType) ?? stringValue(selector.type)) as ChatType | undefined,
  };
  addTagsByMode(
    {
      selector,
      targets: normalizeTagTargets(selector),
      mode: normalizeMatchMode(selector),
    },
    criteria,
  );
  return criteria;
}

function hasCriteria(criteria: ReadingListSelectorCriteria): boolean {
  return Boolean(
    criteria.chatIds.length ||
      criteria.contactIds.length ||
      criteria.contactAllTags.length ||
      criteria.contactAnyTags.length ||
      criteria.chatAllTags.length ||
      criteria.chatAnyTags.length ||
      criteria.channel ||
      criteria.instanceId ||
      criteria.chatType,
  );
}

function intersectSets(left: Set<string>, right: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const value of left) {
    if (right.has(value)) result.add(value);
  }
  return result;
}

function unionSets(sets: Set<string>[]): Set<string> {
  const result = new Set<string>();
  for (const set of sets) {
    for (const value of set) result.add(value);
  }
  return result;
}

function taggedAssetIds(assetType: "contact" | "chat", tags: string[], mode: SelectorMatchMode): Set<string> | null {
  const normalizedTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  if (normalizedTags.length === 0) return null;
  const sets = normalizedTags.map((tag) => new Set(canonicalAssetIdsForTag(assetType, tag) ?? []));
  if (sets.length === 0) return null;
  if (mode === "any") return unionSets(sets);
  return sets.slice(1).reduce((acc, set) => intersectSets(acc, set), sets[0] ?? new Set<string>());
}

function chatsForContactIds(contactIds: Iterable<string>): Set<string> {
  const contactIdsList = [...new Set([...contactIds].map((id) => id.trim()).filter(Boolean))];
  const byContact = dbListChatIdsByContactIds({ contactIds: contactIdsList });
  const result = new Set<string>();
  for (const chatIds of byContact.values()) {
    for (const chatId of chatIds) result.add(chatId);
  }
  return result;
}

function chatsForChatIds(chatIds: Iterable<string>): Set<string> {
  const result = new Set<string>();
  for (const chatId of chatIds) {
    const chat = dbGetChat(chatId.trim());
    if (chat) result.add(chat.id);
  }
  return result;
}

function chatsForFilters(criteria: ReadingListSelectorCriteria): Set<string> | null {
  if (!criteria.channel && !criteria.instanceId && !criteria.chatType) return null;
  const result = new Set<string>();
  let offset = 0;
  const limit = 500;
  while (true) {
    const page = dbListChats({
      channel: criteria.channel,
      instanceId: criteria.instanceId,
      chatType: criteria.chatType,
      limit,
      offset,
    });
    for (const item of page.items) result.add(item.chat.id);
    if (page.items.length === 0 || offset + page.items.length >= page.total) break;
    offset += page.items.length;
  }
  return result;
}

function eligibleChatIdsForSelector(selector: Record<string, unknown>): string[] {
  const criteria = selectorCriteria(selector);
  if (!hasCriteria(criteria)) {
    throw new Error(
      "Reading list selector has no supported predicates. Use contactTags/tags, chatTags, contacts, chats, channel, instanceId, or chatType.",
    );
  }

  const sets: Set<string>[] = [];
  if (criteria.chatIds.length > 0) sets.push(chatsForChatIds(criteria.chatIds));
  if (criteria.contactIds.length > 0) sets.push(chatsForContactIds(criteria.contactIds));

  const allTaggedContacts = taggedAssetIds("contact", criteria.contactAllTags, "all");
  if (allTaggedContacts) sets.push(chatsForContactIds(allTaggedContacts));
  const anyTaggedContacts = taggedAssetIds("contact", criteria.contactAnyTags, "any");
  if (anyTaggedContacts) sets.push(chatsForContactIds(anyTaggedContacts));

  const allTaggedChats = taggedAssetIds("chat", criteria.chatAllTags, "all");
  if (allTaggedChats) sets.push(chatsForChatIds(allTaggedChats));
  const anyTaggedChats = taggedAssetIds("chat", criteria.chatAnyTags, "any");
  if (anyTaggedChats) sets.push(chatsForChatIds(anyTaggedChats));

  const filteredChats = chatsForFilters(criteria);
  if (filteredChats) sets.push(filteredChats);

  const eligible = sets.slice(1).reduce((acc, set) => intersectSets(acc, set), sets[0] ?? new Set<string>());
  return [...eligible].sort();
}

function activeReadingListMembers(listId: string): ActiveReadingListMemberRow[] {
  return getDb()
    .prepare(
      `
      SELECT id, chat_id, source
      FROM chat_reading_list_members
      WHERE list_id = ? AND removed_at IS NULL
      ORDER BY added_at ASC, id ASC
    `,
    )
    .all(listId) as ActiveReadingListMemberRow[];
}

export function recomputeChatReadingListMembers(list: ChatReadingListRecord): ChatReadingListRecomputeResult {
  const mode = list.mode.trim().toLowerCase();
  if (mode !== "dynamic" && mode !== "hybrid") {
    throw new Error(`Reading list ${list.name} is ${list.mode}; recompute requires dynamic or hybrid mode.`);
  }
  const selector = isRecord(list.selector) ? list.selector : {};
  const eligibleChatIds = eligibleChatIdsForSelector(selector);
  const eligible = new Set(eligibleChatIds);
  const database = getDb();
  const now = Date.now();

  const result = executeWrite(
    database,
    () => {
      const activeRows = activeReadingListMembers(list.id);
      const activeByChatId = new Map(activeRows.map((row) => [row.chat_id, row]));
      const addedChatIds: string[] = [];
      const removedChatIds: string[] = [];
      const keptChatIds: string[] = [];
      const preservedChatIds: string[] = [];

      for (const chatId of eligibleChatIds) {
        const active = activeByChatId.get(chatId);
        if (active) {
          if (active.source === "selector") keptChatIds.push(chatId);
          continue;
        }
        const id = `crlm_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        database
          .prepare(
            `
            INSERT INTO chat_reading_list_members (
              id, list_id, chat_id, source, reason, priority, metadata_json, added_at, removed_at
            )
            VALUES (?, ?, ?, 'selector', 'selector_recompute', 0, ?, ?, NULL)
          `,
          )
          .run(id, list.id, chatId, JSON.stringify({ selector, recomputedAt: now }), now);
        addedChatIds.push(chatId);
      }

      for (const row of activeRows) {
        if (row.source !== "selector") {
          preservedChatIds.push(row.chat_id);
          continue;
        }
        if (eligible.has(row.chat_id)) continue;
        database
          .prepare("UPDATE chat_reading_list_members SET removed_at = ? WHERE id = ? AND removed_at IS NULL")
          .run(now, row.id);
        removedChatIds.push(row.chat_id);
      }

      if (addedChatIds.length > 0 || removedChatIds.length > 0) {
        database.prepare("UPDATE chat_reading_lists SET updated_at = ? WHERE id = ?").run(now, list.id);
      }

      return {
        addedChatIds: addedChatIds.sort(),
        removedChatIds: removedChatIds.sort(),
        keptChatIds: keptChatIds.sort(),
        preservedChatIds: preservedChatIds.sort(),
      };
    },
    { label: "chats:recomputeReadingListMembers" },
  );

  return {
    list,
    selector,
    eligibleChatIds,
    ...result,
    added: result.addedChatIds.length,
    removed: result.removedChatIds.length,
    kept: result.keptChatIds.length,
    preserved: result.preservedChatIds.length,
    eligible: eligibleChatIds.length,
  };
}
