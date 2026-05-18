import { addContactTag, getContactById, removeContactTag, type Contact } from "../contacts.js";
import { tryNormalizeTagSlug } from "../tags/tag-db.js";
import { evaluateContactConditions } from "./conditions.js";
import type { AppliedTagAction, ApplyAction, TagRule } from "./types.js";

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

  const conditionResult = evaluateContactConditions({ conditions: rule.conditions, contact, now });
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
