export * from "./types.js";
export * from "./conditions.js";
export * from "./engine.js";
export * from "./loader.js";

import { evaluateRulesForContact, type ApplyRuleResult } from "./engine.js";
import { loadTagRulesFromDirectory, type LoadTagRulesResult } from "./loader.js";
import type { TagRule } from "./types.js";

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
