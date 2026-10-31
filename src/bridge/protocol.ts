/** Canonical wire contract. Fleet vendors this file byte-for-byte as src/shared/human-bridge.ts. */
import { z } from "zod";

export const BRIDGE_PROTOCOL = "ravi-human-bridge/2" as const;
export const BRIDGE_COMMAND = "ravi bridge serve-stdio";
export const MAX_FRAME_BYTES = 65_536;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const LEASE_MS = 30_000;
export const capabilitySchema = z
  .object({
    permission: z.string().min(1).max(100),
    objectType: z.string().min(1).max(100),
    objectId: z.string().min(1).max(300),
  })
  .strict();
export type BridgeCapability = z.infer<typeof capabilitySchema>;
const id = z.string().uuid();
const agentId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const base = { requestId: id, createdAt: z.number().int().positive(), projectId: id };
const conversation = { ...base, conversationId: id };
export const bridgeRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...base, operation: z.literal("agents.list") }).strict(),
  z.object({ ...base, operation: z.literal("conversations.list") }).strict(),
  z.object({ ...base, operation: z.literal("conversations.create"), agentId }).strict(),
  z.object({ ...conversation, operation: z.literal("conversations.open") }).strict(),
  z.object({ ...conversation, operation: z.literal("messages.list"), before: id.nullable() }).strict(),
  z
    .object({
      ...conversation,
      operation: z.literal("messages.send"),
      text: z.string().min(1).max(16_384),
      expectedVersion: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ ...conversation, operation: z.literal("events.read"), cursor: z.string().max(1500).nullable() }).strict(),
  z.object({ ...conversation, operation: z.literal("lease.renew") }).strict(),
  z.object({ ...conversation, operation: z.literal("turns.cancel"), turnId: id }).strict(),
  z
    .object({
      ...conversation,
      operation: z.literal("approvals.decide"),
      approvalId: id,
      decision: z.enum(["approve", "reject"]),
      expectedVersion: z.number().int().positive(),
      actionDigest: z.string().length(64),
    })
    .strict(),
  z.object({ ...base, operation: z.literal("requests.get"), targetRequestId: id }).strict(),
]);
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export const bridgeGrantSchema = z.object({
  protocol: z.literal(BRIDGE_PROTOCOL),
  orgId: id,
  installationId: id,
  enrollmentId: id,
  epoch: z.number().int().positive(),
  projectId: id,
  connectionId: id,
  policyRevision: z.number().int().positive(),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  agents: z
    .array(
      z
        .object({
          id: agentId,
          capabilities: z.array(capabilitySchema).max(100),
          approvalCapabilities: z.array(capabilitySchema).max(100),
        })
        .strict(),
    )
    .max(100)
    .refine((items) => new Set(items.map((a) => a.id)).size === items.length),
  canSend: z.boolean(),
  requestDigest: z.string().length(64),
  canApprove: z.boolean(),
});
export type BridgeGrant = z.infer<typeof bridgeGrantSchema> & { sub: string; iss: string; jti: string; exp: number };
export type BridgeTurnStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "authorization_expired"
  | "interrupted_unknown";
export interface BridgeMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  turnId: string;
  createdAt: number;
}
export interface BridgeApproval {
  id: string;
  turnId: string;
  capability: BridgeCapability;
  description: string;
  actionDigest: string;
  version: number;
  expiresAt: number;
  state: "pending" | "approved" | "rejected" | "expired" | "invalidated";
}
export interface BridgeTurn {
  id: string;
  status: BridgeTurnStatus;
  cancelRequested: boolean;
}
export interface BridgeConversation {
  id: string;
  agentId: string;
  title: string;
  version: number;
  updatedAt: number;
}
export interface BridgeSnapshot {
  conversation: BridgeConversation;
  messages: BridgeMessage[];
  hasOlder: boolean;
  turn: BridgeTurn | null;
  approvals: BridgeApproval[];
  cursor: string;
}
export interface BridgeEvent {
  sequence: number;
  type: string;
  data: unknown;
  createdAt: number;
}
export type BridgeResult =
  | { ok: true; requestId: string; data: unknown }
  | { ok: false; requestId: string; error: string; effectState: "none" | "unknown" };
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    readonly effectState: "none" | "unknown" = "none",
  ) {
    super(code);
  }
}

/** Deterministic JSON, shared by the signer and verifier. No user-defined toJSON. */
export function canonicalBridgeJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalBridgeJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalBridgeJson(record[key])}`)
    .join(",")}}`;
}
