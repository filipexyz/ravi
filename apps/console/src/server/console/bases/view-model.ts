// Stored view specs: parsing, validity, API conversion, and save-time
// normalization (SPEC "Views"). Stored specs use property ids; the API uses
// keys. A view that references a deleted or type-incompatible property is
// invalid until a manager fixes it. `layout.widget` is the exception: it is
// checked only when saved, and a later break never invalidates the view.

import { isBaseSystemColumn, BASE_BOARD_GROUP_KINDS } from "@/shared/bases/operators";
import { localDateString } from "@/shared/bases/time";
import type {
  BaseFilter,
  BaseProperty,
  BaseSort,
  BaseView,
  BaseViewAccess,
  BaseViewCapabilities,
  BaseViewLayout,
  BaseViewLayoutInput,
  BaseViewLayoutWidget,
  BaseViewLayoutWidgetInput,
  BaseViewLayoutWith,
  BaseViewPrincipal,
  BaseViewPublic,
  BaseViewWritePrincipal,
} from "@/shared/bases/types";
import { BASE_UUID_PATTERN, normalizeBaseValueInput, type BaseValueResult } from "@/shared/bases/values";
import { isCompatibleColumn } from "@/shared/widgets/matching";
import { WIDGET_VARIANTS, type RenderColumnType, type WidgetManifest, type WidgetVariant } from "@/shared/widgets/types";

import { computeViewAdmission, type StoredViewAccess, type ViewAdmission } from "./access";
import {
  baseFilterColumnRefs,
  baseFilterToApi,
  compileBaseSort,
  normalizeBaseFilterForStorage,
  validateBaseFilter,
  type BaseCompileColumn,
} from "./compiler";
import { basesError, isConsoleApiError, validationFailed } from "./errors";
import type { BaseViewRecord } from "./repository";
import { compileContext, type BaseScope } from "./scope";
import { BASE_BODY_REF, projectedColumns, toIso, viewColumnDescriptor, type BaseProjectedColumn } from "./serialize";
import { canDecideApproval } from "./workflow";

export type StoredViewQuery = {
  filter: BaseFilter | null;
  sort: BaseSort[];
  /** Property id -> type at save time, for every property the filter references. */
  refTypes: Record<string, string>;
};

/** `layout.widget` as stored: column refs instead of keys; the item's `ref` is read when serialized. */
export type StoredViewWidget = {
  itemId: string;
  /** Widget field key -> column ref. */
  fields: Record<string, string>;
  variant: WidgetVariant;
};

export type StoredViewLayout = BaseViewLayoutWith<StoredViewWidget>;

/** Layout types that take `layout.widget`. */
export type WidgetLayout = Extract<StoredViewLayout, { type: "board" | "list" | "gallery" | "calendar" }>;

/** Current Library refs (`org/<slug>`, `<project-slug>/<slug>`) by item id, for `layout.widget.ref`. */
export type WidgetRefs = ReadonlyMap<string, string>;

export type ParsedView = {
  record: BaseViewRecord;
  /** Column refs: property ids, system column names, or `body`. */
  columns: string[];
  query: StoredViewQuery;
  /** Layout with column refs. */
  layout: StoredViewLayout;
  access: StoredViewAccess;
};

export type ViewValidity = { valid: true; reason: null } | { valid: false; reason: string };

const VIEWER_USER = "$viewer.raviUserId";
const VIEWER_EMAIL = "$viewer.email";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parsePrincipals<T extends BaseViewPrincipal | BaseViewWritePrincipal>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is T => isRecord(item) && typeof item.kind === "string") as T[];
}

export function emptyStoredAccess(): StoredViewAccess {
  return { read: [], write: { principals: [], columns: [], create: false, archive: false, set: {}, allowEscape: false } };
}

export function isWidgetLayout<L extends { type: string }>(layout: L): layout is Extract<L, { type: WidgetLayout["type"] }> {
  return layout.type === "board" || layout.type === "list" || layout.type === "gallery" || layout.type === "calendar";
}

/** The stored widget binding of a layout, or null. */
export function layoutWidget(layout: StoredViewLayout): StoredViewWidget | null {
  return isWidgetLayout(layout) ? (layout.widget ?? null) : null;
}

