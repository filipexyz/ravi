import { createHash } from "node:crypto";
import { getAllContacts, getContactById } from "../contacts.js";
import { nats } from "../nats.js";
import { dbListChats, dbGetChat } from "../router/router-db.js";
import { evaluateContactConditions, evaluateChatConditions } from "../tag-rules/conditions.js";
import type { ContactCondition, ChatCondition } from "../tag-rules/types.js";
import { logger } from "../utils/logger.js";
import {
  dbListDynamicReadingLists,
  dbGetListSelector,
  dbUpsertSelectorMember,
  dbSoftRemoveSelectorMember,
  dbIsActiveMember,
  dbCanReadChat,
  dbGetActiveMembers,
  dbHasSoftDeletedMember,
} from "./db.js";
import type {
  DynamicListSelector,
  MembershipTransition,
  TickReadingListsResult,
  ExplainSelectorResult,
} from "./types.js";
import type { ChatReadingListRecord } from "../router/router-db.js";
import type { Contact } from "../contacts.js";

const log = logger.child("reading-lists:engine");

// ============================================================================
// Reverse index: tag_slug -> Set<listId>
// Built at load time, refreshed on selector mutation.
// Used by reactive path to bound evaluation to affected lists only.
// ============================================================================

const reverseIndex = new Map<string, Set<string>>();

function extractTagSlugsFromSelector(selector: DynamicListSelector): string[] {
  const slugs = new Set<string>();
  for (const condition of selector.conditions) {
    if (condition.kind === "has-tag" || condition.kind === "not-has-tag") {
      slugs.add(condition.tag);
    } else if (condition.kind === "has-any-tag" || condition.kind === "has-all-tags") {
      for (const tag of condition.tags) slugs.add(tag);
    } else if (condition.kind === "has-chat-with") {
      for (const sub of condition.conditions) {
        if (sub.kind === "has-tag" || sub.kind === "not-has-tag") slugs.add(sub.tag);
      }
    }
  }
  return Array.from(slugs);
}

/** Rebuild the full reverse index from all current dynamic lists. */
export function refreshReverseIndex(): void {
  reverseIndex.clear();
  const lists = dbListDynamicReadingLists();
  for (const list of lists) {
    const selector = dbGetListSelector(list);
    if (!selector) continue;
    for (const slug of extractTagSlugsFromSelector(selector)) {
      if (!reverseIndex.has(slug)) reverseIndex.set(slug, new Set());
      reverseIndex.get(slug)!.add(list.id);
    }
  }
  log.debug("Reverse index refreshed", { slugCount: reverseIndex.size });
}

/** Look up which list IDs are affected by changes to the given tag slugs. */
export function getAffectedListIds(slugs: string[]): Set<string> {
  const affected = new Set<string>();
  for (const slug of slugs) {
    const ids = reverseIndex.get(slug);
    if (ids) for (const id of ids) affected.add(id);
  }
  return affected;
}

// ============================================================================
// Selector evaluation
// ============================================================================

export interface SelectorEvalResult {
  matched: boolean;
  trace: Array<Record<string, unknown>>;
}

export function evaluateSelectorForContact(
  selector: DynamicListSelector,
  contact: Contact,
  now?: number,
): SelectorEvalResult {
  if (selector.scope !== "contact") {
    return { matched: false, trace: [{ reason: "scope-mismatch", expected: "contact", actual: selector.scope }] };
  }
  return evaluateContactConditions({
    conditions: selector.conditions as ContactCondition[],
    contact,
    now,
  });
}

export function evaluateSelectorForChat(
  selector: DynamicListSelector,
  chatId: string,
  now?: number,
): SelectorEvalResult {
  if (selector.scope !== "chat") {
    return { matched: false, trace: [{ reason: "scope-mismatch", expected: "chat", actual: selector.scope }] };
  }
  return evaluateChatConditions({
    conditions: selector.conditions as ChatCondition[],
    chatId,
    now,
  });
}

