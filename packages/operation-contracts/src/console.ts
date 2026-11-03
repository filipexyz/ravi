import { z } from "zod";
import type { OperationDescriptor, OperationRegistry } from "./index.js";

export const id = z.string().uuid();
export const empty = z.object({}).strict();
export const installationSchema = z.object({
  id, name: z.string(), platform: z.string().nullable(),
  status: z.enum(["pending", "online", "offline", "revoked"]),
  revision: z.number().int().nonnegative(), lastSeenAt: z.string().nullable(),
}).strict();
export const channelSchema = z.object({
  name: z.string().min(1).max(120), provider: z.string().min(1).max(80), enabled: z.boolean(),
  credentialConnection: z.string().max(200).nullable(),
}).strict();
export const runtimeHealthSchema = z.object({
  version: z.string(), platform: z.string(), channels: z.array(channelSchema).max(500),
}).strict();
export const slackIdentitySchema = z.object({ teamId: z.string().regex(/^T[A-Z0-9]+$/), botUserId: z.string().regex(/^[UW][A-Z0-9]+$/) }).strict();
export const channelConnectionSchema = z.object({ connection: z.string(), identity: slackIdentitySchema.nullable(), available: z.boolean() }).strict();
export const runtimeOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("health") }).strict(),
  z.object({ kind: z.literal("channels.inspect") }).strict(),
  z.object({ kind: z.literal("channel.configure"), name: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
    provider: z.literal("slack"), credentialConnection: z.string().min(1).max(200), enabled: z.boolean(),
    identity: slackIdentitySchema,
  }).strict(),
]);
export const operationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("health"), health: runtimeHealthSchema }).strict(),
  z.object({ kind: z.literal("channels.inspect"), connections: z.array(channelConnectionSchema).max(100), channels: z.array(channelSchema).max(500) }).strict(),
  z.object({ kind: z.literal("channel.configure"), channel: channelSchema }).strict(),
]);
export const managedChannelSchema = z.object({ id, name: z.string(), installationId: id, identity: slackIdentitySchema,
  credentialConnection: z.string(), enabled: z.boolean(), operationId: id, status: z.enum(["queued","delivered","succeeded","failed","uncertain","cancelled"]) }).strict();
export const operationSchema = z.object({
  id, installationId: id, status: z.enum(["queued", "delivered", "succeeded", "failed", "uncertain", "cancelled"]),
  createdAt: z.string(), result: operationResultSchema.nullable(), error: z.string().nullable(),
}).strict();
export const associationSchema = z.object({
  id, name: z.string(), platform: z.string(), fingerprint: z.string(), expiresAt: z.string(),
  status: z.enum(["pending", "approved", "expired", "denied"]), installationId: id.nullable(),
}).strict();
export const onboardingSchema = z.object({
  completed: z.boolean(), ready: z.boolean(), installations: z.array(installationSchema), snapshot: z.string(),
}).strict();
export const mutation = z.object({ operationId: id });
export const associationApproveSchema = mutation.extend({ associationId: id, challenge: z.string().min(32).max(256),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(120),
}).strict();
export const enqueueSchema = mutation.extend({ installationId: id, command: runtimeOperationSchema }).strict();
export const revokeSchema = mutation.extend({ installationId: id, expectedRevision: z.number().int().nonnegative() }).strict();
export const finishSchema = mutation.extend({ snapshot: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** New operations have explicit ownership/audience and fully typed outputs. */
function operation<I extends z.ZodType, O extends z.ZodType>(group: string, command: string, input: I, output: O) {
  return {
    groupPath: group, groupSegments: group.split("."), command, fullName: `${group}.${command}`,
    description: `${group} ${command}`, scope: "resource", service: "console", audience: "human",
    args: [{ name: "input", index: 0, required: true, variadic: false, schema: input }],
    options: [], returns: output,
  } satisfies OperationDescriptor;
}
export const consoleOperations = {
  "channels.list": operation("channels", "list", empty, z.object({ channels: z.array(managedChannelSchema) }).strict()),
  "installations.list": operation("installations", "list", empty, z.object({ installations: z.array(installationSchema) }).strict()),
  "installations.revoke": operation("installations", "revoke", revokeSchema, installationSchema),
  "associations.show": operation("associations", "show", z.object({ associationId: id, challenge: z.string().min(32).max(256) }).strict(), associationSchema),
  "associations.approve": operation("associations", "approve", associationApproveSchema, installationSchema),
  "operations.enqueue": operation("operations", "enqueue", enqueueSchema, operationSchema),
  "operations.latest": operation("operations", "latest", z.object({ installationId: id }).strict(), z.object({ operation: operationSchema.nullable() }).strict()),
  "operations.show": operation("operations", "show", z.object({ operationId: id }).strict(), operationSchema),
  "onboarding.state": operation("onboarding", "state", empty, onboardingSchema),
  "onboarding.finish": operation("onboarding", "finish", finishSchema, onboardingSchema),
} as const;
export type ConsoleOperationName = keyof typeof consoleOperations;
export const consoleRegistry: OperationRegistry = { commands: Object.values(consoleOperations) };
export type Installation = z.infer<typeof installationSchema>;
export type RuntimeOperation = z.infer<typeof runtimeOperationSchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;
export type ManagedOperation = z.infer<typeof operationSchema>;

export const associationStartSchema = z.object({ name: z.string().trim().min(1).max(120),
  platform: z.string().max(80), csr: z.string().min(200).max(8192),
  challenge: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const associationPollSchema = z.object({ associationId: id, challenge: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const receiptSchema = z.object({ operationId: id, digest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["succeeded", "failed", "uncertain"]), result: operationResultSchema.nullable(),
  error: z.enum(["execution_failed", "result_unknown", "grant_expired", "receipt_conflict"]).nullable(),
}).strict();
export const commandEnvelopeSchema = z.object({
  operationId: id, installationId: id, organizationId: id, subject: id,
  sessionId: z.string().min(1).max(200), revision: z.number().int().positive(),
  createdAt: z.string(), expiresAt: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  command: runtimeOperationSchema,
}).strict();
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