function parseStoredWidget(value: unknown): StoredViewWidget | null {
  if (!isRecord(value) || typeof value.itemId !== "string") return null;
  const fields: Record<string, string> = {};
  if (isRecord(value.fields)) {
    for (const [key, ref] of Object.entries(value.fields)) if (typeof ref === "string") fields[key] = ref;
  }
  const variant = WIDGET_VARIANTS.find((name) => name === value.variant) ?? "default";
  return { itemId: value.itemId, fields, variant };
}

function parseStoredLayout(value: unknown): StoredViewLayout {
  if (!isRecord(value) || typeof value.type !== "string") return { type: "table" };
  const { widget, ...layout } = value;
  const parsed = isWidgetLayout(value as StoredViewLayout) ? parseStoredWidget(widget) : null;
  return (parsed ? { ...layout, widget: parsed } : layout) as StoredViewLayout;
}

export function parseStoredView(record: BaseViewRecord): ParsedView {
  const query = isRecord(record.queryJson) ? record.queryJson : {};
  const access = isRecord(record.accessJson) ? record.accessJson : {};
  const write = isRecord(access.write) ? access.write : {};
  return {
    record,
    columns: stringArray(record.columnsJson),
    query: {
      filter: isRecord(query.filter) ? (query.filter as BaseFilter) : null,
      sort: Array.isArray(query.sort)
        ? query.sort.filter((item): item is BaseSort => isRecord(item) && typeof item.prop === "string")
        : [],
      refTypes: isRecord(query.refTypes) ? (query.refTypes as Record<string, string>) : {},
    },
    layout: parseStoredLayout(record.layoutJson),
    access: {
      read: parsePrincipals<BaseViewPrincipal>(access.read),
      write: {
        principals: parsePrincipals<BaseViewWritePrincipal>(write.principals),
        columns: stringArray(write.columns),
        create: write.create === true,
        archive: write.archive === true,
        set: isRecord(write.set) ? write.set : {},
        allowEscape: write.allowEscape === true,
      },
    },
  };
}

/** Agent columns of the base: filled by an agent, never writable through a view. */
export function agentColumnRefs(scope: Pick<BaseScope, "properties">): Set<string> {
  return new Set(scope.properties.filter((property) => property.type === "agent").map((property) => property.id));
}

export function viewAdmission(view: ParsedView, scope: BaseScope): ViewAdmission {
  return computeViewAdmission(view, scope.access, agentColumnRefs(scope));
}

/** Columns of the view resolved against current properties (deleted ones dropped). */
export function viewProjectedColumns(view: ParsedView, scope: BaseScope): BaseProjectedColumn[] {
  return projectedColumns(view.columns, scope.propertiesById);
}

function refToKey(scope: BaseScope, ref: string) {
  if (ref === BASE_BODY_REF || isBaseSystemColumn(ref)) return ref;
  return scope.propertiesById.get(ref)?.key ?? ref;
}

// ---------------------------------------------------------------------------
// Validity

function activeColumn(scope: BaseScope, ref: string): BaseProperty | null {
  const property = scope.propertiesById.get(ref);
  return property && !property.deletedAt ? property : null;
}

function columnKindOf(scope: BaseScope, ref: string): string | null {
  if (isBaseSystemColumn(ref)) return ref;
  return activeColumn(scope, ref)?.type ?? null;
}

/** Type of a column ref as the widget matcher sees it, or null when the property was deleted. */
function columnTypeOf(scope: BaseScope, ref: string): RenderColumnType | null {
  if (ref === BASE_BODY_REF) return "body";
  if (isBaseSystemColumn(ref)) return ref;
  return activeColumn(scope, ref)?.type ?? null;
}

/** Placeholders used to test that `write.set` values still normalize. */
const VALIDITY_VIEWER = { userId: "00000000-0000-4000-8000-000000000000", email: "viewer@example.com" };

/** Shown instead of the detailed reason to callers without `base.manage`: reasons name non-projected properties. */
export const VIEW_INVALID_PUBLIC_REASON = "This view needs to be repaired by a project manager.";

/** `409 view_invalid`; the detailed reason goes only to managers. */
export function viewInvalid(scope: BaseScope, reason: string): never {
  throw basesError(409, { error: "view_invalid", reason: scope.access.manage ? reason : VIEW_INVALID_PUBLIC_REASON });
}

/**
 * Create-enabled views must cover every required property through
 * `write.columns` or `write.set`. Checked when saved, and again on create
 * because a property can become required later.
 */
