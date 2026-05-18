import { addContactTag, getContactById, removeContactTag, type Contact } from "../contacts.js";
import { nats } from "../nats.js";
import { dbDeleteTagBinding } from "../tags/tag-db.js";
import { attachTagSlugsToAsset, canonicalTagSlugsForAsset } from "../tags/helpers.js";
import { tryNormalizeTagSlug } from "../tags/tag-db.js";
import { evaluateChatConditions, evaluateContactConditions } from "./conditions.js";
import type { AppliedTagAction, ApplyAction, ChatCondition, ContactCondition, TagRule } from "./types.js";

export interface ApplyRuleOptions {
  rule: TagRule;
  contact: Contact;
  cascadeDepth?: number;
  visited?: Set<string>;
  apply?: boolean;
  now?: number;
  cause: { evaluation: "reactive" | "periodic" | "manual"; triggerType?: string };
}

export interface ApplyRuleResult {
  ruleId: string;
  matched: boolean;
  trace: Array<Record<string, unknown>>;
  applied: AppliedTagAction[];
  skipped: Array<{ reason: string; detail?: Record<string, unknown> }>;
}

function visitedKey(ruleId: string, contactId: string, slug: string): string {
  return `${ruleId}|contact:${contactId}|${slug}`;
}

function actionAppliesToContact(action: ApplyAction): boolean {
  return action.target === "contact";
}

function actionAppliesToChat(action: ApplyAction): boolean {
  return action.target === "chat";
}

function appliedTags(action: ApplyAction): { added: string[]; removed: string[] } {
  const added = action.tag ? [action.tag] : [];
  const remove = action.removeTag ?? [];
  const removed = Array.isArray(remove) ? remove : [remove];
  return { added, removed };
}

function normalizeSlugs(slugs: string[]): string[] {
  return slugs
    .map((slug) => tryNormalizeTagSlug(slug) ?? slug.trim())
    .filter((slug, index, list) => slug.length > 0 && list.indexOf(slug) === index);
}

export function applyContactRule(options: ApplyRuleOptions): ApplyRuleResult {
  const { rule, contact } = options;
  const now = options.now ?? Date.now();
  const cascadeDepth = options.cascadeDepth ?? 0;
  const visited = options.visited ?? new Set<string>();
  const skipped: Array<{ reason: string; detail?: Record<string, unknown> }> = [];

  if (!rule.enabled) {
    return {
      ruleId: rule.id,
      matched: false,
      trace: [{ reason: "disabled" }],
      applied: [],
      skipped: [{ reason: "disabled" }],
    };
  }

  if (rule.scope !== "contact") {
    return {
      ruleId: rule.id,
      matched: false,
      trace: [{ reason: "scope-not-supported", scope: rule.scope }],
      applied: [],
      skipped: [{ reason: "scope-not-supported", detail: { scope: rule.scope } }],
    };
  }

  const conditionResult = evaluateContactConditions({
    conditions: rule.conditions as ContactCondition[],
    contact,
    now,
  });
  const applied: AppliedTagAction[] = [];

  for (const action of rule.apply) {
    if (!actionAppliesToContact(action)) {
      skipped.push({ reason: "target-not-supported", detail: { target: action.target } });
      continue;
    }
    const when = action.when ?? "matched";
    const shouldRun = when === "matched" ? conditionResult.matched : !conditionResult.matched;
    if (!shouldRun) {
      skipped.push({ reason: when === "matched" ? "conditions-not-matched" : "conditions-matched" });
      continue;
    }
    const { added, removed } = appliedTags(action);
    const normalizedAdded = normalizeSlugs(added);
    const normalizedRemoved = normalizeSlugs(removed);

    const guardedAdded: string[] = [];
    for (const slug of normalizedAdded) {
      const key = visitedKey(rule.id, contact.id, `+${slug}`);
      if (visited.has(key)) {
        skipped.push({ reason: "cascade-cycle-skipped", detail: { tag: slug, action: "add" } });
        continue;
      }
      visited.add(key);
      guardedAdded.push(slug);
    }
    const guardedRemoved: string[] = [];
    for (const slug of normalizedRemoved) {
      const key = visitedKey(rule.id, contact.id, `-${slug}`);
      if (visited.has(key)) {
        skipped.push({ reason: "cascade-cycle-skipped", detail: { tag: slug, action: "remove" } });
        continue;
      }
      visited.add(key);
      guardedRemoved.push(slug);
    }

    const beforeTags = new Set(contact.tags ?? []);
    const willAdd = guardedAdded.filter((slug) => !beforeTags.has(slug));
    const willRemove = guardedRemoved.filter((slug) => beforeTags.has(slug));
    const noop = willAdd.length === 0 && willRemove.length === 0;

    if (options.apply && !noop) {
      for (const slug of willRemove) {
        removeContactTag(contact.id, slug);
      }
      for (const slug of willAdd) {
        addContactTag(contact.id, slug);
      }
      const payload = {
        ruleId: rule.id,
        target: { type: "contact" as const, id: contact.id },
        contactId: contact.id,
        added: willAdd,
        removed: willRemove,
        cause: {
          evaluation: options.cause.evaluation,
          triggerType: options.cause.triggerType ?? null,
        },
        cascadeDepth,
        emittedAt: Date.now(),
      };
      nats.emit("ravi.tags.rule.applied", payload).catch(() => {});
      nats.emit(`ravi.contacts.${contact.id}.tags.rule.applied`, payload).catch(() => {});
    }

    applied.push({
      ruleId: rule.id,
      target: { type: "contact", id: contact.id },
      added: willAdd,
      removed: willRemove,
      noop,
      cause: { evaluation: options.cause.evaluation, triggerType: options.cause.triggerType ?? null, ruleId: rule.id },
      cascadeDepth,
    });
  }

  return {
    ruleId: rule.id,
    matched: conditionResult.matched,
    trace: conditionResult.trace,
    applied,
    skipped,
  };
}

