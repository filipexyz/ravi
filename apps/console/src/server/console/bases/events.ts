// Agent Inbox producers for row changes (SPEC "Events"). Items are written
// with `recordAgentInboxItem(item, tx)` in the row write transaction, one per
// matching active subscription whose installation is active and belongs to
// the base organization. Payloads carry ids, counts, and (approval items) the
// approval state: never cell values or keys.
//
// A subscription is unfiltered (`filter_key = ''`: every event of the base)
// or filtered by events, properties, and a view whose filter the row must
// pass for the subscribing user. ALL items carry `subscriptionId` and add it
// to their dedupe key: two humans may share an installation, never a recipient.

import { createHash } from "node:crypto";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { storedActorCan } from "../authorization/stored-actor";

import { AGENT_INBOX_TARGET_LOCAL_INSTALLATION, recordAgentInboxItem } from "@/server/console/agent-inbox";
import { schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import { BASES_LIMITS } from "@/shared/bases/limits";
import { isBaseSystemColumn } from "@/shared/bases/operators";
import { BASE_SUBSCRIPTION_EVENTS, type BaseApprovalState, type BaseSubscriptionEvent } from "@/shared/bases/types";

import { baseFilterColumnRefs, buildBaseRowMatchQuery, compileBaseFilter, createBaseColumnResolver } from "./compiler";
import type { BasesCaller } from "./context";
import { executeRows, findViewRecord, loadPropertyRecords, type BasesExecutor, type BasesTx } from "./repository";
import { propertyFromRecord } from "./serialize";
import { parseStoredView } from "./view-model";

export const BASES_EVENT_CATEGORY = "bases";
export const BASES_ROW_SOURCE_TYPE = "base_row";
export const BASES_BASE_SOURCE_TYPE = "base";

export type BaseRowEventVerb = "created" | "updated" | "archived" | "restored";

export type BaseRowChange = {
  rowId: string;
  version: number;
  verb: BaseRowEventVerb;
  changedPropertyCount: number;
  /** Changed property ids (updates); matched against a subscription's `properties`. */
  changedPropertyIds?: readonly string[];
  /** Approval properties that entered a state in this write. */
  approvals?: ReadonlyArray<{ propertyId: string; state: BaseApprovalState }>;
  /** Agent properties set to `pending` in this write. */
  agentRequests?: ReadonlyArray<{ propertyId: string; inputsHash: string }>;
};

export type BaseEventBase = {
  id: string;
  slug: string;
  name: string;
  organizationId: string;
  projectId: string;
  schemaVersion: number;
  /** For `$today` and local dates in a subscription's view filter. Defaults to UTC. */
  timezone?: string;
};

/** Stored subscription filter (ids). Empty arrays mean "any". */
export type BaseSubscriptionFilter = {
  viewId: string | null;
  propertyIds: string[];
  events: BaseSubscriptionEvent[];
};

export type BaseEventSubscription = {
  id: string;
  installationId: string;
  userId: string;
  email: string | null;
  /** Null when unfiltered. */
  filter: BaseSubscriptionFilter | null;
};

type InboxInsert = typeof schema.agentInboxItems.$inferInsert;
type EventCaller = Pick<BasesCaller, "actorType" | "actorId" | "surface">;

const VERB_TITLES: Record<BaseRowEventVerb, string> = {
  created: "Base row created",
  updated: "Base row updated",
  archived: "Base row archived",
  restored: "Base row restored",
};

const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set(BASE_SUBSCRIPTION_EVENTS);

// ---------------------------------------------------------------------------
// Filters

/**
 * Canonical stored filter: ids and events sorted and unique, `viewId`
 * lowercased. Null (unfiltered) when nothing narrows.
 */
export function canonicalSubscriptionFilter(input: {
  viewId?: string | null;
  propertyIds?: readonly string[];
  events?: readonly string[];
}): BaseSubscriptionFilter | null {
  const viewId = input.viewId ? input.viewId.toLowerCase() : null;
  const propertyIds = [...new Set((input.propertyIds ?? []).map((id) => id.toLowerCase()))].sort();
  const events = [...new Set((input.events ?? []).filter((event) => SUBSCRIPTION_EVENTS.has(event)))].sort() as BaseSubscriptionEvent[];
  if (!viewId && !propertyIds.length && !events.length) return null;
  return { viewId, propertyIds, events };
}

/** `filter_key`: '' when unfiltered, else 32 hex of sha256 over the canonical filter. */
export function subscriptionFilterKey(filter: BaseSubscriptionFilter | null): string {
  if (!filter) return "";
  const canonical = JSON.stringify({ viewId: filter.viewId, propertyIds: filter.propertyIds, events: filter.events });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Parses stored `filter_json`; null for `{}` or anything unusable. */
export function parseSubscriptionFilter(json: unknown): BaseSubscriptionFilter | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return canonicalSubscriptionFilter({
    viewId: typeof record.viewId === "string" ? record.viewId : null,
    propertyIds: strings(record.propertyIds),
    events: strings(record.events),
  });
}

/** The candidate item a subscription is matched against. */
export type BaseEventCandidate = {
  event: BaseSubscriptionEvent;
  /** row.updated: the changed property ids. */
  changedPropertyIds?: readonly string[];
  /** approval.*, agent.*: the item's property. */
  propertyId?: string;
};

/**
 * Event and property tests (the view test runs against the database).
 * `events` must include the item's event; `properties` must intersect the
 * changed ids of a `row.updated` or contain the property of an approval or
 * agent item. Other row events pass the property test.
 */
export function subscriptionMatches(filter: BaseSubscriptionFilter | null, candidate: BaseEventCandidate): boolean {
  if (!filter) return true;
  if (filter.events.length && !filter.events.includes(candidate.event)) return false;
  if (!filter.propertyIds.length) return true;
  if (candidate.propertyId !== undefined) return filter.propertyIds.includes(candidate.propertyId.toLowerCase());
  if (candidate.event === "row.updated") {
    return (candidate.changedPropertyIds ?? []).some((id) => filter.propertyIds.includes(id.toLowerCase()));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Items

export function baseRowEventDedupeKey(input: { rowId: string; version: number; verb: BaseRowEventVerb; installationId: string; subscriptionId?: string }) {
  const key = `bases:row:${input.rowId}:v${input.version}:${input.verb}:${input.installationId}`;
  return input.subscriptionId ? `${key}:${input.subscriptionId}` : key;
}

function withSubscription(key: string, subscription: BaseEventSubscription) {
  return `${key}:${subscription.id}`;
}

function subscriptionPayload(subscription: BaseEventSubscription) {
  return { subscriptionId: subscription.id };
}

function rowPayload(base: BaseEventBase, caller: EventCaller, change: BaseRowChange) {
  return {
    baseId: base.id,
    baseSlug: base.slug,
    projectId: base.projectId,
    rowId: change.rowId,
    version: change.version,
    schemaVersion: base.schemaVersion,
    changedPropertyCount: change.changedPropertyCount,
    surface: caller.surface,
  };
}

function itemShell(input: {
  base: BaseEventBase;
  caller: EventCaller;
  subscription: BaseEventSubscription;
  occurredAt: Date;
}): Pick<
  InboxInsert,
  | "organizationId"
  | "projectId"
  | "category"
  | "severity"
  | "sensitivity"
  | "summary"
  | "actorType"
  | "actorId"
  | "targetType"
  | "targetId"
  | "linksJson"
  | "occurredAt"
> {
  return {
    organizationId: input.base.organizationId,
    projectId: input.base.projectId,
    category: BASES_EVENT_CATEGORY,
    severity: "info",
    sensitivity: "metadata",
    summary: null,
    actorType: input.caller.actorType,
    actorId: input.caller.actorId,
    targetType: AGENT_INBOX_TARGET_LOCAL_INSTALLATION,
    targetId: input.subscription.installationId,
    linksJson: [] as unknown as JsonRecord,
    occurredAt: input.occurredAt,
  };
}

export function buildBaseRowInboxItem(input: {
  base: BaseEventBase;
  caller: EventCaller;
  change: BaseRowChange;
  subscription: BaseEventSubscription;
  occurredAt: Date;
}): InboxInsert {
  const { base, change, subscription } = input;
  return {
    ...itemShell(input),
    sourceType: BASES_ROW_SOURCE_TYPE,
    sourceId: change.rowId,
    eventType: `bases.row.${change.verb}`,
    title: VERB_TITLES[change.verb],
    dedupeKey: baseRowEventDedupeKey({
      ...change,
      installationId: subscription.installationId,
      subscriptionId: subscription.id,
    }),
    payloadJson: { ...rowPayload(base, input.caller, change), ...subscriptionPayload(subscription) },
  };
}

/** `bases.approval.requested` (entering `pending`) or `bases.approval.decided` (entering approved or rejected). Never the note. */
export function buildBaseApprovalInboxItem(input: {
  base: BaseEventBase;
  caller: EventCaller;
  change: BaseRowChange;
  approval: { propertyId: string; state: BaseApprovalState };
  subscription: BaseEventSubscription;
  occurredAt: Date;
}): InboxInsert {
  const { base, change, approval, subscription } = input;
  const verb = approval.state === "pending" ? "requested" : "decided";
  return {
    ...itemShell(input),
    sourceType: BASES_ROW_SOURCE_TYPE,
    sourceId: change.rowId,
    eventType: `bases.approval.${verb}`,
    title: verb === "requested" ? "Base approval requested" : "Base approval decided",
    dedupeKey: withSubscription(
      `bases:approval:${change.rowId}:v${change.version}:${approval.propertyId}:${verb}:${subscription.installationId}`,
      subscription,
    ),
    payloadJson: {
      ...rowPayload(base, input.caller, change),
      propertyId: approval.propertyId,
      state: approval.state,
      ...subscriptionPayload(subscription),
    },
  };
}

/** `bases.agent.requested`: an agent column of the row needs a (new) value for `inputsHash`. */
export function buildBaseAgentRequestedInboxItem(input: {
  base: BaseEventBase;
  caller: EventCaller;
  change: BaseRowChange;
  request: { propertyId: string; inputsHash: string };
  subscription: BaseEventSubscription;
  occurredAt: Date;
}): InboxInsert {
  const { base, change, request, subscription } = input;
  return {
    ...itemShell(input),
    sourceType: BASES_ROW_SOURCE_TYPE,
    sourceId: change.rowId,
    eventType: "bases.agent.requested",
    title: "Base agent value requested",
    dedupeKey: withSubscription(
      `bases:agent:${change.rowId}:v${change.version}:${request.propertyId}:requested:${subscription.installationId}`,
      subscription,
    ),
    payloadJson: {
      ...rowPayload(base, input.caller, change),
      propertyId: request.propertyId,
      inputsHash: request.inputsHash,
      ...subscriptionPayload(subscription),
    },
  };
}

/** `bases.agent.backfill`: an agent column whose `rowCount` rows need values (new column, or a bulk write). */
export function buildBaseAgentBackfillInboxItem(input: {
  base: BaseEventBase;
  caller: EventCaller;
  propertyId: string;
  rowCount: number;
  /** Distinguishes backfills of one property (schema version, or the bulk anchor). */
  anchor: string;
  subscription: BaseEventSubscription;
  occurredAt: Date;
}): InboxInsert {
  const { base, subscription } = input;
  return {
    ...itemShell(input),
    sourceType: BASES_BASE_SOURCE_TYPE,
    sourceId: base.id,
    eventType: "bases.agent.backfill",
    title: "Base agent column needs values",
    dedupeKey: withSubscription(
      `bases:agent_backfill:${base.id}:${input.propertyId}:${input.anchor}:${subscription.installationId}`,
      subscription,
    ),
    payloadJson: {
      baseId: base.id,
      baseSlug: base.slug,
      projectId: base.projectId,
      propertyId: input.propertyId,
      rowCount: input.rowCount,
      schemaVersion: base.schemaVersion,
      ...subscriptionPayload(subscription),
    },
  };
}

export function buildBaseRowsBulkInboxItem(input: {
  base: BaseEventBase;
  caller: EventCaller;
  changes: readonly BaseRowChange[];
  subscription: BaseEventSubscription;
  occurredAt: Date;
}): InboxInsert {
  const { base, subscription } = input;
  const first = input.changes[0];
  const anchor = first ? `${first.rowId}:v${first.version}:${first.verb}` : input.occurredAt.toISOString();
  return {
    ...itemShell(input),
    sourceType: BASES_BASE_SOURCE_TYPE,
    sourceId: base.id,
    eventType: "bases.rows.bulk_changed",
    title: "Base rows changed",
    dedupeKey: withSubscription(
      `bases:rows:${base.id}:${anchor}:${input.changes.length}:bulk_changed:${subscription.installationId}`,
      subscription,
    ),
    payloadJson: {
      baseId: base.id,
      baseSlug: base.slug,
      projectId: base.projectId,
      rowCount: input.changes.length,
      schemaVersion: base.schemaVersion,
      surface: input.caller.surface,
      ...subscriptionPayload(subscription),
    },
  };
}

/** True when `subscriptionId` sees `rowId` through its view; absent means no view test ran (no view). */
export type BaseSubscriptionViewMatches = ReadonlySet<string>;

export function viewMatchKey(subscriptionId: string, rowId: string) {
  return `${subscriptionId}:${rowId}`;
}

/**
 * Items for the changes and subscriptions. At most the bulk threshold of
 * changes: one item per change, approval transition, and agent request, for
 * each subscription they match (view test from `viewMatches`). Above it: one
 * bulk item per subscription whose events include a verb of the batch, plus
 * one `bases.agent.backfill` per requested agent property; bulk items skip
 * the view and property tests (backfill still checks properties).
 */
export function buildBaseRowInboxItems(input: {
  base: BaseEventBase;
  caller: EventCaller;
  changes: readonly BaseRowChange[];
  subscriptions: readonly BaseEventSubscription[];
  occurredAt: Date;
  viewMatches?: BaseSubscriptionViewMatches;
}): InboxInsert[] {
  if (!input.changes.length || !input.subscriptions.length) return [];
  const items: InboxInsert[] = [];
  const bulk = input.changes.length > BASES_LIMITS.bulkEventThreshold;
  for (const subscription of input.subscriptions) {
    const filter = subscription.filter;
    if (bulk) {
      const verbs = new Set(input.changes.map((change) => `row.${change.verb}` as BaseSubscriptionEvent));
      if (!filter || !filter.events.length || filter.events.some((event) => verbs.has(event))) {
        items.push(buildBaseRowsBulkInboxItem({ ...input, subscription }));
      }
      const requested = new Map<string, number>();
      for (const change of input.changes) {
        for (const request of change.agentRequests ?? []) requested.set(request.propertyId, (requested.get(request.propertyId) ?? 0) + 1);
      }
      const first = input.changes[0];
      for (const [propertyId, rowCount] of requested) {
        const agentEvent = subscriptionMatches(filter, { event: "agent.backfill", propertyId }) || subscriptionMatches(filter, { event: "agent.requested", propertyId });
        if (!agentEvent) continue;
        const anchor = first ? `bulk:${first.rowId}:v${first.version}:${input.changes.length}` : input.occurredAt.toISOString();
        items.push(buildBaseAgentBackfillInboxItem({ ...input, propertyId, rowCount, anchor, subscription }));
      }
      continue;
    }
    for (const change of input.changes) {
      if (filter?.viewId && !input.viewMatches?.has(viewMatchKey(subscription.id, change.rowId))) continue;
      if (subscriptionMatches(filter, { event: `row.${change.verb}`, changedPropertyIds: change.changedPropertyIds ?? [] })) {
        items.push(buildBaseRowInboxItem({ ...input, change, subscription }));
      }
      for (const approval of change.approvals ?? []) {
        const event = approval.state === "pending" ? "approval.requested" : "approval.decided";
        if (subscriptionMatches(filter, { event, propertyId: approval.propertyId })) {
          items.push(buildBaseApprovalInboxItem({ ...input, change, approval, subscription }));
        }
      }
      for (const request of change.agentRequests ?? []) {
        if (subscriptionMatches(filter, { event: "agent.requested", propertyId: request.propertyId })) {
          items.push(buildBaseAgentRequestedInboxItem({ ...input, change, request, subscription }));
        }
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Subscriptions

/**
 * Active subscriptions of the base whose installation is active in the base
 * organization and whose original verified CLI actor still holds policy read
 * and write. Legacy subscriptions without provenance do not acquire a grant.
 */
export async function listActiveBaseSubscriptions(
  executor: BasesExecutor,
  base: { id: string; organizationId: string; projectId: string },
): Promise<BaseEventSubscription[]> {
  const rows = await executor
    .select({
      id: schema.baseSubscriptions.id,
      installationId: schema.baseSubscriptions.localInstallationId,
      userId: schema.baseSubscriptions.userId,
      email: schema.users.primaryEmail,
      filterJson: schema.baseSubscriptions.filterJson,
    })
    .from(schema.baseSubscriptions)
    .innerJoin(schema.localInstallations, eq(schema.baseSubscriptions.localInstallationId, schema.localInstallations.id))
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, base.organizationId),
        eq(schema.organizationMemberships.userId, schema.baseSubscriptions.userId),
      ),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.baseSubscriptions.userId))
    .where(
      and(
        eq(schema.baseSubscriptions.baseId, base.id),
        eq(schema.baseSubscriptions.organizationId, base.organizationId),
        eq(schema.baseSubscriptions.status, "active"),
        eq(schema.localInstallations.organizationId, base.organizationId),
        eq(schema.localInstallations.status, "active"),
        isNull(schema.localInstallations.revokedAt),
        eq(schema.organizationMemberships.status, "active"),
        eq(schema.users.status, "active"),
      ),
    );
  const seen = new Set<string>();
  const subscriptions: BaseEventSubscription[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const identity = { ...base, installationId: row.installationId, userId: row.userId };
    if (!await storedActorCan(executor, row.filterJson.projectAuthorization, identity, "project.read") ||
      !await storedActorCan(executor, row.filterJson.projectAuthorization, identity, "project.write")) continue;
    subscriptions.push({
      id: row.id,
      installationId: row.installationId,
      userId: row.userId,
      email: row.email ? row.email.trim().toLowerCase() || null : null,
      filter: parseSubscriptionFilter(row.filterJson),
    });
  }
  return subscriptions.sort((a, b) => (a.installationId === b.installationId ? a.id.localeCompare(b.id) : a.installationId.localeCompare(b.installationId)));
}

/** Installations with at least one matching-eligible subscription (kept for callers that only need targets). */
export async function listSubscribedInstallationIds(executor: BasesExecutor, base: { id: string; organizationId: string; projectId: string }) {
  return [...new Set((await listActiveBaseSubscriptions(executor, base)).map((subscription) => subscription.installationId))];
}

/**
 * Evaluates the view test of filtered subscriptions for `rowIds` in the
 * current transaction state: the row must be active and pass the view's
 * filter compiled with the subscriber as `$viewer`. An archived view, or a
 * filter that no longer compiles or names a property whose type changed,
 * matches nothing.
 */
export async function evaluateSubscriptionViewMatches(
  tx: BasesTx,
  base: BaseEventBase,
  subscriptions: readonly BaseEventSubscription[],
  rowIds: readonly string[],
): Promise<Set<string>> {
  const matches = new Set<string>();
  const withView = subscriptions.filter((subscription) => subscription.filter?.viewId);
  if (!withView.length || !rowIds.length) return matches;
  const properties = (await loadPropertyRecords(tx, base.id)).map(propertyFromRecord);
  const propertiesById = new Map(properties.map((property) => [property.id, property]));
  const resolve = createBaseColumnResolver(properties, { allowed: null });
  const views = new Map<string, ReturnType<typeof parseStoredView> | null>();
  const now = new Date();
  for (const subscription of withView) {
    const viewId = subscription.filter?.viewId;
    if (!viewId) continue;
    if (!views.has(viewId)) {
      const record = await findViewRecord(tx, { baseId: base.id, viewId });
      views.set(viewId, record && record.status === "active" ? parseStoredView(record) : null);
    }
    const view = views.get(viewId);
    if (!view) continue;
    const stale = [...baseFilterColumnRefs(view.query.filter)].some((ref) => {
      const property = propertiesById.get(ref);
      if (!property) return !isBaseSystemColumn(ref);
      const savedType = view.query.refTypes[ref];
      return Boolean(property.deletedAt) || (savedType !== undefined && savedType !== property.type);
    });
    if (stale) continue;
    let filterSql;
    try {
      filterSql = compileBaseFilter(view.query.filter, {
        baseId: base.id,
        timezone: base.timezone ?? "UTC",
        now,
        viewer: { raviUserId: subscription.userId, raviOrgId: base.organizationId, email: subscription.email },
        resolve,
      });
    } catch {
      continue;
    }
    for (const rowId of rowIds) {
      const rows = await executeRows<{ id: string | null }>(
        tx,
        buildBaseRowMatchQuery({ organizationId: base.organizationId, baseId: base.id, rowId, filterSql }),
      );
      if (rows.length && rows[0]?.id) matches.add(viewMatchKey(subscription.id, rowId));
    }
  }
  return matches;
}

/**
 * Writes the row change items inside the row write transaction. Archive
 * passes `viewMatches` evaluated before the row left the view; every other
 * write is evaluated here, after the write.
 */
export async function emitBaseRowEvents(
  tx: BasesTx,
  input: {
    base: BaseEventBase;
    caller: BasesCaller;
    changes: readonly BaseRowChange[];
    occurredAt?: Date;
    viewMatches?: BaseSubscriptionViewMatches;
    subscriptions?: readonly BaseEventSubscription[];
  },
): Promise<number> {
  if (!input.changes.length) return 0;
  const subscriptions = input.subscriptions ?? (await listActiveBaseSubscriptions(tx, input.base));
  if (!subscriptions.length) return 0;
  const bulk = input.changes.length > BASES_LIMITS.bulkEventThreshold;
  const viewMatches =
    input.viewMatches ??
    (bulk ? new Set<string>() : await evaluateSubscriptionViewMatches(tx, input.base, subscriptions, input.changes.map((change) => change.rowId)));
  const items = buildBaseRowInboxItems({ ...input, subscriptions, viewMatches, occurredAt: input.occurredAt ?? new Date() });
  for (const item of items) await recordAgentInboxItem(item, tx);
  return items.length;
}

/** One `bases.agent.backfill` item per matching subscription for a new agent column on a base with rows. */
export async function emitBaseAgentBackfill(
  tx: BasesTx,
  input: { base: BaseEventBase; caller: BasesCaller; propertyId: string; rowCount: number; occurredAt?: Date },
): Promise<number> {
  if (input.rowCount <= 0) return 0;
  const subscriptions = await listActiveBaseSubscriptions(tx, input.base);
  let count = 0;
  for (const subscription of subscriptions) {
    if (!subscriptionMatches(subscription.filter, { event: "agent.backfill", propertyId: input.propertyId })) continue;
    await recordAgentInboxItem(
      buildBaseAgentBackfillInboxItem({
        ...input,
        anchor: `s${input.base.schemaVersion}`,
        subscription,
        occurredAt: input.occurredAt ?? new Date(),
      }),
      tx,
    );
    count += 1;
  }
  return count;
}