export function viewCreateCoverageError(view: ParsedView, scope: BaseScope): string | null {
  if (!view.access.write.create) return null;
  const covered = new Set([...view.access.write.columns, ...Object.keys(view.access.write.set)]);
  const missing = scope.properties.filter((property) => !property.deletedAt && property.required && !covered.has(property.id));
  if (!missing.length) return null;
  return `Create-enabled views must let writers set required properties: ${missing.map((property) => property.key).join(", ")}.`;
}

export function viewValidity(view: ParsedView, scope: BaseScope): ViewValidity {
  const invalid = (reason: string): ViewValidity => ({ valid: false, reason });
  for (const ref of view.columns) {
    if (ref === BASE_BODY_REF || isBaseSystemColumn(ref)) continue;
    if (!activeColumn(scope, ref)) return invalid(`Column "${refToKey(scope, ref)}" was deleted.`);
  }
  const ctx = compileContext(scope);
  for (const ref of baseFilterColumnRefs(view.query.filter)) {
    if (isBaseSystemColumn(ref)) continue;
    const property = activeColumn(scope, ref);
    if (!property) return invalid(`The filter references the deleted property "${refToKey(scope, ref)}".`);
    const savedType = view.query.refTypes[ref];
    if (savedType && savedType !== property.type) {
      return invalid(`The filter references "${property.key}", whose type changed.`);
    }
  }
  try {
    validateBaseFilter(view.query.filter, ctx, { allowMissingViewer: true });
  } catch (error) {
    if (isConsoleApiError(error)) return invalid(`The filter is no longer valid: ${error.payload.reason ?? error.payload.error}`);
    throw error;
  }
  try {
    compileBaseSort(view.query.sort, ctx);
  } catch (error) {
    if (isConsoleApiError(error)) return invalid(`The sort is no longer valid: ${error.payload.reason ?? error.payload.error}`);
    throw error;
  }
  const layoutError = layoutReferenceError(view.layout, view.columns, scope);
  if (layoutError) return invalid(layoutError);
  const projected = new Set(view.columns);
  for (const ref of view.access.write.columns) {
    if (!projected.has(ref)) return invalid(`Writable column "${refToKey(scope, ref)}" is not a view column.`);
    if (ref !== BASE_BODY_REF && !activeColumn(scope, ref)) return invalid(`Writable column "${refToKey(scope, ref)}" was deleted.`);
  }
  for (const [ref, stored] of Object.entries(view.access.write.set)) {
    const property = activeColumn(scope, ref);
    if (!property) return invalid(`Preset "${refToKey(scope, ref)}" was deleted.`);
    const result = resolveSetValue(property, stored, {
      userId: VALIDITY_VIEWER.userId,
      email: VALIDITY_VIEWER.email,
      now: scope.now,
      timezone: scope.base.timezone,
    });
    if (!result.ok) return invalid(`Preset "${property.key}" is no longer valid: ${result.error}`);
  }
  return { valid: true, reason: null };
}

