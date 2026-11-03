// Interactive/linked-human inbox v2. Internal outbox sequences never cross this
// boundary. No service principal is invented for installation-only background work.
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { cliApiError } from "@/server/cli/errors";
import { accessibleProjectsInTransaction } from "./authorization/store";
import type { AuthorizationExecutor } from "./authorization/identity";
import { deliveryItem, type AgentInboxWorkspace, type AgentInboxPulse, type InboxPollAckInput } from "./agent-inbox";

type Subscription = typeof schema.agentInboxSubscriptions.$inferSelect;
const name = (workspace: AgentInboxWorkspace) => `project-policy-v2:${workspace.user.id}`;
const MAX_VISIBLE_ITEMS = 20_000;
const leaseMs = 60_000;

async function snapshot(tx: AuthorizationExecutor, workspace: AgentInboxWorkspace) {
  if (!workspace.authorization || workspace.authorization.installationId !== workspace.localInstallation.id) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED", "Inbox requires a verified human and installation.");
  }
  const projects = await accessibleProjectsInTransaction(tx, { organizationId: workspace.organization.id,
    userId: workspace.user.id, delegation: workspace.authorization });
  const ids = projects.map((project) => project.id);
  const rows = ids.length ? await tx.select({ id: schema.agentInboxItems.id, sequence: schema.agentInboxItems.sequence,
    occurredAt: schema.agentInboxItems.occurredAt, createdAt: schema.agentInboxItems.createdAt })
    .from(schema.agentInboxItems).where(and(eq(schema.agentInboxItems.organizationId, workspace.organization.id),
      inArray(schema.agentInboxItems.projectId, ids),
      or(ne(schema.agentInboxItems.targetType, "local_installation"), eq(schema.agentInboxItems.targetId, workspace.localInstallation.id)),
      // Bases subscriptions may use different view filters for two humans on
      // the SAME installation. Filter metadata before count/cursor/payload.
      // Legacy recipient-less items remain stored but cannot cross this gate.
      or(ne(schema.agentInboxItems.category, "bases"), sql`exists (
        select 1 from ${schema.baseSubscriptions} as recipient
        where recipient.id::text = ${schema.agentInboxItems.payloadJson}->>'subscriptionId'
          and recipient.user_id = ${workspace.user.id}
          and recipient.organization_id = ${workspace.organization.id}
          and recipient.project_id = ${schema.agentInboxItems.projectId}
          and recipient.local_installation_id = ${workspace.localInstallation.id}
          and recipient.status = 'active'
      )`),
      or(isNull(schema.agentInboxItems.expiresAt), gt(schema.agentInboxItems.expiresAt, new Date()))))
    .orderBy(asc(schema.agentInboxItems.sequence)).limit(MAX_VISIBLE_ITEMS + 1) : [];
  if (rows.length > MAX_VISIBLE_ITEMS) throw cliApiError(503, "SERVER_UNAVAILABLE", "Scoped inbox retention limit reached.");
  // Hash only visible identities; hidden project traffic cannot change pulse/ETag.
  const cacheKey = createHash("sha256").update(JSON.stringify([workspace.user.id, workspace.localInstallation.id,
    ids.sort(), rows.map((row) => row.id)])).digest("hex");
  return { rows, cacheKey };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

async function subscriptionFor(tx: AuthorizationExecutor, workspace: AgentInboxWorkspace, id?: string | null) {
  const [subscription] = await tx.select().from(schema.agentInboxSubscriptions).where(and(
    eq(schema.agentInboxSubscriptions.organizationId, workspace.organization.id),
    eq(schema.agentInboxSubscriptions.localInstallationId, workspace.localInstallation.id),
    eq(schema.agentInboxSubscriptions.userId, workspace.user.id),
    eq(schema.agentInboxSubscriptions.name, name(workspace)),
    ...(id ? [eq(schema.agentInboxSubscriptions.id, id)] : []))).limit(1).for("update");
  return subscription ?? null;
}

