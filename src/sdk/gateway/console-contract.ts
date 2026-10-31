/** Authority and transport envelope only. Command schemas come from the CLI registry. */
import { z } from "zod";

export const CONSOLE_PROTOCOL = "ravi-console-gateway/1" as const;
export const CONSOLE_SSH_COMMAND = "ravi bridge serve-stdio";
export const CONSOLE_PROOF_PATH = "/api/v1/_meta/runtime-proof";
export const CONSOLE_STREAM_PATH = "/api/v1/_stream/session-view";
export const CONSOLE_MAX_BODY = 65_536;
export const CONSOLE_MAX_RESPONSE = 8 * 1024 * 1024;
const id = z.string().uuid();
const opaque = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z.object({ permission: opaque, objectType: opaque, objectId: z.string().min(1).max(300) }).strict();

/** Issued by the Console authentication adapter, never copied from browser input. */
export const invocationOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("browser"), sessionId: opaque }).strict(),
  z.object({ kind: z.literal("channel"), connectorId: opaque, conversationId: opaque, deliveryId: opaque }).strict(),
  z.object({ kind: z.literal("automation"), automationId: opaque, deliveryId: opaque }).strict(),
]);
export const consoleGrantSchema = z
  .object({
    protocol: z.literal(CONSOLE_PROTOCOL),
    orgId: id,
    installationId: id,
    enrollmentId: id,
    epoch: z.number().int().positive(),
    projectId: id,
    connectionId: id,
    policyRevision: z.number().int().positive(),
    policyDigest: digest,
    origin: invocationOriginSchema,
    operationId: id,
    createdAt: z.number().int().positive(),
    requestDigest: digest,
    // Command-control permission is independent of the agent's execution capabilities below.
    command: z.string().min(1).max(200),
    access: z.object({ kind: z.enum(["read", "mutate"]), resource: opaque, action: opaque }).strict(),
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("installation") }).strict(),
      z.object({ kind: z.literal("project") }).strict(),
      z.object({ kind: z.literal("session"), conversationId: id }).strict(),
    ]),
    agents: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
            capabilities: z.array(capability).max(100),
            approvalCapabilities: z.array(capability).max(100),
          })
          .strict(),
      )
      .max(100)
      .refine((items) => new Set(items.map((a) => a.id)).size === items.length),
    canSend: z.boolean(),
    canApprove: z.boolean(),
  })
  .strict();
export type ConsoleGrant = z.infer<typeof consoleGrantSchema> & { sub: string; iss: string; jti: string; exp: number };
export type InvocationOrigin = z.infer<typeof invocationOriginSchema>;

/** Digest exact HTTP target and bytes, including cursor. Never canonicalize a client-selected URL. */
export function consoleRequestMaterial(
  method: string,
  target: string,
  body: string,
  operationId: string,
  createdAt: number,
) {
  return JSON.stringify([CONSOLE_PROTOCOL, method, target, body, operationId, createdAt]);
}
