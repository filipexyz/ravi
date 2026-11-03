// Event subscriptions (SPEC "Events"): a manager subscribes the calling CLI
// installation to a base; row changes then reach that installation as Agent
// Inbox items. List and revoke need `base.manage`; create is CLI-only.
// A subscription may be filtered by events, properties, and a view (SPEC
// "Filtered Subscriptions"); one active subscription per installation and
// canonical filter.

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/server/db";
import type { BaseSubscription } from "@/shared/bases/types";
import { baseSubscriptionCreateSchema } from "@/shared/bases/schemas";
import { isBaseUuid } from "@/shared/bases/values";

import { insertBasesAudit } from "./audit";
import { assertCurrentBasesManagement } from "./access";
import { forbidden, notFound, parseBasesBody, payloadInvalid, validationFailed } from "./errors";
import { canonicalSubscriptionFilter, parseSubscriptionFilter, subscriptionFilterKey, type BaseSubscriptionFilter } from "./events";
import { findViewRecord, type BaseSubscriptionRecord, type BasesExecutor, type BasesTx } from "./repository";
import { activeProperties, assertWritable, type BaseScope } from "./scope";
import { toIso } from "./serialize";

const emptyBodySchema = z.object({}).strict();

function requireManage(scope: BaseScope) {
  if (!scope.access.manage) forbidden("Subscriptions need project write access.");
}

function subscriptionToApi(scope: BaseScope, record: BaseSubscriptionRecord, installationName: string | null): BaseSubscription {
  const filter = parseSubscriptionFilter(record.filterJson);
  return {
    id: record.id,
    baseId: record.baseId,
    localInstallationId: record.localInstallationId,
    installationName,
    userId: record.userId,
    status: record.status === "active" ? "active" : "revoked",
    createdAt: toIso(record.createdAt) ?? "",
    revokedAt: toIso(record.revokedAt),
    viewId: filter?.viewId ?? null,
    properties: (filter?.propertyIds ?? []).map((id) => scope.propertiesById.get(id)?.key ?? id),
    events: filter?.events ?? [],
  };
}

/** Resolves the create body into the stored (id-based) filter; null when unfiltered. */
async function resolveSubscriptionFilter(scope: BaseScope, body: unknown): Promise<BaseSubscriptionFilter | null> {
  const input = parseBasesBody(baseSubscriptionCreateSchema, body ?? {});
  if (input.viewId) {
    const view = await findViewRecord(db, { baseId: scope.base.id, viewId: input.viewId });
    if (!view || view.status !== "active") validationFailed({ viewId: "not_found" }, "The view is not an active view of this base.");
  }
  const active = activeProperties(scope);
  const propertyIds = (input.properties ?? []).map((ref, index) => {
    const lowered = ref.toLowerCase();
    const property = active.find((candidate) => candidate.key === ref || candidate.id === lowered);
    if (!property) validationFailed({ [`properties.${index}`]: "unknown_property" });
    return property.id;
  });
  return canonicalSubscriptionFilter({ viewId: input.viewId ?? null, propertyIds, events: input.events ?? [] });
}

async function selectSubscriptions(executor: BasesExecutor, scope: BaseScope, subscriptionId?: string) {
  const conditions = [
    eq(schema.baseSubscriptions.baseId, scope.base.id),
    eq(schema.baseSubscriptions.organizationId, scope.base.organizationId),
  ];
  if (subscriptionId) conditions.push(eq(schema.baseSubscriptions.id, subscriptionId.toLowerCase()));
  return executor
    .select({ subscription: schema.baseSubscriptions, installationName: schema.localInstallations.name })
    .from(schema.baseSubscriptions)
    .leftJoin(schema.localInstallations, eq(schema.baseSubscriptions.localInstallationId, schema.localInstallations.id))
    .where(and(...conditions))
    .orderBy(desc(schema.baseSubscriptions.createdAt));
}

function auditSubscription(tx: BasesTx, scope: BaseScope, record: BaseSubscriptionRecord, action: string) {
  const filter = parseSubscriptionFilter(record.filterJson);
  return insertBasesAudit(tx, {
    caller: scope.caller,
    organizationId: scope.base.organizationId,
    projectId: scope.base.projectId,
    targetType: "base_subscription",
    targetId: record.id,
    action,
    metadata: {
      baseId: scope.base.id,
      subscriptionId: record.id,
      subscribedInstallationId: record.localInstallationId,
      ...(filter ? { filter: { viewId: filter.viewId, propertyIds: filter.propertyIds, events: filter.events } } : {}),
    },
  });
}