function pulse(workspace: AgentInboxWorkspace, scope: Snapshot, subscription: Subscription | null): AgentInboxPulse {
  const delivered = scope.rows.filter((row) => row.sequence <= (subscription?.lastDeliveredSequence ?? 0)).length;
  const latest = scope.rows.at(-1);
  return { version: 2, changed: Boolean(subscription && delivered < scope.rows.length), subscribed: Boolean(subscription),
    subscription: subscription ? { deliveryMode: subscription.deliveryMode, id: subscription.id, lastDeliveredSequence: delivered,
      lastPollAt: subscription.lastPollAt?.toISOString() ?? null, localInstallationId: subscription.localInstallationId,
      name: "project-scoped", status: subscription.status } : null,
    watermark: { cacheKey: scope.cacheKey, generation: scope.rows.length, latestSequence: scope.rows.length,
      latestItemAt: latest?.occurredAt.toISOString() ?? null, organizationId: workspace.organization.id,
      updatedAt: latest?.createdAt.toISOString() ?? new Date(0).toISOString() } };
}

export async function upsertScopedInbox(input: { body?: unknown; workspace: AgentInboxWorkspace }) {
  return db.transaction(async (tx) => {
    const scope = await snapshot(tx, input.workspace);
    const [subscription] = await tx.insert(schema.agentInboxSubscriptions).values({ organizationId: input.workspace.organization.id,
      userId: input.workspace.user.id, localInstallationId: input.workspace.localInstallation.id, name: name(input.workspace),
      status: "active", deliveryMode: "poll", capabilitiesJson: input.workspace.localInstallation.capabilitiesJson,
      metadataJson: { source: "cli-inbox", authorizationProtocol: 2 }, lastPollAt: new Date() })
      .onConflictDoUpdate({ target: [schema.agentInboxSubscriptions.organizationId, schema.agentInboxSubscriptions.localInstallationId,
        schema.agentInboxSubscriptions.name], set: { status: "active", lastPollAt: new Date(), updatedAt: new Date() } }).returning();
    if (!subscription) throw cliApiError(503, "SERVER_UNAVAILABLE");
    const result = pulse(input.workspace, scope, subscription);
    return { subscription: result.subscription!, pulse: result };
  });
}

export async function scopedInboxPulse(input: { subscriptionId?: string | null; workspace: AgentInboxWorkspace }) {
  return db.transaction(async (tx) => {
    const scope = await snapshot(tx, input.workspace);
    return pulse(input.workspace, scope, await subscriptionFor(tx, input.workspace, input.subscriptionId));
  });
}

export async function pollScopedInbox(input: { limit?: number; subscriptionId?: string | null; workspace: AgentInboxWorkspace }) {
  return db.transaction(async (tx) => {
    const scope = await snapshot(tx, input.workspace);
    const subscription = await subscriptionFor(tx, input.workspace, input.subscriptionId);
    if (!subscription) throw cliApiError(404, "PAYLOAD_INVALID", "Inbox subscription was not found.");
    if (subscription.status !== "active") throw cliApiError(403, "ORG_ACCESS_DENIED");
    const now = new Date(), leaseId = randomUUID(), leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
    const receipts = await tx.select().from(schema.agentInboxReceipts).where(eq(schema.agentInboxReceipts.subscriptionId, subscription.id));
    const byItem = new Map(receipts.map((receipt) => [receipt.itemId, receipt]));
    const pending = scope.rows.filter((row) => {
      const receipt = byItem.get(row.id);
      return row.sequence > subscription.lastDeliveredSequence && (!receipt || receipt.status === "failed" ||
        (receipt.status === "leased" && (!receipt.leaseExpiresAt || receipt.leaseExpiresAt <= now)));
    });
    const selected = pending.slice(0, limit), ordinals = new Map(scope.rows.map((row, index) => [row.id, index + 1]));
    const data = selected.length ? await tx.select().from(schema.agentInboxItems).where(inArray(schema.agentInboxItems.id, selected.map((row) => row.id)))
      .orderBy(asc(schema.agentInboxItems.sequence)) : [];
    const items = [];
    for (const item of data) {
      const previous = byItem.get(item.id);
      const [receipt] = previous ? await tx.update(schema.agentInboxReceipts).set({ status: "leased", leaseId, leaseExpiresAt, updatedAt: now })
        .where(eq(schema.agentInboxReceipts.id, previous.id)).returning() : await tx.insert(schema.agentInboxReceipts)
        .values({ subscriptionId: subscription.id, itemId: item.id, status: "leased", leaseId, leaseExpiresAt }).returning();
      if (!receipt) throw cliApiError(503, "SERVER_UNAVAILABLE");
      items.push({ ...deliveryItem(item, receipt, leaseId, leaseExpiresAt), sequence: ordinals.get(item.id)! });
    }
    await tx.update(schema.agentInboxSubscriptions).set({ lastPollAt: now, updatedAt: now }).where(eq(schema.agentInboxSubscriptions.id, subscription.id));
    return { ...pulse(input.workspace, scope, { ...subscription, lastPollAt: now }), hasMore: pending.length > limit, items,
      leaseId, leaseExpiresAt: items.length ? leaseExpiresAt.toISOString() : null, leaseSeconds: leaseMs / 1000,
      pollId: randomUUID(), serverTime: now.toISOString() };
  });
}

