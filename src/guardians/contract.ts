import { z } from "zod";

export const AGENT_CONTEXT_GUARDIANS_DEFAULTS_KEY = "contextGuardians";

export const ContextGuardianScopeSchema = z.enum(["work_execution"]);
export type ContextGuardianScope = z.infer<typeof ContextGuardianScopeSchema>;

export const ContextGuardianSurfaceSchema = z.enum(["tasks", "sessions"]);
export type ContextGuardianSurface = z.infer<typeof ContextGuardianSurfaceSchema>;

export const ContextDriftKindSchema = z.enum(["front_switch_without_closure", "follow_up_overdue", "priority_drift"]);
export type ContextDriftKind = z.infer<typeof ContextDriftKindSchema>;

export const EscalationSeveritySchema = z.enum(["low", "medium", "high"]);
export type EscalationSeverity = z.infer<typeof EscalationSeveritySchema>;

export const RecurringExecutionSessionTargetSchema = z.enum(["task", "main"]);
export type RecurringExecutionSessionTarget = z.infer<typeof RecurringExecutionSessionTargetSchema>;

export const RecurringScheduleSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("every"),
      every: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cron"),
      cron: z.string().min(1),
      timezone: z.string().min(1).optional(),
    })
    .strict(),
]);
export type RecurringSchedule = z.infer<typeof RecurringScheduleSchema>;

export const TaskTriggerSchema = z
  .object({
    kind: z.literal("schedule"),
    schedule: RecurringScheduleSchema,
    enabled: z.boolean().default(true),
  })
  .strict();
export type TaskTrigger = z.infer<typeof TaskTriggerSchema>;

export const ContextTargetSchema = z
  .object({
    agentId: z.string().min(1),
    scope: ContextGuardianScopeSchema,
    surfaces: z.array(ContextGuardianSurfaceSchema).min(1).default(["tasks"]),
  })
  .strict();
export type ContextTarget = z.infer<typeof ContextTargetSchema>;

export const EscalationPolicySchema = z
  .object({
    targetSession: z.string().min(1),
    notifyOn: z.array(ContextDriftKindSchema).min(1),
    minimumSeverity: EscalationSeveritySchema.default("medium"),
  })
  .strict();
export type EscalationPolicy = z.infer<typeof EscalationPolicySchema>;

export const ContextGuardianSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    objective: z.string().min(1),
    stableContractRef: z.string().min(1),
    contextTarget: ContextTargetSchema,
    escalationPolicy: EscalationPolicySchema,
    enabled: z.boolean().default(true),
  })
  .strict();
export type ContextGuardian = z.infer<typeof ContextGuardianSchema>;

export const RecurringTaskStateSchema = z
  .object({
    status: z.enum(["active", "paused", "blocked"]),
    runCount: z.number().int().min(0).default(0),
    lastTaskId: z.string().min(1).optional(),
    lastRunAt: z.number().int().nonnegative().optional(),
    nextDueAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RecurringTaskState = z.infer<typeof RecurringTaskStateSchema>;

export const RecurringTaskOutcomeSchema = z.enum(["noop", "alert", "blocked", "error"]);
export type RecurringTaskOutcome = z.infer<typeof RecurringTaskOutcomeSchema>;

export const RecurringTaskRunOutputSchema = z
  .object({
    outcome: RecurringTaskOutcomeSchema,
    summary: z.string().min(1),
    detectedDrifts: z.array(ContextDriftKindSchema).default([]),
    alertMessage: z.string().min(1).optional(),
    iterationContractRef: z.string().min(1).optional(),
    recordedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === "alert" && value.detectedDrifts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["detectedDrifts"],
        message: "alert output must include at least one detected drift",
      });
    }
    if (value.outcome === "alert" && !value.alertMessage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["alertMessage"],
        message: "alert output must include an alert message",
      });
    }
  });
export type RecurringTaskRunOutput = z.infer<typeof RecurringTaskRunOutputSchema>;

export const RecurringTaskExecutionSchema = z
  .object({
    agentId: z.string().min(1),
    sessionTarget: RecurringExecutionSessionTargetSchema.default("task"),
  })
  .strict();
export type RecurringTaskExecution = z.infer<typeof RecurringTaskExecutionSchema>;

export const RecurringTaskSchema = z
  .object({
    id: z.string().min(1),
    guardianId: z.string().min(1),
    agentId: z.string().min(1),
    title: z.string().min(1),
    instruction: z.string().min(1),
    trigger: TaskTriggerSchema,
    execution: RecurringTaskExecutionSchema,
    state: RecurringTaskStateSchema,
    lastOutput: RecurringTaskRunOutputSchema.optional(),
  })
  .strict();
export type RecurringTask = z.infer<typeof RecurringTaskSchema>;

export const AgentContextGuardiansConfigSchema = z
  .object({
    agentId: z.string().min(1),
    guardians: z.array(ContextGuardianSchema).min(1),
    recurringTasks: z.array(RecurringTaskSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const guardianIds = new Set<string>();
    const taskCountByGuardian = new Map<string, number>();

    for (const [index, guardian] of value.guardians.entries()) {
      guardianIds.add(guardian.id);
      taskCountByGuardian.set(guardian.id, 0);

      if (guardian.agentId !== value.agentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["guardians", index, "agentId"],
          message: "guardian agentId must match config agentId",
        });
      }

      if (guardian.contextTarget.agentId !== value.agentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["guardians", index, "contextTarget", "agentId"],
          message: "context target agentId must match config agentId",
        });
      }
    }

    for (const [index, recurringTask] of value.recurringTasks.entries()) {
      if (recurringTask.agentId !== value.agentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recurringTasks", index, "agentId"],
          message: "recurring task agentId must match config agentId",
        });
      }

      if (recurringTask.execution.agentId !== value.agentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recurringTasks", index, "execution", "agentId"],
          message: "execution agentId must match config agentId",
        });
      }

      if (!guardianIds.has(recurringTask.guardianId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recurringTasks", index, "guardianId"],
          message: "recurring task must reference an existing guardian",
        });
        continue;
      }

      taskCountByGuardian.set(recurringTask.guardianId, (taskCountByGuardian.get(recurringTask.guardianId) ?? 0) + 1);
    }

    for (const [index, guardian] of value.guardians.entries()) {
      if ((taskCountByGuardian.get(guardian.id) ?? 0) === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["guardians", index, "id"],
          message: "each guardian must own at least one recurring task",
        });
      }
    }
  });
export type AgentContextGuardiansConfig = z.infer<typeof AgentContextGuardiansConfigSchema>;

export function readAgentContextGuardiansConfig(
  defaults: Record<string, unknown> | undefined,
  expectedAgentId?: string,
): AgentContextGuardiansConfig | null {
  const raw = defaults?.[AGENT_CONTEXT_GUARDIANS_DEFAULTS_KEY];
  if (raw === undefined) {
    return null;
  }

  const parsed = AgentContextGuardiansConfigSchema.parse(raw);
  if (expectedAgentId && parsed.agentId !== expectedAgentId) {
    throw new Error(`context guardian config agentId mismatch: expected ${expectedAgentId}, got ${parsed.agentId}`);
  }

  return parsed;
}

export function writeAgentContextGuardiansConfig(
  defaults: Record<string, unknown> | undefined,
  config: AgentContextGuardiansConfig,
): Record<string, unknown> {
  const parsed = AgentContextGuardiansConfigSchema.parse(config);
  return {
    ...(defaults ?? {}),
    [AGENT_CONTEXT_GUARDIANS_DEFAULTS_KEY]: parsed,
  };
}
