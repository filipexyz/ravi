export * from "./types.js";
export * from "./conditions.js";
export * from "./engine.js";
export * from "./loader.js";

import { setImmediate as yieldImmediate } from "node:timers/promises";
import { dbListChatIdsByContactIds } from "../router/router-db.js";
import { evaluateRulesForContact, type ApplyRuleResult } from "./engine.js";
import { loadTagRulesFromDirectory, type LoadTagRulesResult } from "./loader.js";
import type { ContactCondition, TagRule } from "./types.js";

export interface RunTagRulesForContactOptions {
  contactRef: string;
  cause: { evaluation: "reactive" | "periodic" | "manual"; triggerType?: string };
  apply?: boolean;
  now?: number;
  directory?: string;
}

export interface RunTagRulesForContactResult {
  contactRef: string;
  rules: { total: number; matched: number; appliedActions: number };
  loaded: LoadTagRulesResult;
  outcomes: ApplyRuleResult[];
}

export function runTagRulesForContact(options: RunTagRulesForContactOptions): RunTagRulesForContactResult {
  const loaded = loadTagRulesFromDirectory(options.directory);
  const rules: TagRule[] = loaded.rules.map((entry) => entry.rule);
  const outcomes = evaluateRulesForContact({
    rules,
    contactRef: options.contactRef,
    cause: options.cause,
    apply: options.apply,
    now: options.now,
  });
  const matched = outcomes.filter((outcome) => outcome.matched).length;
  const appliedActions = outcomes.reduce(
    (total, outcome) => total + outcome.applied.filter((action) => !action.noop).length,
    0,
  );
  return {
    contactRef: options.contactRef,
    rules: { total: rules.length, matched, appliedActions },
    loaded,
    outcomes,
  };
}

export interface TickTagRulesOptions {
  apply?: boolean;
  limit?: number;
  yieldEvery?: number;
  cause?: { evaluation: "periodic" | "manual"; triggerType?: string };
  directory?: string;
  now?: number;
}

export interface TickTagRulesResult {
  rulesLoaded: number;
  loadErrors: LoadTagRulesResult["errors"];
  contactsProcessed: number;
  matched: number;
  appliedActions: number;
  contacts: Array<{
    contactId: string;
    matched: number;
    appliedActions: number;
  }>;
}

function ruleNeedsContactChats(rule: TagRule): boolean {
  if (rule.scope !== "contact") return false;
  return (rule.conditions as ContactCondition[]).some((condition) => condition.kind === "has-chat-with");
}

export async function tickTagRules(options: TickTagRulesOptions = {}): Promise<TickTagRulesResult> {
  const { getAllContacts } = await import("../contacts.js");
  const loaded = loadTagRulesFromDirectory(options.directory);
  const rules: TagRule[] = loaded.rules.map((entry) => entry.rule);
  const cause = options.cause ?? { evaluation: "periodic" as const, triggerType: "tick" };
  const limit = options.limit && options.limit > 0 ? options.limit : undefined;
  const yieldEvery = options.yieldEvery && options.yieldEvery > 0 ? Math.floor(options.yieldEvery) : 50;
  const allContacts = getAllContacts();
  const contactsSlice = limit ? allContacts.slice(0, limit) : allContacts;
  const evaluationContext = rules.some(ruleNeedsContactChats)
    ? { chatIdsByContactId: dbListChatIdsByContactIds({ contactIds: contactsSlice.map((contact) => contact.id) }) }
    : undefined;
  const summary: TickTagRulesResult = {
    rulesLoaded: rules.length,
    loadErrors: loaded.errors,
    contactsProcessed: 0,
    matched: 0,
    appliedActions: 0,
    contacts: [],
  };
  for (const contact of contactsSlice) {
    const outcomes = evaluateRulesForContact({
      rules,
      contactRef: contact.id,
      cause,
      apply: options.apply,
      now: options.now,
      evaluationContext,
    });
    const matchedForContact = outcomes.filter((outcome) => outcome.matched).length;
    const appliedForContact = outcomes.reduce(
      (total, outcome) => total + outcome.applied.filter((action) => !action.noop).length,
      0,
    );
    summary.contactsProcessed += 1;
    summary.matched += matchedForContact;
    summary.appliedActions += appliedForContact;
    if (matchedForContact > 0 || appliedForContact > 0) {
      summary.contacts.push({
        contactId: contact.id,
        matched: matchedForContact,
        appliedActions: appliedForContact,
      });
    }
    if (summary.contactsProcessed % yieldEvery === 0) {
      await yieldImmediate();
    }
  }
  return summary;
}