export async function ackScopedInbox(input: { acks: InboxPollAckInput[]; subscriptionId?: string; workspace: AgentInboxWorkspace }) {
  return db.transaction(async (tx) => {
    const scope = await snapshot(tx, input.workspace);
    const subscription = await subscriptionFor(tx, input.workspace, input.subscriptionId);
    if (!subscription || subscription.status !== "active") throw cliApiError(404, "PAYLOAD_INVALID", "Inbox subscription was not found.");
    const visible = new Map(scope.rows.map((row) => [row.id, row]));
    let acknowledged = 0;
    const now = new Date();
    for (const ack of input.acks) {
      if (!visible.has(ack.itemId) || !ack.leaseId) continue;
      const status = ack.status ?? "delivered";
      const updated = await tx.update(schema.agentInboxReceipts).set({ status, updatedAt: now,
        ...(status === "delivered" ? { deliveredAt: now } : status === "read" ? { readAt: now } :
          status === "resolved" ? { resolvedAt: now } : status === "failed" ? { failedAt: now,
            failureCount: sql`${schema.agentInboxReceipts.failureCount}+1` } : {}),
        lastErrorCode: ack.errorCode ?? null, localEventId: ack.localEventId ?? null })
        .where(and(eq(schema.agentInboxReceipts.subscriptionId, subscription.id), eq(schema.agentInboxReceipts.itemId, ack.itemId),
          eq(schema.agentInboxReceipts.leaseId, ack.leaseId))).returning({ id: schema.agentInboxReceipts.id });
      acknowledged += updated.length;
    }
    // Advance only a contiguous authorized prefix: out-of-order ACK cannot drop
    // an earlier leased/failed item. Hidden rows are never exposed as a cursor.
    const completed = await tx.select({ itemId: schema.agentInboxReceipts.itemId }).from(schema.agentInboxReceipts)
      .where(and(eq(schema.agentInboxReceipts.subscriptionId, subscription.id), inArray(schema.agentInboxReceipts.status, ["delivered", "read", "resolved", "skipped"])));
    const complete = new Set(completed.map((row) => row.itemId));
    let cursor = subscription.lastDeliveredSequence;
    for (const row of scope.rows) {
      if (row.sequence <= cursor) continue;
      if (!complete.has(row.id)) break;
      cursor = row.sequence;
    }
    await tx.update(schema.agentInboxSubscriptions).set({ lastDeliveredSequence: cursor, updatedAt: now }).where(eq(schema.agentInboxSubscriptions.id, subscription.id));
    return { acked: acknowledged, acknowledged, ignored: input.acks.length - acknowledged,
      lastDeliveredSequence: scope.rows.filter((row) => row.sequence <= cursor).length };
  });
}
