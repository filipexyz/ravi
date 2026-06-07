import { z } from "zod";

import { getAllContacts, type Contact } from "../contacts.js";
import { evaluateContactConditions, type TagRuleEvaluationContext } from "../tag-rules/conditions.js";
import type { ContactCondition } from "../tag-rules/types.js";

import {
  dbAddChatToReadingList,
  dbFindChatReadingList,
  dbListChatIdsByContactIds,
  dbRemoveChatFromReadingList,
  getDb,
  type ChatReadingListRecord,
} from "./router-db.js";

interface SelectorMemberRow {
  id: string;
  list_id: string;
  chat_id: string;
}

const SelectorScopeSchema = z.enum(["contact", "chat"]);
const SelectorMatchSchema = z.enum(["all", "any"]);

const SelectorSchema = z.object({
  scope: SelectorScopeSchema,
  match: SelectorMatchSchema.default("all"),
  conditions: z.array(z.unknown()).min(1),
});

export interface RecomputeReadingListChange {
  chatId: string;
  contactId?: string;
  reason: string;
}

export interface RecomputeReadingListResult {
  list: ChatReadingListRecord;
  scope: "contact" | "chat";
  match: "all" | "any";
  apply: boolean;
  totals: {
    contactsScanned: number;
    contactsEligible: number;
    chatsConsidered: number;
    added: number;
    removed: number;
    unchanged: number;
  };
  added: RecomputeReadingListChange[];
  removed: RecomputeReadingListChange[];
  unchanged: RecomputeReadingListChange[];
}

export interface RecomputeReadingListInput {
  listRef: string;
  ownerType?: string | null;
  ownerId?: string | null;
  apply?: boolean;
  includeGroupChats?: boolean;
}

function resolveTargetList(input: RecomputeReadingListInput): ChatReadingListRecord {
  const list = dbFindChatReadingList({
    ref: input.listRef,
    ownerType: input.ownerType ?? undefined,
    ownerId: input.ownerId ?? undefined,
  });
  if (!list) throw new Error(`Reading list not found: ${input.listRef}`);
  return list;
}

function parseSelector(list: ChatReadingListRecord): {
  scope: "contact" | "chat";
  match: "all" | "any";
  conditions: ContactCondition[];
} {
  if (!list.selector) {
    throw new Error(`Reading list ${list.name} has no selector_json defined`);
  }
  const parsed = SelectorSchema.safeParse(list.selector);
  if (!parsed.success) {
    throw new Error(`Reading list selector invalid: ${parsed.error.message}`);
  }
  if (parsed.data.scope !== "contact") {
    throw new Error(
      `Reading list selector scope '${parsed.data.scope}' is not supported yet. Only 'contact' scope can be recomputed.`,
    );
  }
  return {
    scope: parsed.data.scope,
    match: parsed.data.match,
    conditions: parsed.data.conditions as ContactCondition[],
  };
}

function contactMatchesSelector(
  conditions: ContactCondition[],
  match: "all" | "any",
  contact: Contact,
  context: TagRuleEvaluationContext,
): boolean {
  if (match === "any") {
    for (const condition of conditions) {
      const single = evaluateContactConditions({
        conditions: [condition],
        contact,
        context,
      });
      if (single.matched) return true;
    }
    return false;
  }
  const all = evaluateContactConditions({ conditions, contact, context });
  return all.matched;
}

function listActiveSelectorMembers(listId: string): Map<string, SelectorMemberRow> {
  const rows = getDb()
    .prepare(
      `SELECT id, list_id, chat_id FROM chat_reading_list_members
       WHERE list_id = ? AND removed_at IS NULL AND source = 'selector'`,
    )
    .all(listId) as SelectorMemberRow[];
  const map = new Map<string, SelectorMemberRow>();
  for (const row of rows) map.set(row.chat_id, row);
  return map;
}

function loadChatTypes(chatIds: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (chatIds.length === 0) return result;
  const database = getDb();
  const chunkSize = 500;
  for (let index = 0; index < chatIds.length; index += chunkSize) {
    const chunk = chatIds.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database
      .prepare(`SELECT id, chat_type FROM chats WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<{ id: string; chat_type: string }>;
    for (const row of rows) result.set(row.id, row.chat_type);
  }
  return result;
}

export function recomputeChatReadingList(input: RecomputeReadingListInput): RecomputeReadingListResult {
  const list = resolveTargetList(input);
  if (list.mode !== "dynamic" && list.mode !== "hybrid") {
    throw new Error(
      `Reading list ${list.name} mode '${list.mode}' cannot be recomputed (only 'dynamic' or 'hybrid' lists).`,
    );
  }

  const selector = parseSelector(list);
  const includeGroupChats = input.includeGroupChats === true;
  const apply = input.apply === true;

  const contacts = getAllContacts();
  const totals = {
    contactsScanned: contacts.length,
    contactsEligible: 0,
    chatsConsidered: 0,
    added: 0,
    removed: 0,
    unchanged: 0,
  };

  const evaluationContext: TagRuleEvaluationContext = { chatIdsByContactId: new Map() };
  const eligibleContactIds: string[] = [];
  for (const contact of contacts) {
    if (!contactMatchesSelector(selector.conditions, selector.match, contact, evaluationContext)) {
      continue;
    }
    totals.contactsEligible += 1;
    eligibleContactIds.push(contact.id);
  }

  const chatsByContact = dbListChatIdsByContactIds({ contactIds: eligibleContactIds });
  const allChatIds = new Set<string>();
  for (const chatIds of chatsByContact.values()) {
    for (const chatId of chatIds) allChatIds.add(chatId);
  }
  const chatTypesById = loadChatTypes(Array.from(allChatIds));

  const eligibleChatIds = new Set<string>();
  const chatIdToContactId = new Map<string, string>();
  for (const contactId of eligibleContactIds) {
    const chatIds = chatsByContact.get(contactId) ?? [];
    for (const chatId of chatIds) {
      if (!includeGroupChats && chatTypesById.get(chatId) !== "dm") continue;
      if (!eligibleChatIds.has(chatId)) {
        chatIdToContactId.set(chatId, contactId);
      }
      eligibleChatIds.add(chatId);
    }
  }
  totals.chatsConsidered = eligibleChatIds.size;

  const currentMembers = listActiveSelectorMembers(list.id);

  const added: RecomputeReadingListChange[] = [];
  const unchanged: RecomputeReadingListChange[] = [];
  for (const chatId of eligibleChatIds) {
    const contactId = chatIdToContactId.get(chatId);
    if (currentMembers.has(chatId)) {
      unchanged.push({ chatId, contactId, reason: "selector-match" });
      continue;
    }
    added.push({ chatId, contactId, reason: "selector-match" });
  }

  const removed: RecomputeReadingListChange[] = [];
  for (const [chatId] of currentMembers) {
    if (eligibleChatIds.has(chatId)) continue;
    removed.push({ chatId, reason: "selector-no-longer-matches" });
  }

  if (apply) {
    for (const change of added) {
      dbAddChatToReadingList({
        listId: list.id,
        chatId: change.chatId,
        source: "selector",
        reason: change.reason,
        metadata: change.contactId ? { contact_id: change.contactId } : null,
      });
    }
    for (const change of removed) {
      dbRemoveChatFromReadingList({ listId: list.id, chatId: change.chatId });
    }
  }

  totals.added = added.length;
  totals.removed = removed.length;
  totals.unchanged = unchanged.length;

  return {
    list,
    scope: selector.scope,
    match: selector.match,
    apply,
    totals,
    added,
    removed,
    unchanged,
  };
}
