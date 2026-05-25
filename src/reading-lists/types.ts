import { ContactConditionSchema, ChatConditionSchema } from "../tag-rules/types.js";
export { ContactConditionSchema, ChatConditionSchema };

import { z } from "zod";

export const DynamicListSelectorSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("contact"),
    match: z.literal("all"),
    conditions: z.array(ContactConditionSchema).min(1),
  }),
  z.object({
    scope: z.literal("chat"),
    match: z.literal("all"),
    conditions: z.array(ChatConditionSchema).min(1),
  }),
]);

export type DynamicListSelector = z.infer<typeof DynamicListSelectorSchema>;

export type MembershipTransitionKind = "added" | "removed" | "reactivated" | "noop";

export interface MembershipTransition {
  listId: string;
  chatId: string;
  contactId: string | null;
  kind: MembershipTransitionKind;
  source: "selector";
  cause: {
    evaluation: "reactive" | "periodic" | "manual";
    triggerEvent: string;
    ruleId: string | null;
  };
}

export interface TickReadingListsResult {
  listsProcessed: number;
  targetsProcessed: number;
  added: number;
  removed: number;
  errors: number;
  permissionDenied: number;
  dryRun: boolean;
  transitions: MembershipTransition[];
}

export interface ExplainSelectorResult {
  listId: string;
  selector: DynamicListSelector;
  target: { type: "contact" | "chat"; id: string };
  matched: boolean;
  trace: Array<Record<string, unknown>>;
}
