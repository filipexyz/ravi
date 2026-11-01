import { z } from "zod";
import { handoffSchema } from "./team-handoff.js";

const id = z.string().uuid();
export const teamSchema = z.object({
  ownerAgentId: z.string(),
  memory: z.array(z.string()),
  members: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("agent"), agentId: z.string() }),
      z.object({ kind: z.literal("person"), personId: id, name: z.string(), role: z.enum(["owner", "member"]) }),
    ]),
  ),
});
export const conversationSchema = z.object({
  team: teamSchema.optional(),
  id,
  agentId: z.string(),
  title: z.string(),
  version: z.number().int(),
  updatedAt: z.number(),
});
export const deliveryBarrierSchema = z.enum(["after_tool", "after_reply", "after_task", "record_only"]);
export const messageDeliverySchema = z.enum(["sent", "queued", "recorded", "cancelled", "expired"]);
export const replyToSchema = z.object({ authorName: z.string().max(200), excerpt: z.string().max(2000) }).strict();
export const messageSchema = z.object({
  handoff: handoffSchema.optional(),
  authorId: z.string().optional(),
  authorName: z.string().optional(),
  requestId: id.optional(),
  barrier: deliveryBarrierSchema.optional(),
  delivery: messageDeliverySchema.optional(),
  replyTo: replyToSchema.optional(),
  id,
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  turnId: id,
  createdAt: z.number(),
});
export const historySchema = z.object({ messages: z.array(messageSchema), hasOlder: z.boolean() });
export const turnStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "authorization_expired",
  "interrupted_unknown",
]);
export const approvalSchema = z.object({
  id,
  turnId: id,
  capability: z.object({ permission: z.string(), objectType: z.string(), objectId: z.string() }),
  description: z.string(),
  actionDigest: z.string(),
  version: z.number(),
  expiresAt: z.number(),
  state: z.enum(["pending", "approved", "rejected", "expired", "invalidated"]),
});
export const snapshotSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(messageSchema),
  hasOlder: z.boolean(),
  cursor: z.string(),
  turn: z
    .object({ id, status: turnStatusSchema, cancelRequested: z.boolean(), agentId: z.string().optional() })
    .nullable(),
  approvals: z.array(approvalSchema),
});
const eventBase = z.object({ sequence: z.number().int(), createdAt: z.number() });
export const journalEventSchema = z.discriminatedUnion("type", [
  eventBase.extend({
    type: z.literal("handoff.state"),
    data: z.object({ id, status: z.enum(["pending", "accepted", "cancelled", "expired"]) }),
  }),
  eventBase.extend({ type: z.literal("message.delivery"), data: z.object({ id, delivery: messageDeliverySchema }) }),
  eventBase.extend({ type: z.literal("message.accepted"), data: messageSchema }),
  eventBase.extend({ type: z.literal("message.finalized"), data: messageSchema }),
  eventBase.extend({
    type: z.literal("turn.state"),
    data: z.object({ id, status: turnStatusSchema, cancelRequested: z.boolean(), agentId: z.string().optional() }),
  }),
  eventBase.extend({ type: z.literal("turn.activity"), data: z.object({ turnId: id, status: z.string() }) }),
  eventBase.extend({ type: z.literal("cancel.requested"), data: z.object({ turnId: id }) }),
  eventBase.extend({ type: z.literal("approval.opened"), data: approvalSchema }),
  eventBase.extend({
    type: z.literal("approval.state"),
    data: z.object({
      id,
      state: z.enum(["approved", "rejected", "expired", "invalidated"]),
      version: z.number().optional(),
    }),
  }),
]);
export const journalSchema = z.object({ events: z.array(journalEventSchema), cursor: z.string() });
export const createdSchema = z.object({ conversationId: id, conversation: conversationSchema });
export const acceptedSchema = z.object({
  delivery: messageDeliverySchema.optional(),
  accepted: z.literal(true),
  conversationId: id,
  messageId: id,
  turnId: id,
  version: z.number(),
});
export const cancelledSchema = z.object({
  conversationId: id,
  turnId: id,
  cancelRequested: z.boolean(),
  status: turnStatusSchema,
});
export const decidedSchema = z.object({
  conversationId: id,
  approvalId: id,
  state: z.enum(["approved", "rejected"]),
  version: z.number(),
});
export const receiptSchema = z.union([createdSchema, acceptedSchema, cancelledSchema, decidedSchema]);