export interface ApplyChatRuleOptions {
  rule: TagRule;
  chatId: string;
  cascadeDepth?: number;
  visited?: Set<string>;
  apply?: boolean;
  now?: number;
  cause: { evaluation: "reactive" | "periodic" | "manual"; triggerType?: string };
}

export function applyChatRule(options: ApplyChatRuleOptions): ApplyRuleResult {
  const { rule, chatId } = options;
  const now = options.now ?? Date.now();
  const cascadeDepth = options.cascadeDepth ?? 0;
  const visited = options.visited ?? new Set<string>();
  const skipped: Array<{ reason: string; detail?: Record<string, unknown> }> = [];

  if (!rule.enabled) {
    return {
      ruleId: rule.id,
      matched: false,
      trace: [{ reason: "disabled" }],
      applied: [],
      skipped: [{ reason: "disabled" }],
    };
  }

  if (rule.scope !== "chat") {
    return {
      ruleId: rule.id,
      matched: false,
      trace: [{ reason: "scope-not-supported", scope: rule.scope }],
      applied: [],
      skipped: [{ reason: "scope-not-supported", detail: { scope: rule.scope } }],
    };
  }

  const conditionResult = evaluateChatConditions({
    conditions: rule.conditions as ChatCondition[],
    chatId,
    now,
  });
  const applied: AppliedTagAction[] = [];

  for (const action of rule.apply) {
    if (!actionAppliesToChat(action)) {
      skipped.push({ reason: "target-not-supported", detail: { target: action.target } });
      continue;
    }
    const when = action.when ?? "matched";
    const shouldRun = when === "matched" ? conditionResult.matched : !conditionResult.matched;
    if (!shouldRun) {
      skipped.push({ reason: when === "matched" ? "conditions-not-matched" : "conditions-matched" });
      continue;
    }
    const { added, removed } = appliedTags(action);
    const normalizedAdded = normalizeSlugs(added);
    const normalizedRemoved = normalizeSlugs(removed);

    const guardedAdded: string[] = [];
    for (const slug of normalizedAdded) {
      const key = `${rule.id}|chat:${chatId}|+${slug}`;
      if (visited.has(key)) {
        skipped.push({ reason: "cascade-cycle-skipped", detail: { tag: slug, action: "add" } });
        continue;
      }
      visited.add(key);
      guardedAdded.push(slug);
    }
    const guardedRemoved: string[] = [];
    for (const slug of normalizedRemoved) {
      const key = `${rule.id}|chat:${chatId}|-${slug}`;
      if (visited.has(key)) {
        skipped.push({ reason: "cascade-cycle-skipped", detail: { tag: slug, action: "remove" } });
        continue;
      }
      visited.add(key);
      guardedRemoved.push(slug);
    }

    const currentSlugs = new Set(canonicalTagSlugsForAsset("chat", chatId));
    const willAdd = guardedAdded.filter((slug) => !currentSlugs.has(slug));
    const willRemove = guardedRemoved.filter((slug) => currentSlugs.has(slug));
    const noop = willAdd.length === 0 && willRemove.length === 0;

    if (options.apply && !noop) {
      if (willRemove.length > 0) {
        for (const slug of willRemove) {
          dbDeleteTagBinding({ slug, assetType: "chat", assetId: chatId, source: `tag_rules:${rule.id}` });
        }
      }
      if (willAdd.length > 0) {
        attachTagSlugsToAsset({
          assetType: "chat",
          assetId: chatId,
          tags: willAdd,
          source: `tag_rules:${rule.id}`,
          createdBy: "tag-rules",
          metadata: { ruleId: rule.id, evaluation: options.cause.evaluation },
        });
      }
      const payload = {
        ruleId: rule.id,
        target: { type: "chat" as const, id: chatId },
        chatId,
        added: willAdd,
        removed: willRemove,
        cause: { evaluation: options.cause.evaluation, triggerType: options.cause.triggerType ?? null },
        cascadeDepth,
        emittedAt: Date.now(),
      };
      nats.emit("ravi.tags.rule.applied", payload).catch(() => {});
      nats.emit(`ravi.chats.${chatId}.tags.rule.applied`, payload).catch(() => {});
    }

    applied.push({
      ruleId: rule.id,
      target: { type: "chat", id: chatId },
      added: willAdd,
      removed: willRemove,
      noop,
      cause: { evaluation: options.cause.evaluation, triggerType: options.cause.triggerType ?? null, ruleId: rule.id },
      cascadeDepth,
    });
  }

  return {
    ruleId: rule.id,
    matched: conditionResult.matched,
    trace: conditionResult.trace,
    applied,
    skipped,
  };
}