/** Layout column refs (not `widget`, which never invalidates a view). */
function layoutReferenceError(layout: StoredViewLayout, columns: readonly string[], scope: BaseScope): string | null {
  const projected = new Set(columns);
  const check = (ref: string | null | undefined, kinds: readonly string[], label: string) => {
    if (!ref) return null;
    if (!projected.has(ref)) return `The ${label} "${refToKey(scope, ref)}" is not a view column.`;
    const kind = columnKindOf(scope, ref);
    if (!kind) return `The ${label} "${refToKey(scope, ref)}" was deleted.`;
    if (!kinds.includes(kind)) return `The ${label} "${refToKey(scope, ref)}" must be ${kinds.join(" or ")}.`;
    return null;
  };
  switch (layout.type) {
    case "board":
      return check(layout.groupBy, [...BASE_BOARD_GROUP_KINDS], "board group");
    case "calendar":
      return check(layout.dateProp, ["date", "created_time", "updated_time"], "calendar date");
    case "gallery":
      return check(layout.coverProp ?? null, ["url", "text"], "gallery cover");
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// API shapes

/**
 * Widget fields come back by key. Mappings to deleted or non-projected columns
 * are left out: responses name only projected columns, and the Page then
 * matches that widget field by name.
 */
function widgetToApi(widget: StoredViewWidget, columns: readonly string[], scope: BaseScope, refs: WidgetRefs): BaseViewLayoutWidget {
  const projected = new Set(columns);
  const fields: Record<string, string> = {};
  for (const [fieldKey, ref] of Object.entries(widget.fields)) {
    if (projected.has(ref) && columnTypeOf(scope, ref)) fields[fieldKey] = refToKey(scope, ref);
  }
  return { itemId: widget.itemId, ref: refs.get(widget.itemId) ?? null, fields, variant: widget.variant };
}

function layoutToApi(view: ParsedView, scope: BaseScope, refs: WidgetRefs): BaseViewLayout {
  const { layout } = view;
  const widget = layoutWidget(layout);
  const widgetApi: { widget?: BaseViewLayoutWidget } = widget ? { widget: widgetToApi(widget, view.columns, scope, refs) } : {};
  switch (layout.type) {
    case "board":
      return { ...withoutWidget(layout), groupBy: refToKey(scope, layout.groupBy), ...widgetApi };
    case "calendar":
      return { ...withoutWidget(layout), dateProp: refToKey(scope, layout.dateProp), ...widgetApi };
    case "gallery":
      return layout.coverProp
        ? { ...withoutWidget(layout), coverProp: refToKey(scope, layout.coverProp), ...widgetApi }
        : { ...withoutWidget(layout), ...widgetApi };
    case "list":
      return { ...withoutWidget(layout), ...widgetApi };
    case "table": {
      if (!layout.columnWidths) return { ...layout };
      const widths: Record<string, number> = {};
      for (const [ref, width] of Object.entries(layout.columnWidths)) widths[refToKey(scope, ref)] = width;
      return { ...layout, columnWidths: widths };
    }
    default:
      return { ...layout };
  }
}

function accessToApi(access: StoredViewAccess, scope: BaseScope): BaseViewAccess {
  const set: Record<string, unknown> = {};
  for (const [ref, value] of Object.entries(access.write.set)) set[refToKey(scope, ref)] = value;
  return {
    read: access.read.map((principal) => ({ ...principal })),
    write: {
      principals: access.write.principals.map((principal) => ({ ...principal })),
      columns: access.write.columns.map((ref) => refToKey(scope, ref)),
      create: access.write.create,
      archive: access.write.archive,
      set,
      allowEscape: access.write.allowEscape,
    },
  };
}

export function viewCapabilities(admission: ViewAdmission, scope: BaseScope): BaseViewCapabilities {
  return {
    read: admission.read,
    aggregateOnly: admission.aggregateOnly,
    writeColumns: admission.writeColumns.map((ref) => refToKey(scope, ref)),
    create: admission.create,
    archive: admission.archive,
    manage: admission.manage,
    approve: admission.writeColumns.flatMap((ref) => {
      const property = scope.propertiesById.get(ref);
      return property && !property.deletedAt && canDecideApproval(property, scope.caller, scope.access) ? [property.key] : [];
    }),
  };
}

/** Full view for managers. `widgetRefs` names the `layout.widget` item (`loadWidgetRefs`). */
export function viewToApi(
  view: ParsedView,
  scope: BaseScope,
  widgetRefs: WidgetRefs,
  admission: ViewAdmission = viewAdmission(view, scope),
): BaseView {
  const validity = viewValidity(view, scope);
  return {
    id: view.record.id,
    baseId: view.record.baseId,
    name: view.record.name,
    description: view.record.description,
    columns: view.columns.map((ref) => refToKey(scope, ref)),
    query: {
      filter: baseFilterToApi(view.query.filter, (ref) => refToKey(scope, ref)),
      sort: view.query.sort.map((entry) => ({ prop: refToKey(scope, entry.prop), dir: entry.dir === "desc" ? "desc" : "asc" })),
    },
    layout: layoutToApi(view, scope, widgetRefs),
    access: accessToApi(view.access, scope),
    position: view.record.position,
    version: view.record.version,
    status: view.record.status === "archived" ? "archived" : "active",
    valid: validity.valid,
    invalidReason: validity.reason,
    createdAt: toIso(view.record.createdAt) ?? "",
    updatedAt: toIso(view.record.updatedAt) ?? "",
    capabilities: viewCapabilities(admission, scope),
  };
}

/** Public shape: no filter, no access, no non-projected property metadata. */
export function viewToPublic(
  view: ParsedView,
  scope: BaseScope,
  widgetRefs: WidgetRefs,
  admission: ViewAdmission = viewAdmission(view, scope),
): BaseViewPublic {
  return {
    id: view.record.id,
    baseId: view.record.baseId,
    name: view.record.name,
    description: view.record.description,
    layout: layoutToApi(view, scope, widgetRefs),
    version: view.record.version,
    columns: viewProjectedColumns(view, scope).map(viewColumnDescriptor),
    capabilities: viewCapabilities(admission, scope),
    valid: viewValidity(view, scope).valid,
  };
}

// ---------------------------------------------------------------------------
// write.set values

export type SetValueContext = { userId: string | null; email: string | null; now: Date; timezone: string };

/** Resolves a stored `write.set` value (literal or viewer variable) to a stored cell value. */
export function resolveSetValue(property: BaseProperty, stored: unknown, ctx: SetValueContext): BaseValueResult | { ok: false; error: string; viewerRequired: true } {
  let input: unknown = stored;
  if (property.type === "person") {
    const items = Array.isArray(stored) ? stored : [stored];
    const resolved: unknown[] = [];
    for (const item of items) {
      if (item === VIEWER_USER) {
        if (!ctx.userId) return { ok: false, error: "This preset needs a signed-in viewer.", viewerRequired: true };
        resolved.push(ctx.userId);
      } else resolved.push(item);
    }
    input = resolved;
  } else if (property.type === "email" && stored === VIEWER_EMAIL) {
    if (!ctx.email) return { ok: false, error: "This preset needs a viewer email.", viewerRequired: true };
    input = ctx.email;
  } else if (property.type === "date" && (stored === "$now" || stored === "$today")) {
    input = stored === "$now" && property.config.includeTime ? ctx.now.toISOString() : localDateString(ctx.now, ctx.timezone);
  } else if (typeof stored === "string" && stored.startsWith("$")) {
    return { ok: false, error: `Variable "${stored}" is not allowed for ${property.type} properties.` };
  }
  const result = normalizeBaseValueInput(property, input, { timezone: ctx.timezone });
  if (result.ok && result.value === undefined) return { ok: false, error: "Presets cannot be empty." };
  return result;
}

/** Save-time normalization of a `write.set` value; keeps viewer variables. Collects literal person ids. */
function normalizeSetValueForStorage(
  property: BaseProperty,
  value: unknown,
  scope: BaseScope,
  personIds: Set<string>,
): { ok: true; stored: unknown } | { ok: false; error: string } {
  if (property.type === "person") {
    const items = Array.isArray(value) ? value : [value];
    if (!items.length) return { ok: false, error: "Presets cannot be empty." };
    const stored: string[] = [];
    for (const item of items) {
      if (item === VIEWER_USER) {
        if (!stored.includes(VIEWER_USER)) stored.push(VIEWER_USER);
        continue;
      }
      if (typeof item !== "string" || !BASE_UUID_PATTERN.test(item)) return { ok: false, error: "Expected user ids or $viewer.raviUserId." };
      const id = item.toLowerCase();
      if (!stored.includes(id)) stored.push(id);
      personIds.add(id);
    }
    return { ok: true, stored };
  }
  if (property.type === "email" && value === VIEWER_EMAIL) return { ok: true, stored: value };
  if (property.type === "date" && (value === "$now" || value === "$today")) return { ok: true, stored: value };
  const result = resolveSetValue(property, value, { userId: null, email: null, now: scope.now, timezone: scope.base.timezone });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, stored: result.value };
}

// ---------------------------------------------------------------------------
// Save-time normalization

export type ViewSpecInput = {
  columns?: string[];
  query?: { filter: BaseFilter | null; sort: BaseSort[] };
  layout?: BaseViewLayoutInput;
  access?: BaseViewAccess;
};

/**
 * A `layout.widget` from the request, with its columns resolved and checked
 * as projected. The Library item and the manifest are checked before the
 * view is stored (`views.ts`), which then binds it with `bindLayoutWidget`.
 */
export type LayoutWidgetBinding = {
  itemId: string | null;
  ref: string | null;
  /** Widget field key -> column ref. */
  fields: Record<string, string>;
  /** Widget field key -> the mapped column's key and type, for the manifest check. */
  columns: Record<string, { key: string; type: RenderColumnType }>;
  variant: WidgetVariant;
};

export type NormalizedViewSpec = {
  columns: string[];
  query: StoredViewQuery;
  /** A widget sent in the request is not in `layout` until `bindLayoutWidget`; a stored one is kept as is. */
  layout: StoredViewLayout;
  access: StoredViewAccess;
  /** Literal user ids that must be active org members (principals and person presets). */
  memberIds: Set<string>;
  /** Page sites that must belong to the base project. */
  siteIds: Set<string>;
  /** Chart referenced by a chart layout; must be a chart of this base. */
  chartId: string | null;
  /** Widget sent in the request, to check against the Library before saving. */
  widget: LayoutWidgetBinding | null;
};

function resolveRef(scope: BaseScope, value: string, resolve: (ref: string) => BaseCompileColumn | null): string | null {
  if (value === BASE_BODY_REF) return BASE_BODY_REF;
  const column = resolve(value);
  return column ? column.ref : null;
}

function dedupePrincipals<T extends BaseViewPrincipal | BaseViewWritePrincipal>(principals: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const principal of principals) {
    const key = JSON.stringify(principal);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(principal);
  }
  return out;
}

