import { z } from "zod";

const DurationOperatorSchema = z.enum([">", "<", ">=", "<=", "="]);
export type DurationOperator = z.infer<typeof DurationOperatorSchema>;

const NumericOperatorSchema = z.enum([">", "<", ">=", "<=", "=", "!="]);
export type NumericOperator = z.infer<typeof NumericOperatorSchema>;

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
  z.object({
    kind: z.literal("last-inbound-age"),
    operator: DurationOperatorSchema,
    duration: DurationSchema,
  }),
  z.object({
    kind: z.literal("chat-type"),
    value: ChatTypeSchema,
  }),
  z.object({
    kind: z.literal("has-tag"),
    tag: z.string().min(1),
  }),
  z.object({
    kind: z.literal("not-has-tag"),
    tag: z.string().min(1),
  }),
]);
export type ChatCondition = z.infer<typeof ChatConditionSchema>;

const ContactConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("has-tag"),
    tag: z.string().min(1),
  }),
  z.object({
    kind: z.literal("not-has-tag"),
    tag: z.string().min(1),
  }),
  z.object({
    kind: z.literal("has-any-tag"),
    tags: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal("has-all-tags"),
    tags: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal("last-inbound-age"),
    operator: DurationOperatorSchema,
    duration: DurationSchema,
  }),
  z.object({
    kind: z.literal("status"),
    value: z.enum(["allowed", "pending", "blocked", "discovered"]),
  }),
  z.object({
    kind: z.literal("has-chat-with"),
    conditions: z.array(ChatConditionSchema).min(1),
  }),
]);
export type ContactCondition = z.infer<typeof ContactConditionSchema>;

const ApplyActionSchema = z.object({
  target: z.literal("contact"),
  targetMode: z.enum(["all", "matched"]).optional(),
  tag: z.string().min(1).optional(),
  removeTag: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  when: z.enum(["matched", "not-matched"]).default("matched"),
});
export type ApplyAction = z.infer<typeof ApplyActionSchema>;

export const TagRuleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "Rule id must be a slug-ish identifier"),
    description: z.string().optional(),
    enabled: z.boolean().default(true),
    scope: z.literal("contact"),
    conditions: z.array(ContactConditionSchema).default([]),
    apply: z.array(ApplyActionSchema).min(1),
    priority: z.number().int().default(0),
    evaluation: z
      .object({
        reactive: z.boolean().default(true),
        cron: z.string().nullable().optional(),
      })
      .default({ reactive: true, cron: null }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((rule, ctx) => {
    for (const action of rule.apply) {
      if (!action.tag && !action.removeTag) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each apply action MUST set at least one of 'tag' or 'removeTag'",
          path: ["apply"],
        });
      }
    }
  });
export type TagRule = z.infer<typeof TagRuleSchema>;

export const TagRuleInputSchema = TagRuleSchema;

export interface ConditionEvaluation {
  matched: boolean;
  cause: Record<string, unknown>;
}

export interface RuleEvaluationCause {
  evaluation: "reactive" | "periodic" | "manual";
  triggerType?: string;
  triggerData?: Record<string, unknown>;
}

export interface AppliedTagAction {
  ruleId: string;
  target: { type: "contact"; id: string };
  added: string[];
  removed: string[];
  noop: boolean;
  cause: Record<string, unknown>;
  cascadeDepth: number;
}

export interface RuleEvaluationOutcome {
  ruleId: string;
  matched: boolean;
  conditionTrace: Record<string, unknown>;
  applied: AppliedTagAction[];
  skipped: Array<{ reason: string; detail?: Record<string, unknown> }>;
}
