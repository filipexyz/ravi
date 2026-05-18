import { dbGetChat, dbListChatMessagesPage, dbListChats } from "../router/router-db.js";
import { canonicalTagSlugsForAsset } from "../tags/helpers.js";
import { tryNormalizeTagSlug } from "../tags/tag-db.js";
import type { Contact } from "../contacts.js";
import type {
  ChatCondition,
  ConditionEvaluation,
  ContactCondition,
  DurationOperator,
  NumericOperator,
} from "./types.js";

function durationToMs(value: string): number {
  const match = /^(\d+)\s*([smhdw])$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  switch (unit) {
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    case "d":
      return amount * 24 * 60 * 60 * 1000;
    case "w":
      return amount * 7 * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Invalid duration unit: ${unit}`);
  }
}

function compareDuration(actualMs: number, operator: DurationOperator, expectedMs: number): boolean {
  switch (operator) {
    case ">":
      return actualMs > expectedMs;
    case "<":
      return actualMs < expectedMs;
    case ">=":
      return actualMs >= expectedMs;
    case "<=":
      return actualMs <= expectedMs;
    case "=":
      return actualMs === expectedMs;
  }
}

function compareNumeric(actual: number, operator: NumericOperator, expected: number): boolean {
  switch (operator) {
    case ">":
      return actual > expected;
    case "<":
      return actual < expected;
    case ">=":
      return actual >= expected;
    case "<=":
      return actual <= expected;
    case "=":
      return actual === expected;
    case "!=":
      return actual !== expected;
  }
}

function parseTimestamp(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function tagsForContact(contact: Contact): Set<string> {
  const slugs = new Set<string>();
  for (const tag of contact.tags ?? []) {
    const normalized = tryNormalizeTagSlug(tag) ?? tag;
    slugs.add(normalized);
  }
  for (const slug of canonicalTagSlugsForAsset("contact", contact.id)) {
    slugs.add(slug);
  }
  return slugs;
}

function evaluateChatCondition(condition: ChatCondition, chatId: string, now: number): ConditionEvaluation {
  if (condition.kind === "chat-type") {
    const chat = dbGetChat(chatId);
    const matched = chat?.chatType === condition.value;
    return { matched, cause: { kind: condition.kind, expected: condition.value, actual: chat?.chatType ?? null } };
  }
  if (condition.kind === "message-count") {
    const page = dbListChatMessagesPage({ chatId, limit: 1, offset: 0 });
    const total = page.total;
    return {
      matched: compareNumeric(total, condition.operator, condition.value),
      cause: { kind: condition.kind, operator: condition.operator, expected: condition.value, actual: total },
    };
  }
  if (condition.kind === "last-inbound-age") {
    const inbound = findLastInboundMessage(chatId);
    if (!inbound) {
      const matched = condition.operator === ">" || condition.operator === ">=";
      return { matched, cause: { kind: condition.kind, message: "no-inbound-message" } };
    }
    const ts = inbound.providerTimestamp ?? inbound.ingestedAt;
    const ageMs = Math.max(0, now - ts);
    const expectedMs = durationToMs(condition.duration);
    return {
      matched: compareDuration(ageMs, condition.operator, expectedMs),
      cause: { kind: condition.kind, operator: condition.operator, ageMs, expectedMs },
    };
  }
  if (condition.kind === "any-message-text-matches") {
    const lastN = condition.lastN ?? 200;
    const page = dbListChatMessagesPage({ chatId, limit: lastN, offset: 0, order: "desc" });
    const filter = condition.from ?? "any";
    const regex = new RegExp(condition.pattern, "i");
    for (const message of page.items) {
      if (filter === "contact" && message.actorType !== "contact") continue;
      if (filter === "agent" && message.actorType !== "agent") continue;
      const text = typeof message.content?.text === "string" ? (message.content.text as string) : "";
      if (text && regex.test(text)) {
        return {
          matched: true,
          cause: { kind: condition.kind, matchedMessageId: message.id, sample: text.slice(0, 80) },
        };
      }
    }
    return { matched: false, cause: { kind: condition.kind, scanned: page.items.length } };
  }
  if (condition.kind === "has-tag") {
    const slug = tryNormalizeTagSlug(condition.tag);
    if (!slug) return { matched: false, cause: { kind: condition.kind, message: "invalid-slug" } };
    const matched = chatHasTag(chatId, slug);
    return { matched, cause: { kind: condition.kind, tag: slug } };
  }
  if (condition.kind === "not-has-tag") {
    const slug = tryNormalizeTagSlug(condition.tag);
    if (!slug) return { matched: true, cause: { kind: condition.kind, message: "invalid-slug" } };
    const matched = !chatHasTag(chatId, slug);
    return { matched, cause: { kind: condition.kind, tag: slug } };
  }
  return { matched: false, cause: { kind: "unsupported", value: (condition as { kind: string }).kind } };
}

function findLastInboundMessage(chatId: string) {
  let offset = 0;
  const pageSize = 100;
  while (true) {
    const page = dbListChatMessagesPage({ chatId, limit: pageSize, offset, order: "desc" });
    if (page.items.length === 0) return null;
    for (const message of page.items) {
      if (message.actorType === "contact") return message;
    }
    if (page.items.length < pageSize) return null;
    offset += pageSize;
    if (offset >= 1_000) return null;
  }
}

function chatHasTag(chatId: string, slug: string): boolean {
  const slugs = canonicalTagSlugsForAsset("chat", chatId);
  return slugs.includes(slug);
}

function listChatsForContact(contact: Contact): string[] {
  const chats = dbListChats({ limit: 1_000, contactId: contact.id });
  return chats.items.map((item) => item.chat.id);
}

function evaluateContactCondition(condition: ContactCondition, contact: Contact, now: number): ConditionEvaluation {
  if (condition.kind === "has-tag") {
    const slug = tryNormalizeTagSlug(condition.tag);
    const slugs = tagsForContact(contact);
    const matched = slug ? slugs.has(slug) : false;
    return { matched, cause: { kind: condition.kind, tag: slug, contactTags: Array.from(slugs) } };
  }
  if (condition.kind === "not-has-tag") {
    const slug = tryNormalizeTagSlug(condition.tag);
    const slugs = tagsForContact(contact);
    const matched = slug ? !slugs.has(slug) : true;
    return { matched, cause: { kind: condition.kind, tag: slug } };
  }
  if (condition.kind === "has-any-tag") {
    const slugs = tagsForContact(contact);
    const normalized = condition.tags
      .map((tag) => tryNormalizeTagSlug(tag))
      .filter((value): value is string => value !== null);
    const matched = normalized.some((tag) => slugs.has(tag));
    return { matched, cause: { kind: condition.kind, tags: normalized } };
  }
  if (condition.kind === "has-all-tags") {
    const slugs = tagsForContact(contact);
    const normalized = condition.tags
      .map((tag) => tryNormalizeTagSlug(tag))
      .filter((value): value is string => value !== null);
    const matched = normalized.every((tag) => slugs.has(tag));
    return { matched, cause: { kind: condition.kind, tags: normalized } };
  }
  if (condition.kind === "status") {
    const matched = contact.status === condition.value;
    return { matched, cause: { kind: condition.kind, expected: condition.value, actual: contact.status } };
  }
  if (condition.kind === "last-inbound-age") {
    const ts = parseTimestamp(contact.last_inbound_at);
    if (ts === null) {
      const matched = condition.operator === ">" || condition.operator === ">=";
      return { matched, cause: { kind: condition.kind, message: "no-last-inbound" } };
    }
    const ageMs = Math.max(0, now - ts);
    const expectedMs = durationToMs(condition.duration);
    return {
      matched: compareDuration(ageMs, condition.operator, expectedMs),
      cause: { kind: condition.kind, operator: condition.operator, ageMs, expectedMs },
    };
  }
  if (condition.kind === "has-chat-with") {
    const chatIds = listChatsForContact(contact);
    const subTraces: Array<Record<string, unknown>> = [];
    for (const chatId of chatIds) {
      const subEvaluations = condition.conditions.map((sub) => evaluateChatCondition(sub, chatId, now));
      const allMatched = subEvaluations.every((sub) => sub.matched);
      const traces = subEvaluations.map((sub) => sub.cause);
      subTraces.push({ chatId, allMatched, traces });
      if (allMatched) {
        return { matched: true, cause: { kind: condition.kind, chatId, traces } };
      }
    }
    return { matched: false, cause: { kind: condition.kind, scanned: subTraces } };
  }
  return { matched: false, cause: { kind: "unsupported", value: (condition as { kind: string }).kind } };
}

export interface EvaluateContactRuleInput {
  conditions: ContactCondition[];
  contact: Contact;
  now?: number;
}

export interface EvaluateContactRuleResult {
  matched: boolean;
  trace: Array<Record<string, unknown>>;
}

export function evaluateContactConditions(input: EvaluateContactRuleInput): EvaluateContactRuleResult {
  const now = input.now ?? Date.now();
  const trace: Array<Record<string, unknown>> = [];
  for (const condition of input.conditions) {
    const result = evaluateContactCondition(condition, input.contact, now);
    trace.push({ ...result.cause, matched: result.matched });
    if (!result.matched) {
      return { matched: false, trace };
    }
  }
  return { matched: true, trace };
}

export interface EvaluateChatRuleInput {
  conditions: ChatCondition[];
  chatId: string;
  now?: number;
}

export function evaluateChatConditions(input: EvaluateChatRuleInput): EvaluateContactRuleResult {
  const now = input.now ?? Date.now();
  const trace: Array<Record<string, unknown>> = [];
  for (const condition of input.conditions) {
    const result = evaluateChatCondition(condition, input.chatId, now);
    trace.push({ ...result.cause, matched: result.matched });
    if (!result.matched) {
      return { matched: false, trace };
    }
  }
  return { matched: true, trace };
}

export const __internal = {
  durationToMs,
  compareDuration,
  compareNumeric,
  parseTimestamp,
  evaluateChatCondition,
  evaluateContactCondition,
  listChatsForContact,
  tagsForContact,
};
