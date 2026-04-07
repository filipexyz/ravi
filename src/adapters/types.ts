import { z } from "zod";
import { ContextCapabilitySchema, ContextSourceSchema } from "../router/router-db.js";

export const RESERVED_RAVI_ENV_KEYS = [
  "RAVI_CONTEXT_KEY",
  "RAVI_AGENT_ID",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
] as const;

const reservedEnvKeys = new Set<string>(RESERVED_RAVI_ENV_KEYS);

export const SessionAdapterStatusSchema = z.enum(["configured", "running", "stopped", "broken"]);
export type SessionAdapterStatus = z.infer<typeof SessionAdapterStatusSchema>;

const EMPTY_ENV = {
  allow: [],
  set: {},
} satisfies {
  allow: string[];
  set: Record<string, string>;
};

export const SessionAdapterEnvSchema = z
  .object({
    // Additional host env keys the runtime may forward to the adapter process.
    allow: z.array(z.string().min(1)).default([]),
    // Static env values configured as part of the adapter definition.
    set: z.record(z.string(), z.string()).default({}),
  })
  .default(EMPTY_ENV)
  .superRefine((env, ctx) => {
    for (const key of env.allow) {
      if (!reservedEnvKeys.has(key)) continue;
      ctx.addIssue({
        code: "custom",
        message: `${key} is reserved; use bindings.context instead of passing Ravi identity through env`,
        path: ["allow"],
      });
    }

    for (const key of Object.keys(env.set)) {
      if (!reservedEnvKeys.has(key)) continue;
      ctx.addIssue({
        code: "custom",
        message: `${key} is reserved; the runtime injects Ravi context explicitly`,
        path: ["set", key],
      });
    }
  });

export type SessionAdapterEnv = z.infer<typeof SessionAdapterEnvSchema>;

export const SessionAdapterCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: SessionAdapterEnvSchema,
  timeoutMs: z.number().int().positive().optional(),
});

export type SessionAdapterCommand = z.infer<typeof SessionAdapterCommandSchema>;

export const SessionAdapterLifecycleSchema = z.object({
  install: SessionAdapterCommandSchema.optional(),
  start: SessionAdapterCommandSchema,
  stop: SessionAdapterCommandSchema.optional(),
  restart: SessionAdapterCommandSchema.optional(),
});

export type SessionAdapterLifecycle = z.infer<typeof SessionAdapterLifecycleSchema>;

export const SessionAdapterContextBindingSchema = z.object({
  cliName: z.string().min(1),
  kind: z.string().min(1).default("cli-runtime"),
  capabilities: z.array(ContextCapabilitySchema).default([]),
  inheritCapabilities: z.boolean().default(false),
  ttlMs: z.number().int().positive().optional(),
});

export type SessionAdapterContextBinding = z.infer<typeof SessionAdapterContextBindingSchema>;

export const SessionAdapterBindingSchema = z.object({
  sessionKey: z.string().min(1),
  sessionName: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  source: ContextSourceSchema.optional(),
  // Context issuance is the canonical way to bind Ravi identity to the adapter process.
  context: SessionAdapterContextBindingSchema,
});

export type SessionAdapterBinding = z.infer<typeof SessionAdapterBindingSchema>;

export const SessionAdapterDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  transport: z.literal("stdio-json").default("stdio-json"),
  lifecycle: SessionAdapterLifecycleSchema,
  bindings: SessionAdapterBindingSchema,
});

export type SessionAdapterDefinition = z.infer<typeof SessionAdapterDefinitionSchema>;

export const SessionAdapterSubscriptionDirectionSchema = z.enum(["to-adapter", "from-adapter"]);
export type SessionAdapterSubscriptionDirection = z.infer<typeof SessionAdapterSubscriptionDirectionSchema>;

export const SessionAdapterSubscriptionSchema = z.object({
  subscriptionId: z.string().min(1),
  adapterId: z.string().min(1),
  sessionKey: z.string().min(1),
  direction: SessionAdapterSubscriptionDirectionSchema,
  topic: z.string().min(1),
  enabled: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type SessionAdapterSubscription = z.infer<typeof SessionAdapterSubscriptionSchema>;
