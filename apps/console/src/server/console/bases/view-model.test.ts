import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import type { BaseProperty, BasePropertyType, BaseViewLayoutInput } from "@/shared/bases/types";
import type { RenderColumnType, WidgetManifest, WidgetVariant } from "@/shared/widgets/types";

import type { BasesCallerAccess } from "./access";
import { basesSystemCaller } from "./context";
import { viewReferences } from "./properties";
import type { BaseProjectRecord, BaseRecord, BaseViewRecord } from "./repository";
import { buildBaseScope } from "./scope";
import {
  bindLayoutWidget,
  layoutWidget,
  normalizeViewSpec,
  parseStoredView,
  viewToApi,
  viewToPublic,
  viewValidity,
  widgetBindingErrors,
  type LayoutWidgetBinding,
} from "./view-model";

const ORG = "0a000000-0000-4000-8000-000000000001";
const PROJECT = "0a000000-0000-4000-8000-000000000002";
const BASE = "0a000000-0000-4000-8000-000000000003";
const VIEW = "0a000000-0000-4000-8000-000000000004";
const ITEM = "0a000000-0000-4000-8000-0000000000aa";

const P = {
  name: "6e0b0000-0000-4000-8000-000000000001",
  amount: "6e0b0000-0000-4000-8000-000000000002",
  stage: "6e0b0000-0000-4000-8000-000000000003",
  owner: "6e0b0000-0000-4000-8000-000000000004",
  cover: "6e0b0000-0000-4000-8000-000000000005",
  due: "6e0b0000-0000-4000-8000-000000000006",
  old: "6e0b0000-0000-4000-8000-000000000007",
};

function property(key: keyof typeof P, type: BasePropertyType, position: number, extra: Partial<BaseProperty> = {}): BaseProperty {
  return { id: P[key], key, name: key, description: null, type, config: {}, position, required: false, deletedAt: null, ...extra };
}

const PROPERTIES: BaseProperty[] = [
  property("name", "text", 0, { required: true }),
  property("amount", "number", 1),
  property("stage", "select", 2, { config: { options: [{ id: "o1", name: "Lead", color: "gray" }] } }),
  property("owner", "person", 3),
  property("cover", "url", 4),
  property("due", "date", 5, { config: { includeTime: false } }),
  property("old", "text", 6, { deletedAt: "2026-10-01T00:00:00.000Z" }),
];

const ACCESS = { projectRole: "project_admin", userId: null, activeOrgMember: true, pageSiteId: null, pageSurface: false, manage: true };

const scope = buildBaseScope(
  {
    caller: basesSystemCaller(ORG, "req-test"),
    project: { id: PROJECT, organizationId: ORG, slug: "crm", status: "active" } as unknown as BaseProjectRecord,
    access: ACCESS as unknown as BasesCallerAccess,
    projectReadOnly: false,
  },
  { id: BASE, organizationId: ORG, projectId: PROJECT, timezone: "UTC", status: "active" } as unknown as BaseRecord,
  PROPERTIES,
);

const COLUMNS = [P.name, P.amount, P.stage, P.owner, P.due, "created_time", "body"];

function record(layoutJson: unknown, columnsJson: string[] = COLUMNS): BaseViewRecord {
  return {
    id: VIEW,
    baseId: BASE,
    name: "Pipeline",
    description: null,
    columnsJson,
    queryJson: { filter: null, sort: [], refTypes: {} },
    layoutJson,
    accessJson: {},
    position: 0,
    version: 3,
    status: "active",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-02T00:00:00Z"),
  } as unknown as BaseViewRecord;
}

function fieldErrorsOf(fn: () => unknown): Record<string, string> {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConsoleApiError) return (error.payload as { fieldErrors?: Record<string, string> }).fieldErrors ?? {};
    throw error;
  }
  throw new Error("expected validation_failed");
}

const KEYS = ["name", "amount", "stage", "owner", "due", "created_time", "body"];