// ============================================================================
// Membership resolution
// ============================================================================

function selectorHash(selector: DynamicListSelector): string {
  return createHash("sha256").update(JSON.stringify(selector)).digest("hex").slice(0, 16);
}

function buildMemberMetadata(
  cause: MembershipTransition["cause"],
  selector: DynamicListSelector,
): Record<string, unknown> {
  return {
    cause,
    listSnapshot: { selectorHash: selectorHash(selector), version: 1 },
  };
}

async function emitMembershipEvent(
  topic: string,
  listId: string,
  chatId: string,
  contactId: string | null,
  cause: MembershipTransition["cause"],
): Promise<void> {
  const payload = {
    listId,
    chatId,
    contactId,
    source: "selector" as const,
    cause,
    emittedAt: Date.now(),
  };
  await nats.emit(topic, payload).catch(() => {});
  await nats.emit(`ravi.chats.lists.${listId}.member.${topic.split(".").at(-1)!}`, payload).catch(() => {});
  await nats.emit(`ravi.chats.${chatId}.lists.member.${topic.split(".").at(-1)!}`, payload).catch(() => {});
}

/**
 * Apply the membership state machine for one (list, chat) pair.
 * Returns a transition record if any state change was applied (or would be in dry-run).
 */
function applyMembershipForChat(
  list: ChatReadingListRecord,
  selector: DynamicListSelector,
  chatId: string,
  contactId: string | null,
  matched: boolean,
  cause: MembershipTransition["cause"],
  apply: boolean,
): MembershipTransition | null {
  const isActive = dbIsActiveMember(list.id, chatId);

  if (matched && !isActive) {
    const isReentry = dbHasSoftDeletedMember(list.id, chatId);
    const kind = isReentry ? "reactivated" : "added";
    if (apply) {
      const meta = buildMemberMetadata(cause, selector);
      const { written } = dbUpsertSelectorMember({ listId: list.id, chatId, metadata: meta });
      if (written) {
        const topic = isReentry ? "ravi.chats.lists.member.reactivated" : "ravi.chats.lists.member.added";
        emitMembershipEvent(topic, list.id, chatId, contactId, cause).catch(() => {});
      }
    }
    return { listId: list.id, chatId, contactId, kind, source: "selector", cause };
  }

  if (!matched && isActive) {
    if (apply) {
      const meta = buildMemberMetadata(cause, selector);
      const removed = dbSoftRemoveSelectorMember({ listId: list.id, chatId, metadata: meta });
      if (removed) {
        emitMembershipEvent("ravi.chats.lists.member.removed", list.id, chatId, contactId, cause).catch(() => {});
      }
    }
    return { listId: list.id, chatId, contactId, kind: "removed", source: "selector", cause };
  }

  return null;
}

// ============================================================================
// Periodic tick
// ============================================================================

export interface TickReadingListsOptions {
  apply?: boolean;
  limit?: number;
  listId?: string;
  now?: number;
}