function normalizePrincipal<T extends BaseViewPrincipal | BaseViewWritePrincipal>(principal: T): T {
  if (principal.kind === "user") return { ...principal, userId: principal.userId.toLowerCase() };
  if (principal.kind === "page_viewer") return { ...principal, siteId: principal.siteId.toLowerCase() };
  return { ...principal };
}

function withoutWidget<T extends { widget?: unknown }>(layout: T): Omit<T, "widget"> {
  const copy = { ...layout };
  delete copy.widget;
  return copy;
}

/** The layout with `widget` set (only on layouts that take one). */
export function bindLayoutWidget(layout: StoredViewLayout, widget: StoredViewWidget): StoredViewLayout {
  return isWidgetLayout(layout) ? { ...layout, widget } : layout;
}

/**
 * Checks a widget binding against the widget's current manifest (`widget.json`
 * of its published version): every mapped field exists and accepts its
 * column's type (CONTRACT 4.6), and the variant is one the widget declares.
 * Required fields left unmapped are fine: the Page matches them by name.
 */
export function widgetBindingErrors(manifest: WidgetManifest | null, binding: LayoutWidgetBinding): Record<string, string> {
  if (!manifest) return { "layout.widget": "The widget's published version has no valid widget.json." };
  const errors: Record<string, string> = {};
  const known = Object.keys(manifest.fields);
  for (const [fieldKey, column] of Object.entries(binding.columns)) {
    const path = `layout.widget.fields.${fieldKey}`;
    const field = Object.prototype.hasOwnProperty.call(manifest.fields, fieldKey) ? manifest.fields[fieldKey] : undefined;
    if (!field) {
      errors[path] = `The widget has no field "${fieldKey}". Its fields: ${known.join(", ") || "none"}.`;
      continue;
    }
    if (!isCompatibleColumn(field.type, column.type)) {
      errors[path] = `The widget field "${fieldKey}" (${field.type}) cannot show the column "${column.key}" (${column.type}).`;
    }
  }
  if (!manifest.variants.includes(binding.variant)) {
    errors["layout.widget.variant"] = `The widget has no "${binding.variant}" variant. Its variants: ${manifest.variants.join(", ")}.`;
  }
  return errors;
}

