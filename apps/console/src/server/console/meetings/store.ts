import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { recordAgentInboxItem } from "@/server/console/agent-inbox";
import { usageMetricKeys, type UsageEventRecordInput } from "@/server/console/billing/usage-metering";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { MEETINGS_FEATURE_KEY } from "./limits";

export type MeetingBotRow = typeof schema.meetingBots.$inferSelect;
export type NewMeetingBot = typeof schema.meetingBots.$inferInsert;
export type MeetingBotPatch = Partial<Omit<MeetingBotRow, "id" | "organizationId" | "createdAt">>;
export type MeetingInboxItem = typeof schema.agentInboxItems.$inferInsert;

export const OPEN_MEETING_BOT_STATUSES = ["requested", "joining", "waiting_room", "in_call", "recording"] as const;

/** Everything meetings reads or writes in Postgres, so the flows can be tested without a database. */
export type MeetingBotStore = {
  insert(values: NewMeetingBot): Promise<MeetingBotRow>;
  update(id: string, patch: MeetingBotPatch): Promise<MeetingBotRow>;
  findById(organizationId: string, id: string): Promise<MeetingBotRow | null>;
  findByProviderBotId(provider: string, providerBotId: string): Promise<MeetingBotRow | null>;
  listForProject(organizationId: string, projectId: string, limit: number): Promise<MeetingBotRow[]>;
  /** Unfinished bots created since `since`, and the seconds they may still record. */
  openBots(organizationId: string, since: Date): Promise<{ count: number; reservedSeconds: number }>;
  monthSpentUsd(organizationId: string, monthStart: Date): Promise<number>;
  limitsValueJson(organizationId: string): Promise<unknown>;
  /** False when this delivery id was already seen. */
  recordDelivery(input: {
    organizationId: string;
    provider: string;
    deliveryId: string;
    providerBotId: string;
    eventType: string;
    requestId: string;
    envelope: JsonRecord;
  }): Promise<boolean>;
  /** Drops a delivery whose processing failed, so the vendor's retry is processed. */
  forgetDelivery(provider: string, deliveryId: string): Promise<void>;
  recordUsage(events: UsageEventRecordInput[]): Promise<void>;
  recordInboxItem(item: MeetingInboxItem): Promise<void>;
  audit(input: {
    organizationId: string;
    actorType: "user" | "system";
    actorId: string | null;
    meetingBotId: string;
    action: string;
    afterJson: JsonRecord;
    requestId: string;
  }): Promise<void>;
};

export const dbMeetingBotStore: MeetingBotStore = {
  async insert(values) {
    const [row] = await db.insert(schema.meetingBots).values(values).returning();
    if (!row) throw new Error("meeting_bots insert returned no row");
    return row;
  },
  async update(id, patch) {
    const [row] = await db
      .update(schema.meetingBots)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.meetingBots.id, id))
      .returning();
    if (!row) throw new Error("meeting_bots update returned no row");
    return row;
  },
  async findById(organizationId, id) {
    const [row] = await db
      .select()
      .from(schema.meetingBots)
      .where(and(eq(schema.meetingBots.organizationId, organizationId), eq(schema.meetingBots.id, id)))
      .limit(1);
    return row ?? null;
  },
  async findByProviderBotId(provider, providerBotId) {
    const [row] = await db
      .select()
      .from(schema.meetingBots)
      .where(and(eq(schema.meetingBots.provider, provider), eq(schema.meetingBots.providerBotId, providerBotId)))
      .limit(1);
    return row ?? null;
  },
  async listForProject(organizationId, projectId, limit) {
    return db
      .select()
      .from(schema.meetingBots)
      .where(and(eq(schema.meetingBots.organizationId, organizationId), eq(schema.meetingBots.projectId, projectId)))
      .orderBy(desc(schema.meetingBots.createdAt))
      .limit(limit);
  },
  async openBots(organizationId, since) {
    const [row] = await db
      .select({
        count: sql<string>`COUNT(*)`,
        reserved: sql<string>`COALESCE(SUM(${schema.meetingBots.maxRecordingSeconds}), 0)`,
      })
      .from(schema.meetingBots)
      .where(
        and(
          eq(schema.meetingBots.organizationId, organizationId),
          inArray(schema.meetingBots.status, [...OPEN_MEETING_BOT_STATUSES]),
          gte(schema.meetingBots.createdAt, since),
        ),
      );
    return { count: Number(row?.count ?? 0), reservedSeconds: Number(row?.reserved ?? 0) };
  },
  async monthSpentUsd(organizationId, monthStart) {
    const [row] = await db
      .select({
        usd: sql<string>`COALESCE(SUM((${schema.usageEvents.measurementsJson}->>'estimatedCostUsd')::numeric), 0)`,
      })
      .from(schema.usageEvents)
      .where(
        and(
          eq(schema.usageEvents.organizationId, organizationId),
          eq(schema.usageEvents.metricKey, usageMetricKeys.meetingsBots),
          gte(schema.usageEvents.occurredAt, monthStart),
        ),
      );
    return Number(row?.usd ?? 0);
  },
  async limitsValueJson(organizationId) {
    const [row] = await db
      .select({ valueJson: schema.entitlements.valueJson })
      .from(schema.entitlements)
      .where(and(eq(schema.entitlements.organizationId, organizationId), eq(schema.entitlements.key, MEETINGS_FEATURE_KEY)))
      .limit(1);
    return row?.valueJson ?? null;
  },
  async recordDelivery(input) {
    const [row] = await db
      .insert(schema.providerWebhookDeliveries)
      .values({
        organizationId: input.organizationId,
        provider: input.provider,
        providerDeliveryId: input.deliveryId,
        providerInstallationId: input.provider,
        providerResourceId: input.providerBotId,
        providerEventType: input.eventType,
        status: "matched",
        requestId: input.requestId,
        safeEnvelopeJson: input.envelope,
      })
      .onConflictDoNothing()
      .returning({ id: schema.providerWebhookDeliveries.id });
    return Boolean(row);
  },
  async forgetDelivery(provider, deliveryId) {
    await db
      .delete(schema.providerWebhookDeliveries)
      .where(
        and(
          eq(schema.providerWebhookDeliveries.provider, provider),
          eq(schema.providerWebhookDeliveries.providerInstallationId, provider),
          eq(schema.providerWebhookDeliveries.providerDeliveryId, deliveryId),
        ),
      );
  },
  async recordUsage(events) {
    if (events.length === 0) return;
    await db.insert(schema.usageEvents).values(events).onConflictDoNothing();
  },
  async recordInboxItem(item) {
    await recordAgentInboxItem(item);
  },
  async audit(input) {
    await db.insert(schema.auditEvents).values({
      organizationId: input.organizationId,
      actorType: input.actorType,
      actorId: input.actorId,
      targetType: "meeting_bot",
      targetId: input.meetingBotId,
      action: input.action,
      afterJson: input.afterJson,
      metadataJson: { source: "meetings" },
      requestId: input.requestId,
    });
  },
};