export interface EvaluateRulesForContactOptions {
  rules: TagRule[];
  contactRef: string;
  cause: { evaluation: "reactive" | "periodic" | "manual"; triggerType?: string };
  apply?: boolean;
  now?: number;
}

export function evaluateRulesForContact(options: EvaluateRulesForContactOptions): ApplyRuleResult[] {
  const contact = getContactById(options.contactRef);
  if (!contact) {
    throw new Error(`Contact not found: ${options.contactRef}`);
  }
  const visited = new Set<string>();
  const results: ApplyRuleResult[] = [];
  for (const rule of options.rules) {
    if (rule.scope !== "contact") {
      results.push({
        ruleId: rule.id,
        matched: false,
        trace: [{ reason: "scope-mismatch", scope: rule.scope }],
        applied: [],
        skipped: [{ reason: "scope-not-applicable-for-contact", detail: { scope: rule.scope } }],
      });
      continue;
    }
    const result = applyContactRule({
      rule,
      contact,
      apply: options.apply,
      now: options.now,
      visited,
      cause: options.cause,
    });
    results.push(result);
  }
  return results;
}

export interface EvaluateRulesForChatOptions {
  rules: TagRule[];
  chatId: string;
  cause: { evaluation: "reactive" | "periodic" | "manual"; triggerType?: string };
  apply?: boolean;
  now?: number;
}

export function evaluateRulesForChat(options: EvaluateRulesForChatOptions): ApplyRuleResult[] {
  const visited = new Set<string>();
  const results: ApplyRuleResult[] = [];
  for (const rule of options.rules) {
    if (rule.scope !== "chat") {
      results.push({
        ruleId: rule.id,
        matched: false,
        trace: [{ reason: "scope-mismatch", scope: rule.scope }],
        applied: [],
        skipped: [{ reason: "scope-not-applicable-for-chat", detail: { scope: rule.scope } }],
      });
      continue;
    }
    const result = applyChatRule({
      rule,
      chatId: options.chatId,
      apply: options.apply,
      now: options.now,
      visited,
      cause: options.cause,
    });
    results.push(result);
  }
  return results;
}