/**
 * Validates and converts a view spec to storage form. `fallback` supplies
 * unchanged parts on update (already in storage form; refs resolve as ids).
 * Throws `unknown_property` / `invalid_filter` for filters and
 * `validation_failed` (with `fieldErrors`) for everything else.
 */
export function normalizeViewSpec(scope: BaseScope, input: ViewSpecInput, fallback: ParsedView | null): NormalizedViewSpec {
  const fieldErrors: Record<string, string> = {};
  const ctx = compileContext(scope);
  const resolve = ctx.resolve;

  const columnInputs = input.columns ?? fallback?.columns ?? scope.properties.filter((property) => !property.deletedAt).map((property) => property.id);
  const columns: string[] = [];
  for (const value of columnInputs) {
    const ref = resolveRef(scope, value, resolve);
    if (!ref) {
      fieldErrors.columns = `Unknown column "${value}".`;
      continue;
    }
    if (!columns.includes(ref)) columns.push(ref);
  }
  if (!columns.length && !fieldErrors.columns) fieldErrors.columns = "A view needs at least one column.";
  const projected = new Set(columns);

  const queryInput = input.query ?? (fallback ? { filter: fallback.query.filter, sort: fallback.query.sort } : { filter: null, sort: [] });
  const filter = normalizeBaseFilterForStorage(queryInput.filter, ctx);
  const refTypes: Record<string, string> = {};
  for (const ref of baseFilterColumnRefs(filter)) {
    const property = scope.propertiesById.get(ref);
    if (property) refTypes[ref] = property.type;
  }
  const sort: BaseSort[] = [];
  for (const entry of queryInput.sort) {
    const column = resolve(entry.prop);
    if (!column) {
      fieldErrors["query.sort"] = `Unknown sort column "${entry.prop}".`;
      continue;
    }
    sort.push({ prop: column.ref, dir: entry.dir === "desc" ? "desc" : "asc" });
  }
  if (!fieldErrors["query.sort"]) {
    try {
      compileBaseSort(sort, ctx);
    } catch (error) {
      if (!isConsoleApiError(error)) throw error;
      fieldErrors["query.sort"] = error.payload.reason ?? "Invalid sort.";
    }
  }

  const layoutInput: BaseViewLayoutInput = input.layout ?? fallback?.layout ?? { type: "table" as const };
  const layoutRef = (value: string | null | undefined, field: string) => {
    if (value === null || value === undefined) return value;
    const ref = resolveRef(scope, value, resolve);
    if (!ref) {
      fieldErrors[field] = `Unknown column "${value}".`;
      return value;
    }
    return ref;
  };
  let layout: StoredViewLayout;
  let chartId: string | null = null;
  switch (layoutInput.type) {
    case "board":
      layout = { ...withoutWidget(layoutInput), groupBy: layoutRef(layoutInput.groupBy, "layout.groupBy") as string };
      break;
    case "calendar":
      layout = { ...withoutWidget(layoutInput), dateProp: layoutRef(layoutInput.dateProp, "layout.dateProp") as string };
      break;
    case "gallery":
      layout = {
        ...withoutWidget(layoutInput),
        coverProp: (layoutRef(layoutInput.coverProp ?? null, "layout.coverProp") as string | null) ?? null,
      };
      break;
    case "list":
      layout = withoutWidget(layoutInput);
      break;
    case "table": {
      const widths = layoutInput.columnWidths;
      if (widths) {
        const stored: Record<string, number> = {};
        for (const [key, width] of Object.entries(widths)) {
          const ref = layoutRef(key, "layout.columnWidths");
          if (ref && projected.has(ref)) stored[ref] = width;
        }
        layout = { ...layoutInput, columnWidths: stored };
      } else layout = { ...layoutInput };
      break;
    }
    case "chart":
      layout = { ...layoutInput, chartId: layoutInput.chartId.toLowerCase() };
      chartId = layout.chartId;
      break;
    default:
      layout = { ...layoutInput };
  }
  if (!Object.keys(fieldErrors).some((key) => key.startsWith("layout."))) {
    const layoutError = layoutReferenceError(layout, columns, scope);
    if (layoutError) fieldErrors[`layout.${layout.type === "board" ? "groupBy" : layout.type === "calendar" ? "dateProp" : "coverProp"}`] = layoutError;
  }
  let widget: LayoutWidgetBinding | null = null;
  if (isWidgetLayout(layout)) {
    if (input.layout) {
      const widgetInput = isWidgetLayout(input.layout) ? (input.layout.widget ?? null) : null;
      if (widgetInput) widget = normalizeWidgetInput(scope, widgetInput, { projected, resolve }, fieldErrors);
    } else {
      // Kept from storage (the request has no layout): the item is not checked
      // again, so a rename never fails because the widget was archived since.
      const stored = fallback ? layoutWidget(fallback.layout) : null;
      if (stored) {
        for (const [fieldKey, ref] of Object.entries(stored.fields)) {
          if (columnTypeOf(scope, ref) && !projected.has(ref)) {
            fieldErrors[`layout.widget.fields.${fieldKey}`] = `The widget field "${fieldKey}" maps "${refToKey(scope, ref)}", which is not a view column.`;
          }
        }
        layout = bindLayoutWidget(layout, { ...stored, fields: { ...stored.fields } });
      }
    }
  }

  const memberIds = new Set<string>();
  const siteIds = new Set<string>();
  const accessInput: StoredViewAccess = input.access
    ? {
        read: input.access.read,
        write: { ...input.access.write },
      }
    : fallback?.access ?? emptyStoredAccess();
  const notePrincipal = (principal: BaseViewPrincipal | BaseViewWritePrincipal) => {
    if (principal.kind === "user") memberIds.add(principal.userId.toLowerCase());
    if (principal.kind === "page_viewer") siteIds.add(principal.siteId.toLowerCase());
  };
  const read = dedupePrincipals(accessInput.read.map(normalizePrincipal));
  const writePrincipals = dedupePrincipals(accessInput.write.principals.map(normalizePrincipal));
  read.forEach(notePrincipal);
  writePrincipals.forEach(notePrincipal);

  const writeColumns: string[] = [];
  for (const value of accessInput.write.columns) {
    const ref = resolveRef(scope, value, resolve);
    if (!ref || !projected.has(ref)) {
      fieldErrors["access.write.columns"] = `Writable column "${value}" must be a view column.`;
      continue;
    }
    if (isBaseSystemColumn(ref)) {
      fieldErrors["access.write.columns"] = `System column "${value}" is read-only.`;
      continue;
    }
    if (scope.propertiesById.get(ref)?.type === "agent") {
      fieldErrors["access.write.columns"] = `Agent column "${value}" is filled by an agent and is never writable through a view.`;
      continue;
    }
    if (!writeColumns.includes(ref)) writeColumns.push(ref);
  }

  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(accessInput.write.set)) {
    const column = resolve(key);
    if (!column || !column.property) {
      fieldErrors[`access.write.set.${key}`] = `Presets must name a writable property.`;
      continue;
    }
    if (column.property.type === "approval" || column.property.type === "agent") {
      fieldErrors[`access.write.set.${column.key}`] = `${column.property.type === "approval" ? "Approval" : "Agent"} columns cannot have presets.`;
      continue;
    }
    const normalized = normalizeSetValueForStorage(column.property, value, scope, memberIds);
    if (!normalized.ok) {
      fieldErrors[`access.write.set.${column.key}`] = normalized.error;
      continue;
    }
    set[column.ref] = normalized.stored;
  }

  if (accessInput.write.create) {
    const covered = new Set([...writeColumns, ...Object.keys(set)]);
    const missing = scope.properties.filter((property) => !property.deletedAt && property.required && !covered.has(property.id));
    if (missing.length) {
      fieldErrors["access.write.create"] = `Create-enabled views must let writers set required properties: ${missing.map((property) => property.key).join(", ")}.`;
    }
  }

  if (Object.keys(fieldErrors).length) validationFailed(fieldErrors);

  return {
    columns,
    query: { filter, sort, refTypes },
    layout,
    access: {
      read,
      write: {
        principals: writePrincipals,
        columns: writeColumns,
        create: accessInput.write.create,
        archive: accessInput.write.archive,
        set,
        allowEscape: accessInput.write.allowEscape,
      },
    },
    memberIds,
    siteIds,
    chartId,
    widget,
  };
}