export async function tickReadingLists(options: TickReadingListsOptions = {}): Promise<TickReadingListsResult> {
  const apply = options.apply ?? false;
  const now = options.now ?? Date.now();
  const cause: MembershipTransition["cause"] = {
    evaluation: "periodic",
    triggerEvent: "tick",
    ruleId: null,
  };

  const allLists = dbListDynamicReadingLists();
  const lists = options.listId
    ? allLists.filter((l) => l.id === options.listId || l.name === options.listId)
    : allLists;

  const result: TickReadingListsResult = {
    listsProcessed: 0,
    targetsProcessed: 0,
    added: 0,
    removed: 0,
    errors: 0,
    permissionDenied: 0,
    dryRun: !apply,
    transitions: [],
  };

  for (const list of lists) {
    result.listsProcessed += 1;
    let selector: DynamicListSelector | null;
    try {
      selector = dbGetListSelector(list);
      if (!selector) {
        log.warn("Invalid or missing selector, skipping list", { listId: list.id });
        result.errors += 1;
        nats
          .emit("ravi.chats.lists.engine.error", {
            listId: list.id,
            error: "invalid_selector",
            emittedAt: Date.now(),
          })
          .catch(() => {});
        continue;
      }
    } catch (err) {
      log.error("Failed to parse selector", { listId: list.id, error: err });
      result.errors += 1;
      continue;
    }

    if (selector.scope === "contact") {
      const allContacts = getAllContacts();
      const contacts = options.limit ? allContacts.slice(0, options.limit) : allContacts;

      for (const contact of contacts) {
        result.targetsProcessed += 1;
        try {
          const { matched } = evaluateSelectorForContact(selector, contact, now);
          const chatPage = dbListChats({ contactId: contact.id, limit: 500 });
          for (const item of chatPage.items) {
            if (!dbCanReadChat(list.ownerType, list.ownerId, item.chat.id)) {
              result.permissionDenied += 1;
              continue;
            }
            const transition = applyMembershipForChat(list, selector, item.chat.id, contact.id, matched, cause, apply);
            if (transition) {
              result.transitions.push(transition);
              if (transition.kind === "added" || transition.kind === "reactivated") result.added += 1;
              if (transition.kind === "removed") result.removed += 1;
            }
          }
        } catch (err) {
          log.error("Error evaluating contact in tick", { listId: list.id, contactId: contact.id, error: err });
          result.errors += 1;
          nats
            .emit("ravi.chats.lists.engine.error", {
              listId: list.id,
              contactId: contact.id,
              error: "evaluation_error",
              emittedAt: Date.now(),
            })
            .catch(() => {});
        }
      }
    } else if (selector.scope === "chat") {
      const allChats = dbListChats({ limit: options.limit ?? 1000 });
      for (const item of allChats.items) {
        result.targetsProcessed += 1;
        try {
          if (!dbCanReadChat(list.ownerType, list.ownerId, item.chat.id)) {
            result.permissionDenied += 1;
            continue;
          }
          const { matched } = evaluateSelectorForChat(selector, item.chat.id, now);
          const transition = applyMembershipForChat(list, selector, item.chat.id, null, matched, cause, apply);
          if (transition) {
            result.transitions.push(transition);
            if (transition.kind === "added" || transition.kind === "reactivated") result.added += 1;
            if (transition.kind === "removed") result.removed += 1;
          }
        } catch (err) {
          log.error("Error evaluating chat in tick", { listId: list.id, chatId: item.chat.id, error: err });
          result.errors += 1;
        }
      }
    }

    // Orphan check: soft-remove members whose referenced chat was deleted (target_missing)
    const activeMembers = dbGetActiveMembers(list.id);
    for (const member of activeMembers) {
      if (!dbGetChat(member.chatId)) {
        const orphanMeta = { ...buildMemberMetadata(cause, selector), reason: "target_missing" };
        if (apply) {
          dbSoftRemoveSelectorMember({ listId: list.id, chatId: member.chatId, metadata: orphanMeta });
          emitMembershipEvent("ravi.chats.lists.member.removed", list.id, member.chatId, null, cause).catch(() => {});
        }
        result.transitions.push({
          listId: list.id,
          chatId: member.chatId,
          contactId: null,
          kind: "removed",
          source: "selector",
          cause,
        });
        result.removed += 1;
      }
    }
  }

  return result;
}

// ============================================================================
// Explain
// ============================================================================

export function explainSelector(
  list: ChatReadingListRecord,
  target: { type: "contact" | "chat"; id: string },
  now?: number,
): ExplainSelectorResult | null {
  const selector = dbGetListSelector(list);
  if (!selector) return null;

  let result: SelectorEvalResult;

  if (target.type === "contact") {
    const contact = getContactById(target.id);
    if (!contact) return null;
    result = evaluateSelectorForContact(selector, contact, now);
  } else {
    result = evaluateSelectorForChat(selector, target.id, now);
  }

  return {
    listId: list.id,
    selector,
    target,
    matched: result.matched,
    trace: result.trace,
  };
}

