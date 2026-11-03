import { describe, expect, test } from "bun:test";

import {
  baseRowEventDedupeKey,
  buildBaseRowInboxItems,
  canonicalSubscriptionFilter,
  parseSubscriptionFilter,
  subscriptionFilterKey,
  subscriptionMatches,
  viewMatchKey,
  type BaseEventSubscription,
  type BaseRowChange,
} from "./events";

const BASE = {
  id: "0b0b0b0b-0000-4000-8000-000000000001",
  slug: "crm",
  name: "CRM",
  organizationId: "0b0b0b0b-0000-4000-8000-000000000002",
  projectId: "0b0b0b0b-0000-4000-8000-000000000003",
  schemaVersion: 4,
};
const CALLER = { actorType: "cli" as const, actorId: "0b0b0b0b-0000-4000-8000-000000000004", surface: "cli" as const };
const I1 = "0b0b0b0b-0000-4000-8000-0000000000a1";
const I2 = "0b0b0b0b-0000-4000-8000-0000000000a2";
const S1 = "0b0b0b0b-0000-4000-8000-0000000000b1";
const S2 = "0b0b0b0b-0000-4000-8000-0000000000b2";
const VIEW = "0b0b0b0b-0000-4000-8000-0000000000c1";
const P_STATUS = "0b0b0b0b-0000-4000-8000-0000000000d1";
const P_APPROVAL = "0b0b0b0b-0000-4000-8000-0000000000d2";
const P_AGENT = "0b0b0b0b-0000-4000-8000-0000000000d3";
const USER = "0b0b0b0b-0000-4000-8000-0000000000e1";
const NOW = new Date("2026-10-06T12:00:00Z");

function unfiltered(id: string, installationId: string): BaseEventSubscription {
  return { id, installationId, userId: USER, email: null, filter: null };
}

function filtered(id: string, installationId: string, filter: Parameters<typeof canonicalSubscriptionFilter>[0]): BaseEventSubscription {
  return { id, installationId, userId: USER, email: null, filter: canonicalSubscriptionFilter(filter) };
}

function changes(count: number, extra: Partial<BaseRowChange> = {}): BaseRowChange[] {
  return Array.from({ length: count }, (_, index) => ({
    rowId: `0b0b0b0b-0000-4000-8000-${String(index).padStart(12, "0")}`,
    version: 2,
    verb: "updated" as const,
    changedPropertyCount: 3,
    ...extra,
  }));
}

describe("row events", () => {
  test("dedupe keys follow bases:row:<rowId>:v<version>:<verb>:<installationId>[:<subscriptionId>]", () => {
    expect(baseRowEventDedupeKey({ rowId: "r1", version: 3, verb: "archived", installationId: I1 })).toBe(`bases:row:r1:v3:archived:${I1}`);
    expect(baseRowEventDedupeKey({ rowId: "r1", version: 3, verb: "archived", installationId: I1, subscriptionId: S1 })).toBe(
      `bases:row:r1:v3:archived:${I1}:${S1}`,
    );
  });

  test("one item per change per subscription, targeted at the installation", () => {
    const items = buildBaseRowInboxItems({
      base: BASE,
      caller: CALLER,
      changes: changes(2),
      subscriptions: [unfiltered(S1, I1), unfiltered(S2, I2)],
      occurredAt: NOW,
    });
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.targetId)).toEqual([I1, I1, I2, I2]);
    for (const item of items) {
      expect(item).toMatchObject({
        category: "bases",
        eventType: "bases.row.updated",
        sensitivity: "metadata",
        severity: "info",
        targetType: "local_installation",
        summary: null,
      });
    }
  });

  test("unfiltered payloads carry ids/counts and explicit recipient subscription", () => {
    const [item] = buildBaseRowInboxItems({ base: BASE, caller: CALLER, changes: changes(1), subscriptions: [unfiltered(S1, I1)], occurredAt: NOW });
    expect(Object.keys(item?.payloadJson ?? {}).sort()).toEqual(
      ["baseId", "baseSlug", "changedPropertyCount", "projectId", "rowId", "schemaVersion", "surface", "version", "subscriptionId"].sort(),
    );
    expect(item?.payloadJson).toMatchObject({ baseId: BASE.id, schemaVersion: 4, changedPropertyCount: 3, surface: "cli" });
    expect(item?.dedupeKey).toContain(S1);
  });

  test("more than 50 changes emit one bulk item per subscription", () => {
    expect(
      buildBaseRowInboxItems({ base: BASE, caller: CALLER, changes: changes(50), subscriptions: [unfiltered(S1, I1)], occurredAt: NOW }),
    ).toHaveLength(50);
    const bulk = buildBaseRowInboxItems({
      base: BASE,
      caller: CALLER,
      changes: changes(51),
      subscriptions: [unfiltered(S1, I1), unfiltered(S2, I2)],
      occurredAt: NOW,
    });
    expect(bulk).toHaveLength(2);
    expect(bulk[0]).toMatchObject({ eventType: "bases.rows.bulk_changed", targetId: I1 });
    expect(Object.keys(bulk[0]?.payloadJson ?? {}).sort()).toEqual(["baseId", "baseSlug", "projectId", "rowCount", "schemaVersion", "subscriptionId", "surface"]);
    expect(bulk[0]?.payloadJson).toMatchObject({ rowCount: 51 });
  });

  test("no subscriptions, no items", () => {
    expect(buildBaseRowInboxItems({ base: BASE, caller: CALLER, changes: changes(3), subscriptions: [], occurredAt: NOW })).toEqual([]);
  });
});