describe("layout.widget save-time normalization", () => {
  test("keys, ids, system columns, and body resolve to column refs", () => {
    const spec = normalizeViewSpec(
      scope,
      {
        columns: KEYS,
        layout: {
          type: "board",
          groupBy: "stage",
          widget: {
            itemId: ITEM.toUpperCase(),
            ref: "org/pedido-card",
            fields: { titulo: "name", valor: P.amount, criado: "created_time", corpo: "body", responsavel: "owner" },
            variant: "compact",
          },
        },
      },
      null,
    );
    expect(spec.widget).toEqual({
      itemId: ITEM,
      ref: "org/pedido-card",
      fields: { titulo: P.name, valor: P.amount, criado: "created_time", corpo: "body", responsavel: P.owner },
      columns: {
        titulo: { key: "name", type: "text" },
        valor: { key: "amount", type: "number" },
        criado: { key: "created_time", type: "created_time" },
        corpo: { key: "body", type: "body" },
        responsavel: { key: "owner", type: "person" },
      },
      variant: "compact",
    });
    // Bound only after the Library check.
    expect(layoutWidget(spec.layout)).toBeNull();
    const bound = bindLayoutWidget(spec.layout, { itemId: ITEM, fields: spec.widget!.fields, variant: "compact" });
    expect(bound).toEqual({
      type: "board",
      groupBy: P.stage,
      widget: { itemId: ITEM, fields: spec.widget!.fields, variant: "compact" },
    });
  });

  test("variant defaults to default and fields to none", () => {
    const spec = normalizeViewSpec(scope, { columns: KEYS, layout: { type: "list", widget: { ref: "pedido-card" } } }, null);
    expect(spec.widget).toEqual({ itemId: null, ref: "pedido-card", fields: {}, columns: {}, variant: "default" });
    expect(spec.layout).toEqual({ type: "list" });
  });

  test("unknown, deleted, and non-projected columns are field errors", () => {
    const errors = fieldErrorsOf(() =>
      normalizeViewSpec(
        scope,
        {
          columns: KEYS,
          layout: { type: "gallery", coverProp: null, widget: { itemId: ITEM, fields: { a: "nope", b: "old", c: "cover", d: "amount" } } },
        },
        null,
      ),
    );
    expect(errors["layout.widget.fields.a"]).toBe('Unknown column "nope".');
    expect(errors["layout.widget.fields.b"]).toBe('Unknown column "old".');
    expect(errors["layout.widget.fields.c"]).toBe('The column "cover" is not a view column.');
    expect(errors["layout.widget.fields.d"]).toBeUndefined();
  });

  test("other layout errors keep their field keys", () => {
    const errors = fieldErrorsOf(() =>
      normalizeViewSpec(scope, { columns: KEYS, layout: { type: "board", groupBy: "amount", widget: { itemId: ITEM } } }, null),
    );
    expect(Object.keys(errors)).toEqual(["layout.groupBy"]);
  });

  test("an update without a layout keeps the stored widget without checking the item", () => {
    const stored = parseStoredView(
      record({ type: "board", groupBy: P.stage, widget: { itemId: ITEM, fields: { titulo: P.name, antigo: P.old }, variant: "detail" } }),
    );
    const spec = normalizeViewSpec(scope, { columns: [...KEYS, "cover"] }, stored);
    expect(spec.widget).toBeNull();
    // A mapping to a deleted property is kept: the Page falls back for it.
    expect(layoutWidget(spec.layout)).toEqual({ itemId: ITEM, fields: { titulo: P.name, antigo: P.old }, variant: "detail" });
  });

  test("dropping a column the stored widget maps is a field error", () => {
    const stored = parseStoredView(record({ type: "list", widget: { itemId: ITEM, fields: { valor: P.amount }, variant: "default" } }));
    const errors = fieldErrorsOf(() => normalizeViewSpec(scope, { columns: ["name", "stage"] }, stored));
    expect(errors["layout.widget.fields.valor"]).toBe('The widget field "valor" maps "amount", which is not a view column.');
  });

  test("a layout in the request replaces the widget: null or absent removes it", () => {
    const stored = parseStoredView(record({ type: "board", groupBy: P.stage, widget: { itemId: ITEM, fields: {}, variant: "default" } }));
    for (const layout of [
      { type: "board", groupBy: "stage", widget: null },
      { type: "board", groupBy: "stage" },
      { type: "table" },
    ] as BaseViewLayoutInput[]) {
      const spec = normalizeViewSpec(scope, { layout }, stored);
      expect(spec.widget).toBeNull();
      expect(layoutWidget(spec.layout)).toBeNull();
      expect("widget" in spec.layout).toBe(false);
    }
  });
});