export async function listSubscriptions(scope: BaseScope): Promise<{ subscriptions: BaseSubscription[] }> {
  requireManage(scope);
  const rows = await selectSubscriptions(db, scope);
  const sorted = [...rows].sort((a, b) => Number(b.subscription.status === "active") - Number(a.subscription.status === "active"));
  return { subscriptions: sorted.map((row) => subscriptionToApi(scope, row.subscription, row.installationName)) };
}

/**
 * Subscribes the calling CLI installation, optionally filtered. Idempotent:
 * an active subscription with the same canonical filter is returned with 200.
 */
export async function createSubscription(scope: BaseScope, body: unknown): Promise<{ status: number; payload: BaseSubscription }> {
  requireManage(scope);
  const installationId = scope.caller.localInstallationId;
  if (scope.caller.surface !== "cli" || !installationId || !scope.caller.user) {
    payloadInvalid("Subscriptions are created from the Ravi CLI and subscribe the calling installation.");
  }
  assertWritable(scope);
  const filter = await resolveSubscriptionFilter(scope, body);
  const userId = scope.caller.user.id;
  // The human is part of the subscription identity, not just the installation.
  // Legacy rows lack verified provenance and remain inactive for delivery.
  const filterKey = createHash("sha256").update(JSON.stringify({ userId, filter: subscriptionFilterKey(filter) })).digest("hex").slice(0, 32);
  return db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`base-subscription:${scope.base.id}:${installationId}:${filterKey}`},0))`);
    const filterJson = { ...(filter ? { viewId: filter.viewId, propertyIds: filter.propertyIds, events: filter.events } : {}),
      projectAuthorization: { organizationId: scope.base.organizationId, userId, delegation: scope.caller.authorization! } };
    const [existing] = (await selectSubscriptions(tx, scope)).filter(row => row.subscription.status === "active" &&
      row.subscription.localInstallationId === installationId && row.subscription.filterKey === filterKey);
    if (existing) {
      if (existing.subscription.userId !== userId) forbidden("Subscription identity does not match.");
      const oldProof = (existing.subscription.filterJson as Record<string, unknown>).projectAuthorization;
      const { canonicalJson } = await import("../authorization/policy");
      if (canonicalJson(oldProof ?? null) !== canonicalJson(filterJson.projectAuthorization)) {
        await tx.update(schema.baseSubscriptions).set({ filterJson, updatedAt: new Date() }).where(eq(schema.baseSubscriptions.id, existing.subscription.id));
        await auditSubscription(tx, scope, existing.subscription, "bases.subscription.renewed");
      }
      return { status: 200, payload: subscriptionToApi(scope, existing.subscription, existing.installationName) };
    }
    const [inserted] = await tx
      .insert(schema.baseSubscriptions)
      .values({
        baseId: scope.base.id,
        organizationId: scope.base.organizationId,
        projectId: scope.base.projectId,
        localInstallationId: installationId,
        userId,
        filterJson,
        filterKey,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) await auditSubscription(tx, scope, inserted, "bases.subscription.created");
    const [row] = (await selectSubscriptions(tx, scope)).filter(
      (candidate) => candidate.subscription.status === "active" &&
        candidate.subscription.localInstallationId === installationId &&
        candidate.subscription.filterKey === filterKey,
    );
    if (!row) notFound();
    return { status: inserted ? 201 : 200, payload: subscriptionToApi(scope, row.subscription, row.installationName) };
  });
}

export async function revokeSubscription(scope: BaseScope, subscriptionId: string, body: unknown): Promise<BaseSubscription> {
  requireManage(scope);
  parseBasesBody(emptyBodySchema, body);
  if (!isBaseUuid(subscriptionId)) notFound();
  return db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
    const [row] = await selectSubscriptions(tx, scope, subscriptionId);
    if (!row) notFound();
    if (row.subscription.status !== "active") return subscriptionToApi(scope, row.subscription, row.installationName);
    const now = new Date();
    const [updated] = await tx
      .update(schema.baseSubscriptions)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(eq(schema.baseSubscriptions.id, row.subscription.id), eq(schema.baseSubscriptions.status, "active")))
      .returning();
    if (!updated) return subscriptionToApi(scope, row.subscription, row.installationName);
    await auditSubscription(tx, scope, updated, "bases.subscription.revoked");
    return subscriptionToApi(scope, updated, row.installationName);
  });
}