describe("subscription filters", () => {
  test("the canonical filter sorts, dedupes, and lowercases; nothing narrowing is unfiltered", () => {
    expect(canonicalSubscriptionFilter({})).toBeNull();
    expect(canonicalSubscriptionFilter({ viewId: null, propertyIds: [], events: [] })).toBeNull();
    const filter = canonicalSubscriptionFilter({
      viewId: VIEW.toUpperCase(),
      propertyIds: [P_STATUS.toUpperCase(), P_APPROVAL, P_STATUS],
      events: ["row.updated", "approval.decided", "row.updated", "nope"],
    });
    expect(filter).toEqual({ viewId: VIEW, propertyIds: [P_STATUS, P_APPROVAL].sort(), events: ["approval.decided", "row.updated"] });
  });

  test("filter keys are '' when unfiltered and stable over equivalent input", () => {
    expect(subscriptionFilterKey(null)).toBe("");
    const a = subscriptionFilterKey(canonicalSubscriptionFilter({ events: ["row.created", "row.updated"], propertyIds: [P_STATUS] }));
    const b = subscriptionFilterKey(canonicalSubscriptionFilter({ events: ["row.updated", "row.created"], propertyIds: [P_STATUS.toUpperCase()] }));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(subscriptionFilterKey(canonicalSubscriptionFilter({ events: ["row.created"] }))).not.toBe(a);
  });

  test("stored filter_json round-trips; {} is unfiltered", () => {
    expect(parseSubscriptionFilter({})).toBeNull();
    expect(parseSubscriptionFilter(null)).toBeNull();
    expect(parseSubscriptionFilter({ viewId: VIEW, propertyIds: [P_STATUS], events: ["row.created"] })).toEqual({
      viewId: VIEW,
      propertyIds: [P_STATUS],
      events: ["row.created"],
    });
  });

  test("subscriptionMatches checks events, then properties", () => {
    expect(subscriptionMatches(null, { event: "row.archived" })).toBe(true);
    const events = canonicalSubscriptionFilter({ events: ["row.created"] });
    expect(subscriptionMatches(events, { event: "row.created" })).toBe(true);
    expect(subscriptionMatches(events, { event: "row.updated", changedPropertyIds: [P_STATUS] })).toBe(false);

    const props = canonicalSubscriptionFilter({ propertyIds: [P_STATUS, P_APPROVAL] });
    expect(subscriptionMatches(props, { event: "row.updated", changedPropertyIds: [P_AGENT] })).toBe(false);
    expect(subscriptionMatches(props, { event: "row.updated", changedPropertyIds: [P_AGENT, P_STATUS] })).toBe(true);
    expect(subscriptionMatches(props, { event: "row.created" })).toBe(true);
    expect(subscriptionMatches(props, { event: "approval.decided", propertyId: P_APPROVAL })).toBe(true);
    expect(subscriptionMatches(props, { event: "agent.requested", propertyId: P_AGENT })).toBe(false);
  });

  test("filtered items add the subscription id to the dedupe key and payload", () => {
    const [item] = buildBaseRowInboxItems({
      base: BASE,
      caller: CALLER,
      changes: changes(1, { changedPropertyIds: [P_STATUS] }),
      subscriptions: [filtered(S1, I1, { events: ["row.updated"] })],
      occurredAt: NOW,
    });
    expect(item?.dedupeKey).toBe(`bases:row:${changes(1)[0]?.rowId}:v2:updated:${I1}:${S1}`);
    expect(item?.payloadJson).toMatchObject({ subscriptionId: S1 });
  });

  test("a view filter delivers only rows in viewMatches", () => {
    const rows = changes(2, { changedPropertyIds: [P_STATUS] });
    const subscription = filtered(S1, I1, { viewId: VIEW });
    const inView = new Set([viewMatchKey(S1, rows[1]?.rowId ?? "")]);
    const items = buildBaseRowInboxItems({ base: BASE, caller: CALLER, changes: rows, subscriptions: [subscription], occurredAt: NOW, viewMatches: inView });
    expect(items.map((item) => item.sourceId)).toEqual([rows[1]?.rowId]);
    expect(buildBaseRowInboxItems({ base: BASE, caller: CALLER, changes: rows, subscriptions: [subscription], occurredAt: NOW })).toEqual([]);
  });

  test("approval and agent items carry the property and never the note", () => {
    const [change] = changes(1, {
      changedPropertyIds: [P_APPROVAL, P_STATUS],
      approvals: [{ propertyId: P_APPROVAL, state: "approved" }],
      agentRequests: [{ propertyId: P_AGENT, inputsHash: "0123456789abcdef" }],
    });
    const items = buildBaseRowInboxItems({ base: BASE, caller: CALLER, changes: [change as BaseRowChange], subscriptions: [unfiltered(S1, I1)], occurredAt: NOW });
    expect(items.map((item) => item.eventType)).toEqual(["bases.row.updated", "bases.approval.decided", "bases.agent.requested"]);
    expect(items[1]?.payloadJson).toMatchObject({ propertyId: P_APPROVAL, state: "approved" });
    expect(items[1]?.payloadJson).not.toHaveProperty("note");
    expect(items[1]?.dedupeKey).toBe(`bases:approval:${change?.rowId}:v2:${P_APPROVAL}:decided:${I1}:${S1}`);
    expect(items[2]?.payloadJson).toMatchObject({ propertyId: P_AGENT, inputsHash: "0123456789abcdef" });

    const onlyApprovals = buildBaseRowInboxItems({
      base: BASE,
      caller: CALLER,
      changes: [change as BaseRowChange],
      subscriptions: [filtered(S1, I1, { events: ["approval.decided"], propertyIds: [P_APPROVAL] })],
      occurredAt: NOW,
    });
    expect(onlyApprovals.map((item) => item.eventType)).toEqual(["bases.approval.decided"]);
  });

  test("bulk writes emit a bulk item when a verb matches and one backfill per requested agent property", () => {
    const rows = changes(60, { verb: "created", agentRequests: [{ propertyId: P_AGENT, inputsHash: "0123456789abcdef" }] });
    const items = buildBaseRowInboxItems({
      base: BASE,
      caller: CALLER,
      changes: rows,
      subscriptions: [unfiltered(S1, I1), filtered(S2, I2, { events: ["row.updated"] })],
      occurredAt: NOW,
    });
    expect(items.map((item) => [item.eventType, item.targetId])).toEqual([
      ["bases.rows.bulk_changed", I1],
      ["bases.agent.backfill", I1],
    ]);
    expect(items[1]?.payloadJson).toMatchObject({ propertyId: P_AGENT, rowCount: 60 });
  });
});
