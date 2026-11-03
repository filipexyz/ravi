import { describe, expect, test } from "bun:test";

import {
  baseAgentFillSchema,
  baseCreateViewSchema,
  baseQueryRequestSchema,
  baseSubscriptionCreateSchema,
  baseUpdateViewSchema,
  baseViewLayoutSchema,
} from "./schemas";

const ITEM = "3f1c1d2e-9a7b-4c1d-8e2f-0a1b2c3d4e5f";

function accepts(layout: unknown) {
  return baseViewLayoutSchema.safeParse(layout).success;
}

describe("layout.widget", () => {
  test("board, list, gallery, and calendar take a widget by itemId, ref, or both", () => {
    expect(accepts({ type: "board", groupBy: "stage", widget: { itemId: ITEM } })).toBe(true);
    expect(accepts({ type: "list", widget: { ref: "org/pedido-card" } })).toBe(true);
    expect(accepts({ type: "gallery", coverProp: "cover", widget: { ref: "pedido-card", fields: { titulo: "name" }, variant: "compact" } })).toBe(true);
    expect(accepts({ type: "calendar", dateProp: "due", widget: { itemId: ITEM, ref: "crm/pedido-card", variant: "detail" } })).toBe(true);
    const parsed = baseViewLayoutSchema.parse({ type: "list", widget: { ref: "  org/pedido-card ", fields: { titulo: "name", criado: "created_time" } } });
    expect(parsed).toEqual({ type: "list", widget: { ref: "org/pedido-card", fields: { titulo: "name", criado: "created_time" } } });
  });

  test("null and an absent widget are accepted", () => {
    expect(accepts({ type: "board", groupBy: "stage", widget: null })).toBe(true);
    expect(accepts({ type: "list" })).toBe(true);
    expect(accepts({ type: "calendar", dateProp: "due", widget: null })).toBe(true);
  });

  test("a widget needs itemId or ref; ref null (a response sent back) counts as absent", () => {
    const result = baseViewLayoutSchema.safeParse({ type: "list", widget: { fields: { titulo: "name" } } });
    expect(result.success).toBe(false);
    expect(accepts({ type: "list", widget: {} })).toBe(false);
    expect(accepts({ type: "list", widget: { ref: null } })).toBe(false);
    expect(accepts({ type: "list", widget: { itemId: ITEM, ref: null, fields: {}, variant: "default" } })).toBe(true);
  });

  test("malformed widgets are rejected", () => {
    expect(accepts({ type: "list", widget: { itemId: "not-a-uuid" } })).toBe(false);
    expect(accepts({ type: "list", widget: { ref: "" } })).toBe(false);
    expect(accepts({ type: "list", widget: { ref: "   " } })).toBe(false);
    expect(accepts({ type: "list", widget: { itemId: ITEM, variant: "huge" } })).toBe(false);
    expect(accepts({ type: "list", widget: { itemId: ITEM, fields: { Titulo: "name" } } })).toBe(false);
    expect(accepts({ type: "list", widget: { itemId: ITEM, fields: { titulo: "" } } })).toBe(false);
    expect(accepts({ type: "list", widget: { itemId: ITEM, fields: { titulo: 3 } } })).toBe(false);
    expect(accepts({ type: "list", widget: { itemId: ITEM, version: 2 } })).toBe(false);
    expect(accepts({ type: "list", widget: "org/pedido-card" })).toBe(false);
    const tooMany = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`f${index}`, "name"]));
    expect(accepts({ type: "list", widget: { itemId: ITEM, fields: tooMany } })).toBe(false);
    const forty = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`f${index}`, "name"]));
    expect(accepts({ type: "list", widget: { itemId: ITEM, fields: forty } })).toBe(true);
  });

  test("table, form, and chart take no widget", () => {
    expect(accepts({ type: "table", widget: { itemId: ITEM } })).toBe(false);
    expect(accepts({ type: "form", widget: { itemId: ITEM } })).toBe(false);
    expect(accepts({ type: "chart", chartId: ITEM, widget: { itemId: ITEM } })).toBe(false);
  });

  test("other layout keys stay strict", () => {
    expect(accepts({ type: "board", groupBy: "stage", cardFields: ["name"] })).toBe(false);
    expect(accepts({ type: "list", groupBy: "stage" })).toBe(false);
    expect(accepts({ type: "gallery", coverProp: "cover", widgets: [] })).toBe(false);
    expect(accepts({ type: "table", wrap: true })).toBe(true);
    expect(accepts({ type: "chart", chartId: ITEM })).toBe(true);
  });

  test("view create and update bodies carry the widget through", () => {
    const layout = { type: "board" as const, groupBy: "stage", widget: { ref: "org/pedido-card", fields: { valor: "amount" } } };
    expect(baseCreateViewSchema.parse({ name: "Pipeline", layout }).layout).toEqual(layout);
    expect(baseUpdateViewSchema.parse({ expectedVersion: 2, layout }).layout).toEqual(layout);
    expect(baseUpdateViewSchema.safeParse({ expectedVersion: 2, layout: { ...layout, widget: { fields: {} } } }).success).toBe(false);
  });
});

describe("H1/H2 request bodies", () => {
  const HASH = "0123456789abcdef";

  test("agent fills take inputsHash and exactly one of value or error", () => {
    expect(baseAgentFillSchema.safeParse({ inputsHash: HASH, value: "x", idempotencyKey: "fill-0001" }).success).toBe(true);
    expect(baseAgentFillSchema.safeParse({ inputsHash: HASH, value: null }).success).toBe(true);
    expect(baseAgentFillSchema.safeParse({ inputsHash: HASH, error: "timeout" }).success).toBe(true);
    expect(baseAgentFillSchema.safeParse({ inputsHash: HASH }).success).toBe(false);
    expect(baseAgentFillSchema.safeParse({ inputsHash: HASH, value: "x", error: "y" }).success).toBe(false);
    expect(baseAgentFillSchema.safeParse({ inputsHash: "XYZ", value: "x" }).success).toBe(false);
    expect(baseAgentFillSchema.safeParse({ inputsHash: HASH, error: "e".repeat(1001) }).success).toBe(false);
  });

  test("subscription filters: view uuid, 1..20 properties, known events; empty body allowed", () => {
    expect(baseSubscriptionCreateSchema.safeParse({}).success).toBe(true);
    expect(baseSubscriptionCreateSchema.safeParse({ viewId: ITEM, properties: ["status"], events: ["row.updated", "approval.decided"] }).success).toBe(true);
    expect(baseSubscriptionCreateSchema.safeParse({ properties: [] }).success).toBe(false);
    expect(baseSubscriptionCreateSchema.safeParse({ properties: Array.from({ length: 21 }, (_, i) => `p${i}`) }).success).toBe(false);
    expect(baseSubscriptionCreateSchema.safeParse({ events: ["row.deleted"] }).success).toBe(false);
    expect(baseSubscriptionCreateSchema.safeParse({ viewId: "pipeline" }).success).toBe(false);
  });

  test("queries take a trimmed search of 1..200 chars and a uuid asUserId", () => {
    expect(baseQueryRequestSchema.parse({ search: "  acme " }).search).toBe("acme");
    expect(baseQueryRequestSchema.safeParse({ search: "   " }).success).toBe(false);
    expect(baseQueryRequestSchema.safeParse({ search: "x".repeat(201) }).success).toBe(false);
    expect(baseQueryRequestSchema.safeParse({ asUserId: ITEM }).success).toBe(true);
    expect(baseQueryRequestSchema.safeParse({ asUserId: "ana" }).success).toBe(false);
  });
});