describe("layout.widget in responses", () => {
  const refs = new Map([[ITEM, "org/pedido-card"]]);

  test("fields come back by key with the current ref, for managers and the public shape", () => {
    for (const layoutJson of [
      { type: "board", groupBy: P.stage, widget: { itemId: ITEM, fields: { titulo: P.name, valor: P.amount }, variant: "compact" } },
      { type: "calendar", dateProp: P.due, widget: { itemId: ITEM, fields: { titulo: P.name, valor: P.amount }, variant: "compact" } },
    ]) {
      const view = parseStoredView(record(layoutJson));
      const widget = { itemId: ITEM, ref: "org/pedido-card", fields: { titulo: "name", valor: "amount" }, variant: "compact" };
      expect(viewToApi(view, scope, refs).layout).toMatchObject({ widget });
      expect(viewToPublic(view, scope, refs).layout).toMatchObject({ widget });
    }
  });

  test("list layouts map widget fields too", () => {
    const view = parseStoredView(record({ type: "list", widget: { itemId: ITEM, fields: { criado: "created_time", corpo: "body" }, variant: "default" } }));
    expect(viewToApi(view, scope, refs).layout).toEqual({
      type: "list",
      widget: { itemId: ITEM, ref: "org/pedido-card", fields: { criado: "created_time", corpo: "body" }, variant: "default" },
    });
  });

  test("ref is null when the item is gone; layouts without a widget are unchanged", () => {
    const view = parseStoredView(record({ type: "gallery", coverProp: null, widget: { itemId: ITEM, fields: {}, variant: "default" } }));
    expect(viewToApi(view, scope, new Map()).layout).toEqual({
      type: "gallery",
      coverProp: null,
      widget: { itemId: ITEM, ref: null, fields: {}, variant: "default" },
    });
    expect(viewToApi(parseStoredView(record({ type: "board", groupBy: P.stage })), scope, refs).layout).toEqual({ type: "board", groupBy: "stage" });
  });

  test("mappings to deleted or non-projected columns are left out and never invalidate the view", () => {
    const view = parseStoredView(
      record({ type: "list", widget: { itemId: ITEM, fields: { titulo: P.name, antigo: P.old, capa: P.cover }, variant: "default" } }),
    );
    expect(viewToPublic(view, scope, refs).layout).toEqual({
      type: "list",
      widget: { itemId: ITEM, ref: "org/pedido-card", fields: { titulo: "name" }, variant: "default" },
    });
    expect(viewValidity(view, scope)).toEqual({ valid: true, reason: null });
  });

  test("keys from a response normalize back to the same refs", () => {
    const view = parseStoredView(
      record({ type: "board", groupBy: P.stage, widget: { itemId: ITEM, fields: { titulo: P.name, criado: "created_time" }, variant: "detail" } }),
    );
    const api = viewToApi(view, scope, refs);
    const spec = normalizeViewSpec(scope, { columns: api.columns, layout: api.layout }, view);
    expect(spec.widget).toMatchObject({ itemId: ITEM, ref: "org/pedido-card", fields: { titulo: P.name, criado: "created_time" }, variant: "detail" });
  });

  test("stored widgets are parsed defensively", () => {
    expect(parseStoredView(record({ type: "list", widget: { fields: {} } })).layout).toEqual({ type: "list" });
    expect(parseStoredView(record({ type: "list", widget: null })).layout).toEqual({ type: "list" });
    expect(parseStoredView(record({ type: "table", widget: { itemId: ITEM } })).layout).toEqual({ type: "table" });
    expect(
      parseStoredView(record({ type: "list", widget: { itemId: ITEM, fields: { a: P.name, b: 3 }, variant: "huge" } })).layout,
    ).toEqual({ type: "list", widget: { itemId: ITEM, fields: { a: P.name }, variant: "default" } });
  });
});

describe("layout.widget manifest check", () => {
  const manifest: WidgetManifest = {
    name: "Cartão de pedido",
    description: "Pedido com status e valor.",
    fields: {
      titulo: { type: "text", required: true },
      valor: { type: "number" },
      prazo: { type: "date" },
      responsavel: { type: "person" },
      fase: { type: "select" },
    },
    variants: ["default", "compact"],
  };

  function binding(columns: Record<string, { key: string; type: RenderColumnType }>, variant: WidgetVariant = "default"): LayoutWidgetBinding {
    const fields = Object.fromEntries(Object.entries(columns).map(([key, column]) => [key, column.key]));
    return { itemId: ITEM, ref: null, fields, columns, variant };
  }

  test("compatible mappings pass; required fields may stay unmapped", () => {
    expect(
      widgetBindingErrors(
        manifest,
        binding({
          titulo: { key: "amount", type: "number" },
          valor: { key: "amount", type: "number" },
          prazo: { key: "created_time", type: "created_time" },
          responsavel: { key: "updated_by", type: "updated_by" },
          fase: { key: "status", type: "status" },
        }),
      ),
    ).toEqual({});
    expect(widgetBindingErrors(manifest, binding({}, "compact"))).toEqual({});
  });

  test("unknown fields, incompatible types, and undeclared variants are field errors", () => {
    const errors = widgetBindingErrors(
      manifest,
      // `constructor` is a valid field key and must not resolve through the prototype.
      binding(Object.fromEntries(["valor", "nope", "constructor"].map((key) => [key, { key: "name", type: "text" as const }])), "detail"),
    );
    expect(errors["layout.widget.fields.valor"]).toBe('The widget field "valor" (number) cannot show the column "name" (text).');
    expect(errors["layout.widget.fields.nope"]).toBe('The widget has no field "nope". Its fields: titulo, valor, prazo, responsavel, fase.');
    expect(errors["layout.widget.fields.constructor"]).toStartWith('The widget has no field "constructor".');
    expect(errors["layout.widget.variant"]).toBe('The widget has no "detail" variant. Its variants: default, compact.');
  });

  test("a version without a valid widget.json rejects the binding", () => {
    expect(widgetBindingErrors(null, binding({}))).toEqual({ "layout.widget": "The widget's published version has no valid widget.json." });
  });
});

describe("property dependents", () => {
  test("views whose widget maps the property depend on it", () => {
    const view = parseStoredView(record({ type: "list", widget: { itemId: ITEM, fields: { capa: P.cover }, variant: "default" } }, [P.name]));
    expect(viewReferences(view, P.cover)).toBe(true);
    expect(viewReferences(view, P.amount)).toBe(false);
  });
});