/** Resolves a request's `layout.widget` columns; mapped columns must be view columns. */
function normalizeWidgetInput(
  scope: BaseScope,
  input: BaseViewLayoutWidgetInput,
  columnsOf: { projected: ReadonlySet<string>; resolve: (ref: string) => BaseCompileColumn | null },
  fieldErrors: Record<string, string>,
): LayoutWidgetBinding {
  const { projected, resolve } = columnsOf;
  const fields: Record<string, string> = {};
  const columns: LayoutWidgetBinding["columns"] = {};
  for (const [fieldKey, value] of Object.entries(input.fields ?? {})) {
    const path = `layout.widget.fields.${fieldKey}`;
    const ref = resolveRef(scope, value, resolve);
    const type = ref ? columnTypeOf(scope, ref) : null;
    if (!ref || !type) {
      fieldErrors[path] = `Unknown column "${value}".`;
      continue;
    }
    if (!projected.has(ref)) {
      fieldErrors[path] = `The column "${value}" is not a view column.`;
      continue;
    }
    fields[fieldKey] = ref;
    columns[fieldKey] = { key: refToKey(scope, ref), type };
  }
  return {
    itemId: input.itemId ? input.itemId.toLowerCase() : null,
    ref: input.ref ? input.ref.trim() : null,
    fields,
    columns,
    variant: input.variant ?? "default",
  };
}
