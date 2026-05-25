import { z } from "zod";

// Mirror the condition schemas from tag-rules/types.ts.
// Those internal constants are not exported, so we define equivalent schemas here.
// Evaluation still delegates to evaluateContactConditions / evaluateChatConditions from tag-rules.

const DurationOperatorSchema = z.enum([">", "<", ">=", "<=", "="]);
const NumericOperatorSchema = z.enum([">", "<", ">=", "<=", "=", "!="]);
const DurationSchema = z
  .string()
  .regex(/^\d+\s*(s|m|h|d|w)$/i, "Duration must look like '7d', '24h', '30m', '60s', or '2w'");
const ChatTypeSchema = z.enum(["dm", "group", "channel", "thread"]);

const ChatConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("any-message-text-matches"),
    pattern: z.string().min(1),
    lastN: z.number().int().positive().optional(),
    from: z.enum(["any", "contact", "agent"]).optional(),
  }),
  z.object({
    kind: z.literal("message-count"),
    operator: NumericOperatorSchema,
    value: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("last-inbound-age"), operator: DurationOperatorSchema, duration: DurationSchema }),
  z.object({ kind: z.literal("chat-type"), value: ChatTypeSchema }),
  z.object({ kind: z.literal("has-tag"), tag: z.string().min(1) }),
  z.object({ kind: z.literal("not-has-tag"), tag: z.string().min(1) }),
]);

const ContactConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("has-tag"), tag: z.string().min(1) }),
  z.object({ kind: z.literal("not-has-tag"), tag: z.string().min(1) }),
  z.object({ kind: z.literal("has-any-tag"), tags: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("has-all-tags"), tags: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("last-inbound-age"), operator: DurationOperatorSchema, duration: DurationSchema }),
  z.object({
    kind: z.literal("status"),
    value: z.enum(["allowed", "pending", "blocked", "discovered"]),
  }),
  z.object({ kind: z.literal("has-chat-with"), conditions: z.array(ChatConditionSchema).min(1) }),
]);

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