// ============================================================================
// Reactive path
// ============================================================================

// Debounce map: key = `${listId}|${targetType}:${targetId}` -> setTimeout handle
const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

function scheduleReactiveEval(
  listId: string,
  targetType: "contact" | "chat",
  targetId: string,
  allLists: ChatReadingListRecord[],
  cause: MembershipTransition["cause"],
): void {
  const key = `${listId}|${targetType}:${targetId}`;
  const existing = debounceMap.get(key);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(() => {
    debounceMap.delete(key);
    const list = allLists.find((l) => l.id === listId);
    if (!list) return;
    const selector = dbGetListSelector(list);
    if (!selector) return;

    const now = Date.now();
    try {
      if (targetType === "contact" && selector.scope === "contact") {
        const contact = getContactById(targetId);
        if (!contact) return;
        const { matched } = evaluateSelectorForContact(selector, contact, now);
        const chatPage = dbListChats({ contactId: contact.id, limit: 500 });
        for (const item of chatPage.items) {
          applyMembershipForChat(list, selector, item.chat.id, contact.id, matched, cause, true);
        }
      } else if (targetType === "chat" && selector.scope === "chat") {
        const { matched } = evaluateSelectorForChat(selector, targetId, now);
        applyMembershipForChat(list, selector, targetId, null, matched, cause, true);
      }
    } catch (err) {
      log.error("Reactive evaluation error", { listId, targetType, targetId, error: err });
      nats
        .emit("ravi.chats.lists.engine.error", {
          listId,
          targetId,
          error: "reactive_evaluation_error",
          emittedAt: Date.now(),
        })
        .catch(() => {});
    }
  }, DEBOUNCE_MS);

  debounceMap.set(key, handle);
}

let reactiveRunning = false;

/**
 * Start the reactive NATS subscriber.
 * Subscribes to ravi.tags.rule.applied and uses the reverse index to bound
 * evaluation to only the lists affected by the tag change.
 * Call this once from daemon startup.
 */
export async function startReadingListsReactiveEngine(): Promise<void> {
  if (reactiveRunning) return;
  reactiveRunning = true;

  refreshReverseIndex();
  log.info("Reading lists reactive engine started");

  (async () => {
    for await (const { data } of nats.subscribe("ravi.tags.rule.applied")) {
      if (!reactiveRunning) break;
      try {
        const added = (data.added as string[] | undefined) ?? [];
        const removed = (data.removed as string[] | undefined) ?? [];
        const allChanged = [...added, ...removed];
        if (allChanged.length === 0) continue;

        const affectedListIds = getAffectedListIds(allChanged);
        if (affectedListIds.size === 0) continue;

        const allLists = dbListDynamicReadingLists();
        const cause: MembershipTransition["cause"] = {
          evaluation: "reactive",
          triggerEvent: "ravi.tags.rule.applied",
          ruleId: typeof data.ruleId === "string" ? data.ruleId : null,
        };

        const contactId = typeof data.contactId === "string" ? data.contactId : undefined;
        const chatId = typeof data.chatId === "string" ? data.chatId : undefined;

        for (const listId of affectedListIds) {
          if (contactId) {
            scheduleReactiveEval(listId, "contact", contactId, allLists, cause);
          }
          if (chatId && !contactId) {
            scheduleReactiveEval(listId, "chat", chatId, allLists, cause);
          }
        }
      } catch (err) {
        log.error("Error processing ravi.tags.rule.applied", { error: err });
      }
    }
  })().catch((err) => {
    log.error("Reactive engine loop crashed", { error: err });
    reactiveRunning = false;
  });
}

export function stopReadingListsReactiveEngine(): void {
  reactiveRunning = false;
  for (const handle of debounceMap.values()) clearTimeout(handle);
  debounceMap.clear();
}
