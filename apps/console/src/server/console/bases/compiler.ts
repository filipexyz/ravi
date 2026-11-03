// Bases Query AST compiler. Turns filters, sorts, and aggregations into
// parameterized SQL over `base_rows AS r`. This is the only reader of
// `values_json`. See `.ravi/specs/console/bases/SPEC.md` "Query AST".
//
// Every property id and value is bound as a parameter; `sql.raw` is used only
// for operators, directions, aliases, and date_trunc units chosen here.

import { createHash } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { BASES_LIMITS } from "@/shared/bases/limits";
import {
  BASE_AGGREGATE_OPS_BY_KIND,
  BASE_GROUPABLE_KINDS,
  BASE_OPERATORS_BY_KIND,
  BASE_SORTABLE_KINDS,
  BASE_TEMPORAL_KINDS,
  BASE_VALUELESS_OPS,
  baseViewerVariableAllowed,
  type BaseColumnKind,
} from "@/shared/bases/operators";
import { baseFilterShapeError } from "@/shared/bases/schemas";
import {
  addToDateOnly,
  baseWithinRange,
  isBaseWithinValue,
  isValidDateOnly,
  isValidTimeZone,
  localDateString,
  normalizeBaseInstant,
  zonedMidnightUtc,
} from "@/shared/bases/time";
import {
  BASE_AGENT_STATES,
  BASE_AGGREGATE_OPS,
  BASE_APPROVAL_STATES,
  BASE_FILTER_OPS,
  BASE_STATUS_GROUPS,
  BASE_SYSTEM_COLUMNS,
  BASE_TIME_UNITS,
  BASE_VIEWER_VARIABLES,
  type BaseAggregateOp,
  type BaseAggregateRequest,
  type BaseFilter,
  type BaseFilterLeaf,
  type BaseFilterOp,
  type BaseProperty,
  type BaseRefValue,
  type BaseSort,
  type BaseSortDirection,
  type BaseStatusGroup,
  type BaseTimeUnit,
  type BaseViewerVariable,
  type BaseWithinValue,
} from "@/shared/bases/types";
import { BASE_UUID_PATTERN, baseHasNul, baseUtf8Bytes, findBaseOption, normalizeBaseRef } from "@/shared/bases/values";

// ---------------------------------------------------------------------------
// Public types

/** A filterable/sortable column: a property or a system column. */
export type BaseCompileColumn = {
  /** Property id, or the system column name. Stored specs use this. */
  ref: string;
  /** API key: property key, or the system column name. */
  key: string;
  kind: BaseColumnKind;
  property: BaseProperty | null;
};

/** Authenticated caller identity used to resolve `$viewer.*` variables. */
export type BaseViewer = { raviUserId: string; raviOrgId: string; email: string | null };

export type BaseCompileContext = {
  baseId: string;
  /** Base IANA timezone; defines `$today`, local days, weeks, and months. */
  timezone: string;
  now: Date;
  viewer: BaseViewer | null;
  /** Maps a key, property id, or system column name to a column; null when unknown or not allowed. */
  resolve: (ref: string) => BaseCompileColumn | null;
};

export type BaseValidateFilterOptions = {
  /** Accept `$viewer.*` without a viewer (validating a stored view filter at save time). */
  allowMissingViewer?: boolean;
};

/** SQL type used to bind a keyset cursor value back for comparison. */
export type BaseSortKeyType = "text" | "numeric" | "timestamptz" | "integer" | "boolean" | "uuid";

export type BaseSortKey = {
  /** Sorted column; null for the `r.id` tie-breaker (and `r.created_at` when added as one). */
  column: BaseCompileColumn | null;
  dir: BaseSortDirection;
  /** Sort expression. NULL means empty and sorts last in both directions. */
  expr: SQL;
  /** Text projection of `expr`, selected as `__s<i>` and stored in cursors. */
  select: SQL;
  type: BaseSortKeyType;
  nullable: boolean;
};

export type BaseCompiledSort = {
  /** ORDER BY list (without the keywords), ending with the tie-breakers. */
  orderBy: SQL;
  /** One key per ORDER BY entry; services select `keys[i].select` as `__s<i>`. */
  keys: BaseSortKey[];
};

export type BaseRowsQueryInput = {
  organizationId: string;
  baseId: string;
  /** Compiled filter (policy AND request), from `compileBaseFilter`. */
  filterSql: SQL;
  sort: BaseCompiledSort;
  /** Decoded cursor values (`__s<i>` of the last row of the previous page). */
  cursorValues?: unknown[] | null;
  /** Page size, 1..500. The query returns up to `limit + 1` rows. */
  limit: number;
  includeArchived: boolean;
  includeBody: boolean;
};

/** One row of `buildBaseRowsQuery`. Timestamps are ISO-8601 strings with millisecond precision. */
export type BaseRowsQueryRow = {
  id: string;
  version: number;
  values_json: Record<string, unknown>;
  body: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  created_by_actor_id: string | null;
  updated_by_actor_id: string | null;
  [sortColumn: `__s${number}`]: string | null;
};

export type BaseRowMatchQueryInput = {
  organizationId: string;
  baseId: string;
  rowId: string;
  filterSql: SQL;
};

export type BaseAggregateDimension = { key: string; column: BaseCompileColumn; timeUnit?: BaseTimeUnit };
export type BaseAggregateMeasure = { as: string; op: BaseAggregateOp; column: BaseCompileColumn | null };

/**
 * Result columns: `g0`, `g1` (one per dimension), `m_<as>` (one per measure),
 * and `__count` (rows in the group, for aggregate-mode suppression).
 */
export type BaseCompiledAggregate = {
  query: SQL;
  dimensions: BaseAggregateDimension[];
  measures: BaseAggregateMeasure[];
};

// ---------------------------------------------------------------------------
// Columns and resolvers

/** Compile columns for the base's active properties plus the system columns. */
export function baseCompileColumns(properties: readonly BaseProperty[]): BaseCompileColumn[] {
  const columns: BaseCompileColumn[] = properties
    .filter((property) => !property.deletedAt)
    .map((property) => ({ ref: property.id, key: property.key, kind: property.type, property }));
  for (const name of BASE_SYSTEM_COLUMNS) columns.push({ ref: name, key: name, kind: name, property: null });
  return columns;
}

/**
 * Resolver over active properties and system columns, by key, property id, or
 * system name. With `allowed` (refs or keys, e.g. a view's projected columns),
 * every other column resolves to null exactly like an unknown one.
 */
export function createBaseColumnResolver(
  properties: readonly BaseProperty[],
  options: { allowed?: Iterable<string> | null } = {},
): (ref: string) => BaseCompileColumn | null {
  const byName = new Map<string, BaseCompileColumn>();
  for (const column of baseCompileColumns(properties)) {
    byName.set(column.ref, column);
    byName.set(column.key, column);
  }
  const allowed = options.allowed ? new Set(options.allowed) : null;
  return (ref: string) => {
    if (typeof ref !== "string") return null;
    const column = byName.get(ref) ?? null;
    if (!column || !allowed) return column;
    return allowed.has(column.ref) || allowed.has(column.key) ? column : null;
  };
}

// ---------------------------------------------------------------------------
// Errors

function clip(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 64 ? `${text.slice(0, 64)}...` : text;
}

function unknownProperty(prop: unknown): never {
  throw new ConsoleApiError(400, { error: "unknown_property", reason: `Unknown property "${clip(prop)}".` });
}

function invalidFilter(reason: string): never {
  throw new ConsoleApiError(400, { error: "invalid_filter", reason });
}

function viewerRequired(): never {
  throw new ConsoleApiError(403, { error: "base_forbidden", reason: "viewer_required" });
}

function cursorInvalid(): never {
  throw new ConsoleApiError(400, { error: "cursor_invalid" });
}

function resolveColumn(ctx: BaseCompileContext, prop: unknown): BaseCompileColumn {
  if (typeof prop !== "string" || !prop) unknownProperty(prop);
  const column = ctx.resolve(prop);
  if (!column || column.property?.deletedAt) unknownProperty(prop);
  return column;
}

// ---------------------------------------------------------------------------
// Filter structure

type FilterRecord = Record<string, unknown>;

function isRecord(value: unknown): value is FilterRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const FILTER_OPS: ReadonlySet<string> = new Set(BASE_FILTER_OPS);

const LOGICAL_KEYS = ["and", "or", "not"] as const;
const LEAF_KEYS: ReadonlySet<string> = new Set(["prop", "op", "value"]);

/** Checks the filter grammar. Errors name the operator or the node key at fault. */
function checkFilterStructure(filter: unknown) {
  let leaves = 0;
  const visit = (node: unknown, depth: number) => {
    if (depth > BASES_LIMITS.filterDepth) invalidFilter(`Filters may nest at most ${BASES_LIMITS.filterDepth} levels.`);
    if (!isRecord(node)) {
      const got = node === null ? "null" : Array.isArray(node) ? "an array" : `a ${typeof node}`;
      invalidFilter(`Filter nodes are objects (a condition, or and/or/not), not ${got}.`);
    }
    const keys = Object.keys(node);
    const logical = LOGICAL_KEYS.find((key) => key in node);
    if (logical) {
      const extra = keys.find((key) => key !== logical);
      if (extra !== undefined) {
        invalidFilter(`Unexpected key "${clip(extra)}" beside "${logical}": logical nodes have exactly one of and, or, not.`);
      }
      if (logical === "not") {
        visit(node.not, depth + 1);
        return;
      }
      const children = node[logical];
      if (!Array.isArray(children) || children.length < 1 || children.length > BASES_LIMITS.filterChildren) {
        invalidFilter(`"${logical}" takes an array of 1-${BASES_LIMITS.filterChildren} filters.`);
      }
      for (const child of children) visit(child, depth + 1);
      return;
    }
    const unknownKey = keys.find((key) => !LEAF_KEYS.has(key));
    if (unknownKey !== undefined) {
      invalidFilter(`Unknown filter key "${clip(unknownKey)}": conditions have only prop, op, and value.`);
    }
    if (typeof node.prop !== "string" || !node.prop) invalidFilter("Filter conditions need a prop.");
    if (node.op === undefined) invalidFilter(`The condition on "${clip(node.prop)}" needs an op.`);
    if (typeof node.op !== "string" || !FILTER_OPS.has(node.op)) invalidFilter(`Unknown operator "${clip(node.op)}".`);
    leaves += 1;
    if (leaves > BASES_LIMITS.filterLeaves) invalidFilter(`Filters may have at most ${BASES_LIMITS.filterLeaves} conditions.`);
  };
  visit(filter, 1);
  const shapeError = baseFilterShapeError(filter as BaseFilter);
  if (shapeError) invalidFilter(shapeError);
}

// ---------------------------------------------------------------------------
// Leaf validation

type ViewerVariable = BaseViewerVariable;
type DateOperand = string; // "YYYY-MM-DD", normalized instant, "$today", or "$now"

type Operand =
  | { t: "none" }
  | { t: "string"; v: string }
  | { t: "number"; v: number }
  | { t: "number_range"; v: [number, number] }
  | { t: "bool"; v: boolean }
  | { t: "date"; v: DateOperand }
  | { t: "date_range"; v: [DateOperand, DateOperand] }
  | { t: "within"; v: BaseWithinValue }
  | { t: "options"; v: string[] }
  | { t: "group"; group: BaseStatusGroup; ids: string[] }
  | { t: "ids"; v: string[] }
  | { t: "ref"; v: BaseRefValue };

type ResolvedLeaf = {
  column: BaseCompileColumn;
  op: BaseFilterOp;
  operand: Operand;
  /** Canonical value for storage (option ids, normalized instants, lowercased emails). */
  stored: unknown;
  viewerVariables: Set<ViewerVariable>;
};

const VIEWER_VARIABLES: ReadonlySet<string> = new Set(BASE_VIEWER_VARIABLES);
const DATE_VALUE_OPS: ReadonlySet<BaseFilterOp> = new Set(["eq", "before", "after", "on_or_before", "on_or_after", "between"]);
const UUID_VARIABLES: ReadonlySet<string> = new Set(["$viewer.raviUserId", "$viewer.raviOrgId"]);
const FILTER_ARRAY_MAX = 200;
/** Last day the date grammar accepts; the day after it has no representable midnight. */
const LAST_DATE_ONLY = "9999-12-31";

function isVariableReference(value: string) {
  return VIEWER_VARIABLES.has(value) || value.startsWith("$viewer.");
}

function collectStrings(value: unknown, out: string[], depth = 0) {
  if (depth > 3) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out, depth + 1);
  else if (isRecord(value)) for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
}

function checkVariables(column: BaseCompileColumn, op: BaseFilterOp, value: unknown): Set<ViewerVariable> {
  const strings: string[] = [];
  collectStrings(value, strings);
  const used = new Set<ViewerVariable>();
  for (const text of strings) {
    if (!isVariableReference(text)) continue;
    if (!VIEWER_VARIABLES.has(text)) invalidFilter(`Unknown variable "${clip(text)}".`);
    const variable = text as ViewerVariable;
    if (variable === "$now" || variable === "$today") {
      if (!BASE_TEMPORAL_KINDS.has(column.kind) || !DATE_VALUE_OPS.has(op)) {
        invalidFilter(`${variable} is only allowed as a date value.`);
      }
      continue;
    }
    const typeMatches = column.kind === "email" ? variable === "$viewer.email" : UUID_VARIABLES.has(variable);
    if (!baseViewerVariableAllowed(column.kind, op) || !typeMatches) {
      invalidFilter(`${variable} is not allowed with "${op}" on "${column.key}".`);
    }
    used.add(variable);
  }
  return used;
}

function describe(column: BaseCompileColumn) {
  return `"${column.key}" (${column.kind})`;
}

function requireString(column: BaseCompileColumn, op: BaseFilterOp, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalidFilter(`"${op}" on ${describe(column)} needs a non-empty string.`);
  if (baseUtf8Bytes(value) > BASES_LIMITS.textBytes) invalidFilter(`Filter values are limited to ${BASES_LIMITS.textBytes} bytes.`);
  return value;
}

function requireArray(column: BaseCompileColumn, op: BaseFilterOp, value: unknown, max = FILTER_ARRAY_MAX): unknown[] {
  if (!Array.isArray(value) || value.length === 0) invalidFilter(`"${op}" on ${describe(column)} needs a non-empty array.`);
  if (value.length > max) invalidFilter(`"${op}" takes at most ${max} values.`);
  return value;
}

function requireNumber(column: BaseCompileColumn, op: BaseFilterOp, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidFilter(`"${op}" on ${describe(column)} needs a number.`);
  return value === 0 ? 0 : value;
}

function parseDateOperand(column: BaseCompileColumn, op: BaseFilterOp, value: unknown): DateOperand {
  if (value === "$today" || value === "$now") return value;
  if (typeof value === "string") {
    if (isValidDateOnly(value)) return value;
    const instant = normalizeBaseInstant(value);
    if (instant) return instant;
  }
  invalidFilter(`"${op}" on ${describe(column)} needs YYYY-MM-DD, an ISO-8601 instant, $today, or $now.`);
}

function resolveOptionId(column: BaseCompileColumn, value: unknown): string {
  if (typeof value !== "string" || !value) invalidFilter(`Options of ${describe(column)} are referenced by id or name.`);
  const option = findBaseOption(column.property?.config.options, value);
  if (!option) invalidFilter(`Unknown option "${clip(value)}" for "${column.key}".`);
  return option.id;
}

function statusGroupIds(column: BaseCompileColumn, group: BaseStatusGroup) {
  return (column.property?.config.options ?? []).filter((option) => option.group === group).map((option) => option.id);
}

function requireUserRef(column: BaseCompileColumn, op: BaseFilterOp, value: unknown): string {
  if (typeof value === "string" && UUID_VARIABLES.has(value)) return value;
  if (typeof value !== "string" || !BASE_UUID_PATTERN.test(value)) invalidFilter(`"${op}" on ${describe(column)} needs user ids.`);
  return value.toLowerCase();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function resolveLeaf(leaf: BaseFilterLeaf, ctx: BaseCompileContext): ResolvedLeaf {
  const column = resolveColumn(ctx, leaf.prop);
  const op = leaf.op;
  if (!BASE_OPERATORS_BY_KIND[column.kind]?.includes(op)) invalidFilter(`Operator "${op}" is not valid for ${describe(column)}.`);
  const value = leaf.value;
  const base = { column, op, viewerVariables: new Set<ViewerVariable>() };

  if (BASE_VALUELESS_OPS.has(op)) {
    if (value !== undefined && value !== null) invalidFilter(`"${op}" takes no value.`);
    return { ...base, operand: { t: "none" }, stored: undefined };
  }
  if (value === undefined || value === null) invalidFilter(`"${op}" on ${describe(column)} needs a value.`);
  if (baseHasNul(value)) invalidFilter("Filter values cannot contain NUL (U+0000) characters.");
  const viewerVariables = checkVariables(column, op, value);
  const leafWith = (operand: Operand, stored: unknown): ResolvedLeaf => ({ ...base, viewerVariables, operand, stored });

  switch (column.kind) {
    case "text":
    case "url":
    case "phone": {
      const text = requireString(column, op, value);
      return leafWith({ t: "string", v: text }, text);
    }
    case "email": {
      const text = requireString(column, op, value);
      const normalized = text === "$viewer.email" ? text : text.toLowerCase();
      return leafWith({ t: "string", v: normalized }, normalized);
    }
    case "number": {
      if (op === "between") {
        const range = requireArray(column, op, value, 2);
        if (range.length !== 2) invalidFilter(`"between" takes [min, max].`);
        const low = requireNumber(column, op, range[0]);
        const high = requireNumber(column, op, range[1]);
        if (low > high) invalidFilter(`"between" needs min <= max.`);
        return leafWith({ t: "number_range", v: [low, high] }, [low, high]);
      }
      const number = requireNumber(column, op, value);
      return leafWith({ t: "number", v: number }, number);
    }
    case "checkbox": {
      if (typeof value !== "boolean") invalidFilter(`${describe(column)} compares with true or false.`);
      return leafWith({ t: "bool", v: value }, value);
    }
    case "date":
    case "created_time":
    case "updated_time": {
      if (op === "within") {
        if (!isBaseWithinValue(value)) invalidFilter(`"within" takes today, this_week, this_month, this_year, { past }, or { next }.`);
        const within = typeof value === "string" ? value : { ...value };
        return leafWith({ t: "within", v: within }, within);
      }
      if (op === "between") {
        const range = requireArray(column, op, value, 2);
        if (range.length !== 2) invalidFilter(`"between" takes [start, end].`);
        const start = parseDateOperand(column, op, range[0]);
        const end = parseDateOperand(column, op, range[1]);
        if (!start.startsWith("$") && !end.startsWith("$") && literalRangeIsEmpty(start, end, ctx.timezone)) {
          invalidFilter(`"between" needs start <= end.`);
        }
        return leafWith({ t: "date_range", v: [start, end] }, [start, end]);
      }
      const operand = parseDateOperand(column, op, value);
      return leafWith({ t: "date", v: operand }, operand);
    }
    case "select":
    case "status": {
      if (isRecord(value)) {
        const keys = Object.keys(value);
        const group = value.group;
        if (
          column.kind !== "status" ||
          (op !== "eq" && op !== "neq") ||
          keys.length !== 1 ||
          typeof group !== "string" ||
          !(BASE_STATUS_GROUPS as readonly string[]).includes(group)
        ) {
          invalidFilter(`{ group } values are only valid with eq and neq on status properties.`);
        }
        const statusGroup = group as BaseStatusGroup;
        return leafWith({ t: "group", group: statusGroup, ids: statusGroupIds(column, statusGroup) }, { group: statusGroup });
      }
      if (op === "in" || op === "nin") {
        const ids = uniqueStrings(requireArray(column, op, value).map((item) => resolveOptionId(column, item)));
        return leafWith({ t: "options", v: ids }, ids);
      }
      const id = resolveOptionId(column, value);
      return leafWith({ t: "options", v: [id] }, id);
    }
    case "multi_select": {
      if (op === "contains_any" || op === "contains_all") {
        const ids = uniqueStrings(requireArray(column, op, value).map((item) => resolveOptionId(column, item)));
        return leafWith({ t: "ids", v: ids }, ids);
      }
      const id = resolveOptionId(column, value);
      return leafWith({ t: "ids", v: [id] }, id);
    }
    case "person": {
      if (op === "contains_any" || op === "contains_all") {
        const ids = uniqueStrings(requireArray(column, op, value).map((item) => requireUserRef(column, op, item)));
        return leafWith({ t: "ids", v: ids }, ids);
      }
      const id = requireUserRef(column, op, value);
      return leafWith({ t: "ids", v: [id] }, id);
    }
    case "ref": {
      const ref = normalizeBaseRef(value);
      if (!ref) invalidFilter(`"contains" on ${describe(column)} needs { type, id }.`);
      return leafWith({ t: "ref", v: ref }, ref);
    }
    case "created_by":
    case "updated_by": {
      if (op === "in") {
        const ids = uniqueStrings(requireArray(column, op, value).map((item) => requireUserRef(column, op, item)));
        return leafWith({ t: "ids", v: ids }, ids);
      }
      const id = requireUserRef(column, op, value);
      return leafWith({ t: "ids", v: [id] }, id);
    }
    case "approval":
    case "agent": {
      // state_in: one state or an array of states.
      const allowed: readonly string[] = column.kind === "approval" ? BASE_APPROVAL_STATES : BASE_AGENT_STATES;
      const items = Array.isArray(value) ? requireArray(column, op, value, allowed.length) : [value];
      const states = uniqueStrings(
        items.map((item) => {
          if (typeof item !== "string" || !allowed.includes(item)) {
            invalidFilter(`"state_in" on ${describe(column)} takes ${allowed.join(", ")}.`);
          }
          return item;
        }),
      );
      return leafWith({ t: "options", v: states }, Array.isArray(value) ? states : states[0]);
    }
    default:
      invalidFilter(`${describe(column)} cannot be filtered.`);
  }
}

function literalRangeIsEmpty(start: string, end: string, timezone: string) {
  const startMs = isValidDateOnly(start) ? zonedMidnightUtc(start, timezone).getTime() : Date.parse(start);
  if (isValidDateOnly(end) && end >= LAST_DATE_ONLY) return false;
  const endMs = isValidDateOnly(end)
    ? zonedMidnightUtc(addToDateOnly(end, 1, "d"), timezone).getTime() - 1
    : Date.parse(end);
  return startMs > endMs;
}

function walkLeaves(filter: unknown, visit: (leaf: BaseFilterLeaf) => void) {
  const node = filter as FilterRecord;
  if (Array.isArray(node.and)) node.and.forEach((child) => walkLeaves(child, visit));
  else if (Array.isArray(node.or)) node.or.forEach((child) => walkLeaves(child, visit));
  else if ("not" in node) walkLeaves(node.not, visit);
  else visit(node as unknown as BaseFilterLeaf);
}

function assertTimeZone(ctx: BaseCompileContext) {
  if (!isValidTimeZone(ctx.timezone)) throw new Error("Invalid base timezone.");
}

/**
 * Validates a filter against the base schema: structure, depth, leaves,
 * operators per column kind, value shapes, and `$viewer.*` placement. Throws
 * `ConsoleApiError` (400 `unknown_property` / `invalid_filter`, or 403
 * `base_forbidden` when `$viewer.*` is used without a viewer).
 */
export function validateBaseFilter(
  filter: BaseFilter | null | undefined,
  ctx: BaseCompileContext,
  options: BaseValidateFilterOptions = {},
): void {
  if (filter === null || filter === undefined) return;
  assertTimeZone(ctx);
  checkFilterStructure(filter);
  walkLeaves(filter, (leaf) => {
    const resolved = resolveLeaf(leaf, ctx);
    if (!options.allowMissingViewer) for (const variable of resolved.viewerVariables) resolveViewerVariable(variable, ctx);
  });
}

/**
 * Validates a filter and returns its storage form: props rewritten to column
 * refs (property ids or system names) and option names to option ids.
 * `$viewer.*` references are kept and need no viewer.
 */
export function normalizeBaseFilterForStorage(
  filter: BaseFilter | null | undefined,
  ctx: BaseCompileContext,
): BaseFilter | null {
  if (filter === null || filter === undefined) return null;
  assertTimeZone(ctx);
  checkFilterStructure(filter);
  const rebuild = (node: BaseFilter): BaseFilter => {
    if ("and" in node) return { and: node.and.map(rebuild) };
    if ("or" in node) return { or: node.or.map(rebuild) };
    if ("not" in node) return { not: rebuild(node.not) };
    const resolved = resolveLeaf(node, ctx);
    const leaf: BaseFilterLeaf = { prop: resolved.column.ref, op: resolved.op };
    if (resolved.stored !== undefined) leaf.value = resolved.stored;
    return leaf;
  };
  return rebuild(filter);
}

/** Rewrites stored column refs to API keys; refs without a key are kept as they are. */
export function baseFilterToApi(
  filter: BaseFilter | null | undefined,
  refToKey: (ref: string) => string | null | undefined,
): BaseFilter | null {
  if (filter === null || filter === undefined) return null;
  const rebuild = (node: BaseFilter): BaseFilter => {
    if ("and" in node) return { and: node.and.map(rebuild) };
    if ("or" in node) return { or: node.or.map(rebuild) };
    if ("not" in node) return { not: rebuild(node.not) };
    const leaf: BaseFilterLeaf = { prop: refToKey(node.prop) ?? node.prop, op: node.op };
    if (node.value !== undefined) leaf.value = node.value;
    return leaf;
  };
  return rebuild(filter);
}

/** Column refs (the `prop` of every leaf) used by a filter. */
export function baseFilterColumnRefs(filter: BaseFilter | null | undefined): Set<string> {
  const refs = new Set<string>();
  if (!filter) return refs;
  walkLeaves(filter, (leaf) => {
    if (typeof leaf.prop === "string") refs.add(leaf.prop);
  });
  return refs;
}

// ---------------------------------------------------------------------------
// Leaf SQL

const ISO_MS_FORMAT = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
const ISO_US_FORMAT = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`);

function jsonValue(column: BaseCompileColumn): SQL {
  return sql`(r.values_json -> ${column.ref}::text)`;
}

function textValue(column: BaseCompileColumn): SQL {
  return sql`(r.values_json ->> ${column.ref}::text)`;
}

function numberValue(column: BaseCompileColumn): SQL {
  const value = jsonValue(column);
  return sql`(CASE WHEN jsonb_typeof(${value}) = 'number' THEN (${value})::numeric END)`;
}

function checkboxValue(column: BaseCompileColumn): SQL {
  return sql`COALESCE(${jsonValue(column)} = 'true'::jsonb, false)`;
}

function present(column: BaseCompileColumn): SQL {
  return sql`(${jsonValue(column)} IS NOT NULL)`;
}

function containsJson(column: BaseCompileColumn, elements: SQL[]): SQL {
  return sql`(r.values_json @> jsonb_build_object(${column.ref}::text, jsonb_build_array(${sql.join(elements, sql`, `)})))`;
}

function total(condition: SQL): SQL {
  return sql`COALESCE(${condition}, false)`;
}

function inList(values: string[]): SQL {
  return sql`(${sql.join(
    values.map((value) => sql`${value}::text`),
    sql`, `,
  )})`;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function isInstantColumn(column: BaseCompileColumn) {
  return column.kind === "created_time" || column.kind === "updated_time" || column.property?.config.includeTime === true;
}

function dateText(column: BaseCompileColumn, field: "start" | "end"): SQL {
  const value = jsonValue(column);
  if (field === "start") return sql`((${value} ->> 'start') COLLATE "C")`;
  return sql`(COALESCE(${value} ->> 'end', ${value} ->> 'start') COLLATE "C")`;
}

function instantFromText(text: SQL): SQL {
  return sql`(CASE WHEN ${text} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (${text})::timestamptz END)`;
}

function dateInstant(column: BaseCompileColumn, field: "start" | "end"): SQL {
  if (column.kind === "created_time") return sql`r.created_at`;
  if (column.kind === "updated_time") return sql`r.updated_at`;
  const value = jsonValue(column);
  if (field === "start") return instantFromText(sql`(${value} ->> 'start')`);
  return instantFromText(sql`COALESCE(${value} ->> 'end', ${value} ->> 'start')`);
}

function timestampParam(date: Date | string): SQL {
  return sql`(${typeof date === "string" ? date : date.toISOString()}::text)::timestamptz`;
}

type ResolvedDate = { day: string } | { instant: string };

function resolveDateOperand(operand: DateOperand, ctx: BaseCompileContext): ResolvedDate {
  if (operand === "$today") return { day: localDateString(ctx.now, ctx.timezone) };
  if (operand === "$now") return { instant: ctx.now.toISOString() };
  if (isValidDateOnly(operand)) return { day: operand };
  return { instant: operand };
}

function asDay(date: ResolvedDate, ctx: BaseCompileContext): string {
  return "day" in date ? date.day : localDateString(new Date(date.instant), ctx.timezone);
}

function midnight(day: string, ctx: BaseCompileContext) {
  return zonedMidnightUtc(day, ctx.timezone);
}

/** Start of the next day in the base timezone, or null (+infinity) after 9999-12-31. */
function nextMidnight(day: string, ctx: BaseCompileContext): Date | null {
  if (day >= LAST_DATE_ONLY) return null;
  return zonedMidnightUtc(addToDateOnly(day, 1, "d"), ctx.timezone);
}

const DATE_COMPARATORS: Partial<Record<BaseFilterOp, string>> = {
  eq: "=",
  before: "<",
  after: ">",
  on_or_before: "<=",
  on_or_after: ">=",
};

function dateLeafSql(resolved: ResolvedLeaf, ctx: BaseCompileContext): SQL {
  const { column, op, operand } = resolved;
  const instants = isInstantColumn(column);

  if (operand.t === "within" || operand.t === "date_range") {
    let lower: ResolvedDate;
    let upper: ResolvedDate;
    if (operand.t === "within") {
      const range = baseWithinRange(operand.v, ctx.now, ctx.timezone);
      lower = { day: range.startDate };
      upper = { day: addToDateOnly(range.endDateExclusive, -1, "d") };
    } else {
      lower = resolveDateOperand(operand.v[0], ctx);
      upper = resolveDateOperand(operand.v[1], ctx);
    }
    if (!instants) {
      const low = asDay(lower, ctx);
      const high = asDay(upper, ctx);
      if (low > high) return sql`FALSE`;
      return total(sql`${dateText(column, "start")} <= ${high}::text AND ${dateText(column, "end")} >= ${low}::text`);
    }
    const lowMs = "day" in lower ? midnight(lower.day, ctx).getTime() : Date.parse(lower.instant);
    const highExclusive = "day" in upper;
    const highMs = "day" in upper ? (nextMidnight(upper.day, ctx)?.getTime() ?? Infinity) : Date.parse(upper.instant);
    if (highExclusive ? lowMs >= highMs : lowMs > highMs) return sql`FALSE`;
    const start = dateInstant(column, "start");
    const end = dateInstant(column, "end");
    const highSql = timestampParam(Number.isFinite(highMs) ? new Date(highMs).toISOString() : "infinity");
    return total(
      sql`${start} ${sql.raw(highExclusive ? "<" : "<=")} ${highSql} AND ${end} >= ${timestampParam(new Date(lowMs).toISOString())}`,
    );
  }

  if (operand.t !== "date") throw new Error("Unexpected date operand.");
  const date = resolveDateOperand(operand.v, ctx);

  if (!instants) {
    const day = asDay(date, ctx);
    const comparator = DATE_COMPARATORS[op];
    if (!comparator) throw new Error(`Unexpected date operator ${op}.`);
    return total(sql`${dateText(column, "start")} ${sql.raw(comparator)} ${day}::text`);
  }

  const start = dateInstant(column, "start");
  if ("instant" in date) {
    const comparator = DATE_COMPARATORS[op];
    if (!comparator) throw new Error(`Unexpected date operator ${op}.`);
    return total(sql`${start} ${sql.raw(comparator)} ${timestampParam(date.instant)}`);
  }
  const dayStart = timestampParam(midnight(date.day, ctx));
  const dayEnd = timestampParam(nextMidnight(date.day, ctx) ?? "infinity");
  switch (op) {
    case "eq":
      return total(sql`${start} >= ${dayStart} AND ${start} < ${dayEnd}`);
    case "before":
      return total(sql`${start} < ${dayStart}`);
    case "after":
      return total(sql`${start} >= ${dayEnd}`);
    case "on_or_before":
      return total(sql`${start} < ${dayEnd}`);
    case "on_or_after":
      return total(sql`${start} >= ${dayStart}`);
    default:
      throw new Error(`Unexpected date operator ${op}.`);
  }
}

function resolveViewerVariable(variable: string, ctx: BaseCompileContext): string {
  if (!ctx.viewer) viewerRequired();
  switch (variable) {
    case "$viewer.raviUserId":
      return ctx.viewer.raviUserId.toLowerCase();
    case "$viewer.raviOrgId":
      return ctx.viewer.raviOrgId.toLowerCase();
    case "$viewer.email":
      if (!ctx.viewer.email) viewerRequired();
      return ctx.viewer.email.toLowerCase();
    default:
      return invalidFilter(`Unknown variable "${clip(variable)}".`);
  }
}

function bindString(value: string, ctx: BaseCompileContext): string {
  return value.startsWith("$viewer.") ? resolveViewerVariable(value, ctx) : value;
}

const NUMBER_COMPARATORS: Partial<Record<BaseFilterOp, string>> = {
  eq: "=",
  neq: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

/** An agent cell is empty when it holds no value (a pending first fill, or an error with no prior value). */
function agentValuePresent(column: BaseCompileColumn): SQL {
  const inner = sql`(${jsonValue(column)} -> 'value')`;
  return total(sql`${inner} IS NOT NULL AND ${inner} <> 'null'::jsonb`);
}

function leafSql(resolved: ResolvedLeaf, ctx: BaseCompileContext): SQL {
  const { column, op, operand } = resolved;

  if (column.kind === "agent" && (op === "is_empty" || op === "is_not_empty")) {
    return op === "is_empty" ? sql`(NOT ${agentValuePresent(column)})` : agentValuePresent(column);
  }
  if (op === "is_empty") return sql`(${jsonValue(column)} IS NULL)`;
  if (op === "is_not_empty") return present(column);

  switch (column.kind) {
    case "text":
    case "url":
    case "phone":
    case "email": {
      if (operand.t !== "string") break;
      const value = bindString(operand.v, ctx);
      const text = textValue(column);
      if (op === "eq" || op === "neq") {
        const comparator = sql.raw(op === "eq" ? "=" : "<>");
        if (column.kind === "email") return total(sql`lower(${text}) ${comparator} ${value.toLowerCase()}::text`);
        return total(sql`${text} ${comparator} ${value}::text`);
      }
      const pattern = op === "starts_with" ? `${escapeLike(value)}%` : `%${escapeLike(value)}%`;
      const like = total(sql`${text} ILIKE ${pattern}::text ESCAPE E'\\\\'`);
      if (op === "contains" || op === "starts_with") return like;
      if (op === "not_contains") return sql`(${present(column)} AND NOT ${like})`;
      break;
    }
    case "number": {
      const value = numberValue(column);
      if (operand.t === "number_range") {
        return total(sql`${value} BETWEEN (${String(operand.v[0])}::text)::numeric AND (${String(operand.v[1])}::text)::numeric`);
      }
      const comparator = NUMBER_COMPARATORS[op];
      if (operand.t !== "number" || !comparator) break;
      return total(sql`${value} ${sql.raw(comparator)} (${String(operand.v)}::text)::numeric`);
    }
    case "checkbox":
      if (operand.t !== "bool") break;
      return operand.v ? checkboxValue(column) : sql`(NOT ${checkboxValue(column)})`;
    case "date":
    case "created_time":
    case "updated_time":
      return dateLeafSql(resolved, ctx);
    case "select":
    case "status": {
      const text = textValue(column);
      if (operand.t === "group") {
        if (op === "eq") return operand.ids.length ? total(sql`${text} IN ${inList(operand.ids)}`) : sql`FALSE`;
        return operand.ids.length ? total(sql`${text} NOT IN ${inList(operand.ids)}`) : present(column);
      }
      if (operand.t !== "options") break;
      if (op === "eq" || op === "neq") {
        const [id] = operand.v;
        return total(sql`${text} ${sql.raw(op === "eq" ? "=" : "<>")} ${id}::text`);
      }
      if (op === "in") return total(sql`${text} IN ${inList(operand.v)}`);
      if (op === "nin") return total(sql`${text} NOT IN ${inList(operand.v)}`);
      break;
    }
    case "multi_select":
    case "person": {
      if (operand.t !== "ids") break;
      const ids = operand.v.map((value) => bindString(value, ctx));
      const element = (id: string) => sql`${id}::text`;
      if (op === "contains") return containsJson(column, [element(ids[0] as string)]);
      if (op === "not_contains") return sql`(${present(column)} AND NOT ${containsJson(column, [element(ids[0] as string)])})`;
      if (op === "contains_all") return containsJson(column, ids.map(element));
      if (op === "contains_any") return sql`(${sql.join(ids.map((id) => containsJson(column, [element(id)])), sql` OR `)})`;
      break;
    }
    case "ref":
      if (operand.t !== "ref" || op !== "contains") break;
      return containsJson(column, [sql`jsonb_build_object('type', ${operand.v.type}::text, 'id', ${operand.v.id}::text)`]);
    case "approval":
    case "agent":
      if (operand.t !== "options" || op !== "state_in") break;
      return total(sql`(${jsonValue(column)} ->> 'state') IN ${inList(operand.v)}`);
    case "created_by":
    case "updated_by": {
      if (operand.t !== "ids") break;
      const actor = sql.raw(column.kind === "created_by" ? "r.created_by_actor_id" : "r.updated_by_actor_id");
      const ids = uniqueStrings(operand.v.map((value) => bindString(value, ctx)));
      if (op === "eq") return total(sql`${actor} = ${ids[0]}::text`);
      if (op === "neq") return total(sql`${actor} <> ${ids[0]}::text`);
      if (op === "in") return total(sql`${actor} IN ${inList(ids)}`);
      break;
    }
  }
  throw new Error(`Unhandled filter ${column.kind}.${op}.`);
}

/**
 * Compiles a filter to a boolean SQL expression over `base_rows AS r`.
 * Null or undefined compiles to TRUE. Every leaf is total (never NULL), so
 * `not` is an exact complement. Validates like `validateBaseFilter`.
 */
export function compileBaseFilter(filter: BaseFilter | null | undefined, ctx: BaseCompileContext): SQL {
  if (filter === null || filter === undefined) return sql`TRUE`;
  assertTimeZone(ctx);
  checkFilterStructure(filter);
  const compile = (node: BaseFilter): SQL => {
    if ("and" in node) return sql`(${sql.join(node.and.map(compile), sql` AND `)})`;
    if ("or" in node) return sql`(${sql.join(node.or.map(compile), sql` OR `)})`;
    if ("not" in node) return sql`(NOT ${compile(node.not)})`;
    return leafSql(resolveLeaf(node, ctx), ctx);
  };
  return compile(filter);
}

// ---------------------------------------------------------------------------
// Sort and keyset pagination

/** Text sort keys compare this many leading characters so cursors stay small. */
const TEXT_SORT_PREFIX_CHARS = 128;

function timestampText(expr: SQL, format: SQL = ISO_US_FORMAT): SQL {
  return sql`to_char((${expr}) AT TIME ZONE 'UTC', ${format})`;
}

function optionOrdinal(column: BaseCompileColumn): SQL {
  const options = column.property?.config.options ?? [];
  const ordered =
    column.kind === "status"
      ? options
          .map((option, index) => ({ option, index }))
          .sort((a, b) => {
            const groupA = BASE_STATUS_GROUPS.indexOf(a.option.group ?? "todo");
            const groupB = BASE_STATUS_GROUPS.indexOf(b.option.group ?? "todo");
            return groupA - groupB || a.index - b.index;
          })
          .map(({ option }) => option)
      : options;
  const text = textValue(column);
  if (!ordered.length) return sql`(CASE WHEN ${text} IS NULL THEN NULL ELSE 0 END)`;
  const branches = ordered.map((option, index) => sql`WHEN ${option.id}::text THEN ${sql.raw(String(index))}`);
  return sql`(CASE WHEN ${text} IS NULL THEN NULL ELSE (CASE ${text} ${sql.join(branches, sql` `)} ELSE ${sql.raw(String(ordered.length))} END) END)`;
}

function sortKeyFor(column: BaseCompileColumn, dir: BaseSortDirection): BaseSortKey {
  switch (column.kind) {
    case "text":
    case "url":
    case "email":
    case "phone": {
      const expr = sql`left(${textValue(column)}, ${sql.raw(String(TEXT_SORT_PREFIX_CHARS))})`;
      return { column, dir, expr, select: expr, type: "text", nullable: true };
    }
    case "number": {
      const expr = numberValue(column);
      return { column, dir, expr, select: sql`(${expr})::text`, type: "numeric", nullable: true };
    }
    case "checkbox": {
      const expr = checkboxValue(column);
      return { column, dir, expr, select: sql`(${expr})::text`, type: "boolean", nullable: false };
    }
    case "date": {
      if (isInstantColumn(column)) {
        const expr = dateInstant(column, "start");
        return { column, dir, expr, select: timestampText(expr), type: "timestamptz", nullable: true };
      }
      const expr = dateText(column, "start");
      return { column, dir, expr, select: expr, type: "text", nullable: true };
    }
    case "select":
    case "status": {
      const expr = optionOrdinal(column);
      return { column, dir, expr, select: sql`(${expr})::text`, type: "integer", nullable: true };
    }
    case "created_time":
    case "updated_time": {
      const expr = sql.raw(column.kind === "created_time" ? "r.created_at" : "r.updated_at");
      return { column, dir, expr, select: timestampText(expr), type: "timestamptz", nullable: false };
    }
    default:
      return invalidFilter(`${describe(column)} cannot be sorted.`);
  }
}

/**
 * Compiles up to 3 sort keys (sortable kinds only; select/status by option
 * order, status by group first) with empties last in both directions, then
 * the tie-breakers `r.created_at ASC, r.id ASC`. Empty sort is created_time asc.
 */
export function compileBaseSort(sort: readonly BaseSort[] | null | undefined, ctx: BaseCompileContext): BaseCompiledSort {
  const entries = sort ?? [];
  if (!Array.isArray(entries)) invalidFilter("Sort must be an array.");
  if (entries.length > BASES_LIMITS.sortKeys) invalidFilter(`Sort takes at most ${BASES_LIMITS.sortKeys} keys.`);
  const keys: BaseSortKey[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) invalidFilter("Sort entries are { prop, dir }.");
    const column = resolveColumn(ctx, entry.prop);
    const dir = entry.dir ?? "asc";
    if (dir !== "asc" && dir !== "desc") invalidFilter(`Sort direction must be asc or desc.`);
    if (!BASE_SORTABLE_KINDS.has(column.kind)) invalidFilter(`${describe(column)} cannot be sorted.`);
    keys.push(sortKeyFor(column, dir));
  }
  if (!keys.some((key) => key.column?.kind === "created_time")) {
    const createdAt = sql.raw("r.created_at");
    keys.push({ column: null, dir: "asc", expr: createdAt, select: timestampText(createdAt), type: "timestamptz", nullable: false });
  }
  const id = sql.raw("r.id");
  keys.push({ column: null, dir: "asc", expr: id, select: sql`(${id})::text`, type: "uuid", nullable: false });
  const orderBy = sql.join(
    keys.map((key) => sql`${key.expr} ${sql.raw(key.dir === "desc" ? "DESC" : "ASC")} NULLS LAST`),
    sql`, `,
  );
  return { orderBy, keys };
}

const CURSOR_VALUE_PATTERNS: Record<BaseSortKeyType, RegExp> = {
  text: /^[\s\S]{0,1024}$/,
  numeric: /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/,
  timestamptz: /^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
  integer: /^-?\d{1,9}$/,
  boolean: /^(?:true|false)$/,
  uuid: BASE_UUID_PATTERN,
};

function cursorParam(key: BaseSortKey, value: unknown): SQL {
  if (typeof value !== "string" || !CURSOR_VALUE_PATTERNS[key.type].test(value)) cursorInvalid();
  // Bound as text: driver serializers for typed params (bool, timestamptz) would rewrite the string.
  return sql`(${value}::text)::${sql.raw(key.type)}`;
}

/**
 * Keyset predicate selecting rows strictly after the cursor row in the
 * ORDER BY of `keys` (empties last, then the tie-breakers). `cursorValues`
 * are the `__s<i>` strings (or null) of that row. Throws `cursor_invalid`.
 */
export function compileBaseKeysetPredicate(keys: readonly BaseSortKey[], cursorValues: readonly unknown[]): SQL {
  if (!Array.isArray(cursorValues) || cursorValues.length !== keys.length || keys.length === 0) cursorInvalid();
  let predicate: SQL | null = null;
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index] as BaseSortKey;
    const raw = cursorValues[index];
    if (raw === null || raw === undefined) {
      if (!key.nullable) cursorInvalid();
      // Nothing sorts after an empty value except rows tied on it.
      predicate = predicate ? sql`((${key.expr}) IS NULL AND ${predicate})` : sql`FALSE`;
      continue;
    }
    const value = cursorParam(key, raw);
    const after = sql`(${key.expr}) ${sql.raw(key.dir === "desc" ? "<" : ">")} ${value}`;
    const strictlyAfter = key.nullable ? sql`(${after} OR (${key.expr}) IS NULL)` : sql`(${after})`;
    predicate = predicate ? sql`(${strictlyAfter} OR ((${key.expr}) = ${value} AND ${predicate}))` : strictlyAfter;
  }
  return sql`COALESCE(${predicate}, false)`;
}

// ---------------------------------------------------------------------------
// Row queries

function assertUuid(value: string, name: string) {
  if (typeof value !== "string" || !BASE_UUID_PATTERN.test(value)) throw new Error(`Invalid ${name}.`);
}

/**
 * Page query over `base_rows AS r`, scoped by organization and base, ordered
 * by `sort`, returning `limit + 1` rows (services detect `hasMore`) with the
 * `__s<i>` cursor columns. See `BaseRowsQueryRow`.
 */
export function buildBaseRowsQuery(input: BaseRowsQueryInput): SQL {
  assertUuid(input.organizationId, "organization id");
  assertUuid(input.baseId, "base id");
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > BASES_LIMITS.queryLimitMax) {
    throw new ConsoleApiError(400, { error: "payload_invalid", reason: `limit must be 1-${BASES_LIMITS.queryLimitMax}.` });
  }
  const conditions = [sql`r.organization_id = ${input.organizationId}::uuid`, sql`r.base_id = ${input.baseId}::uuid`];
  if (!input.includeArchived) conditions.push(sql`r.archived_at IS NULL`);
  conditions.push(sql`(${input.filterSql})`);
  if (input.cursorValues) conditions.push(compileBaseKeysetPredicate(input.sort.keys, input.cursorValues));
  const sortColumns = input.sort.keys.map((key, index) => sql`, ${key.select} AS ${sql.raw(`"__s${index}"`)}`);
  return sql`SELECT r.id::text AS id, r.version, r.values_json, ${input.includeBody ? sql`r.body` : sql`NULL::text`} AS body, ${timestampText(sql.raw("r.archived_at"), ISO_MS_FORMAT)} AS archived_at, ${timestampText(sql.raw("r.created_at"), ISO_MS_FORMAT)} AS created_at, ${timestampText(sql.raw("r.updated_at"), ISO_MS_FORMAT)} AS updated_at, r.created_by_actor_id, r.updated_by_actor_id${sql.join(sortColumns, sql``)} FROM base_rows AS r WHERE ${sql.join(conditions, sql` AND `)} ORDER BY ${input.sort.orderBy} LIMIT ${sql.raw(String(input.limit + 1))}`;
}

/**
 * Returns `{ id, version }` for the row when it is active, in the base, and
 * matches `filterSql`; no rows otherwise (including a malformed row id).
 */
export function buildBaseRowMatchQuery(input: BaseRowMatchQueryInput): SQL {
  assertUuid(input.organizationId, "organization id");
  assertUuid(input.baseId, "base id");
  if (typeof input.rowId !== "string" || !BASE_UUID_PATTERN.test(input.rowId)) {
    return sql`SELECT NULL::text AS id, NULL::integer AS version WHERE FALSE`;
  }
  return sql`SELECT r.id::text AS id, r.version FROM base_rows AS r WHERE r.organization_id = ${input.organizationId}::uuid AND r.base_id = ${input.baseId}::uuid AND r.id = ${input.rowId}::uuid AND r.archived_at IS NULL AND (${input.filterSql}) LIMIT 1`;
}

// ---------------------------------------------------------------------------
// Search

/** Column kinds a free-text `search` reads: text-like values, and option names. */
export const BASE_SEARCH_KINDS: ReadonlySet<string> = new Set(["text", "url", "email", "phone", "select", "status", "multi_select"]);

function folded(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

/**
 * `search`: OR of case-insensitive contains over the given columns (text,
 * url, email, phone values; select, status, multi_select option names, matched
 * here and bound as option ids). No searchable column, or no match anywhere,
 * compiles to FALSE.
 */
export function compileBaseSearch(term: string, columns: readonly BaseCompileColumn[]): SQL {
  const needle = term.trim();
  if (!needle) return sql`TRUE`;
  const pattern = `%${escapeLike(needle)}%`;
  const lowered = folded(needle);
  const parts: SQL[] = [];
  for (const column of columns) {
    if (!BASE_SEARCH_KINDS.has(column.kind) || !column.property || column.property.deletedAt) continue;
    if (column.kind === "select" || column.kind === "status" || column.kind === "multi_select") {
      const ids = (column.property.config.options ?? []).filter((option) => folded(option.name).includes(lowered)).map((option) => option.id);
      if (!ids.length) continue;
      if (column.kind === "multi_select") {
        parts.push(sql`(${sql.join(ids.map((id) => containsJson(column, [sql`${id}::text`])), sql` OR `)})`);
      } else {
        parts.push(total(sql`${textValue(column)} IN ${inList(ids)}`));
      }
      continue;
    }
    parts.push(total(sql`${textValue(column)} ILIKE ${pattern}::text ESCAPE E'\\\\'`));
  }
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`FALSE`;
}

// ---------------------------------------------------------------------------
// Aggregation

const TIME_UNITS: ReadonlySet<string> = new Set(BASE_TIME_UNITS);
const AGGREGATE_OPS: ReadonlySet<string> = new Set(BASE_AGGREGATE_OPS);
const MEASURE_ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

function bucketText(timestamp: SQL, unit: BaseTimeUnit): SQL {
  return sql`to_char(date_trunc(${sql.raw(`'${unit}'`)}, ${timestamp}), 'YYYY-MM-DD')`;
}

function dimensionExpr(dimension: BaseAggregateDimension, index: number, ctx: BaseCompileContext): { expr: SQL; join: SQL | null } {
  const { column, timeUnit } = dimension;
  switch (column.kind) {
    case "select":
    case "status":
      return { expr: textValue(column), join: null };
    case "checkbox":
      return { expr: checkboxValue(column), join: null };
    case "number":
      return { expr: sql`(${numberValue(column)})::float8`, join: null };
    case "multi_select":
    case "person": {
      const alias = sql.raw(`d${index}`);
      const value = jsonValue(column);
      return {
        expr: sql`${alias}.v`,
        join: sql` LEFT JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END) AS ${alias}(v) ON true`,
      };
    }
    case "created_by":
      return { expr: sql.raw("r.created_by_actor_id"), join: null };
    case "updated_by":
      return { expr: sql.raw("r.updated_by_actor_id"), join: null };
    case "approval":
      return { expr: sql`(${jsonValue(column)} ->> 'state')`, join: null };
    case "date":
    case "created_time":
    case "updated_time": {
      const unit = timeUnit as BaseTimeUnit;
      if (!isInstantColumn(column)) {
        const start = sql`(${jsonValue(column)} ->> 'start')`;
        const day = sql`(CASE WHEN ${start} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (${start})::date END)`;
        return { expr: bucketText(sql`(${day})::timestamp`, unit), join: null };
      }
      return { expr: bucketText(sql`(${dateInstant(column, "start")}) AT TIME ZONE ${ctx.timezone}::text`, unit), join: null };
    }
    default:
      return invalidFilter(`${describe(column)} cannot be grouped.`);
  }
}

function measureSql(measure: BaseAggregateMeasure, index: number): { input: SQL | null; output: SQL } {
  const alias = sql.raw(`a${index}`);
  const { column, op } = measure;
  if (op === "count" || !column) return { input: null, output: sql`count(*)::int` };
  if (op === "count_values") {
    const input =
      column.kind === "checkbox" ? sql`CASE WHEN ${checkboxValue(column)} THEN 1 END` : sql`CASE WHEN ${present(column)} THEN 1 END`;
    return { input, output: sql`count(${alias})::int` };
  }
  if (column.kind === "number") {
    return { input: numberValue(column), output: sql`(${sql.raw(op)}(${alias}))::float8` };
  }
  if (isInstantColumn(column)) {
    return { input: dateInstant(column, "start"), output: timestampText(sql`${sql.raw(op)}(${alias})`, ISO_MS_FORMAT) };
  }
  return { input: dateText(column, "start"), output: sql`${sql.raw(op)}(${alias} COLLATE "C")` };
}

/**
 * Compiles an aggregation over active rows of the base, ANDing the request
 * filter with `policyFilterSql`. At most 2 group-by dimensions (multi_select
 * and person expand one group per element; temporal columns bucket by
 * `timeUnit` in the base timezone as `YYYY-MM-DD`, weeks starting Monday),
 * ordered by group keys, limited to 5,001 groups so services can raise
 * `aggregate_too_large`.
 */
export function compileBaseAggregate(
  request: BaseAggregateRequest,
  ctx: BaseCompileContext,
  options: { organizationId: string; policyFilterSql?: SQL | null },
): BaseCompiledAggregate {
  assertUuid(options.organizationId, "organization id");
  assertUuid(ctx.baseId, "base id");
  assertTimeZone(ctx);
  if (!isRecord(request)) invalidFilter("Aggregations are objects.");

  const groupBy = request.groupBy ?? [];
  if (!Array.isArray(groupBy)) invalidFilter("groupBy must be an array.");
  if (groupBy.length > BASES_LIMITS.groupByDimensions) {
    invalidFilter(`Group by at most ${BASES_LIMITS.groupByDimensions} columns.`);
  }
  const dimensions: BaseAggregateDimension[] = [];
  for (const entry of groupBy) {
    if (!isRecord(entry)) invalidFilter("groupBy entries are { prop, timeUnit? }.");
    const column = resolveColumn(ctx, entry.prop);
    if (!BASE_GROUPABLE_KINDS.has(column.kind)) invalidFilter(`${describe(column)} cannot be grouped.`);
    if (dimensions.some((dimension) => dimension.column.ref === column.ref)) {
      invalidFilter(`"${column.key}" is grouped twice.`);
    }
    const timeUnit = entry.timeUnit;
    if (BASE_TEMPORAL_KINDS.has(column.kind)) {
      if (typeof timeUnit !== "string" || !TIME_UNITS.has(timeUnit)) {
        invalidFilter(`Grouping by ${describe(column)} needs a timeUnit (day, week, month, quarter, year).`);
      }
      dimensions.push({ key: column.key, column, timeUnit: timeUnit as BaseTimeUnit });
    } else {
      if (timeUnit !== undefined) invalidFilter(`timeUnit only applies to date columns.`);
      dimensions.push({ key: column.key, column });
    }
  }

  const aggregate = request.aggregate;
  if (!Array.isArray(aggregate) || aggregate.length < 1 || aggregate.length > BASES_LIMITS.aggregateMeasures) {
    invalidFilter(`Aggregations take 1-${BASES_LIMITS.aggregateMeasures} measures.`);
  }
  const measures: BaseAggregateMeasure[] = [];
  for (const entry of aggregate) {
    if (!isRecord(entry)) invalidFilter("Measures are { op, prop?, as }.");
    const { op, prop, as } = entry;
    if (typeof as !== "string" || !MEASURE_ALIAS_PATTERN.test(as)) invalidFilter("Measure names (as) are identifiers.");
    if (measures.some((measure) => measure.as === as)) invalidFilter(`Measure "${as}" is defined twice.`);
    if (typeof op !== "string" || !AGGREGATE_OPS.has(op)) invalidFilter(`Unknown aggregate "${clip(op)}".`);
    const aggregateOp = op as BaseAggregateOp;
    if (aggregateOp === "count") {
      if (prop !== undefined) invalidFilter(`"count" takes no prop.`);
      measures.push({ as, op: aggregateOp, column: null });
      continue;
    }
    if (prop === undefined) invalidFilter(`"${aggregateOp}" needs a prop.`);
    const column = resolveColumn(ctx, prop);
    if (!BASE_AGGREGATE_OPS_BY_KIND[column.kind]?.includes(aggregateOp)) {
      invalidFilter(`"${aggregateOp}" is not valid for ${describe(column)}.`);
    }
    measures.push({ as, op: aggregateOp, column });
  }

  const filterSql = compileBaseFilter(request.filter ?? null, ctx);
  const conditions = [
    sql`r.organization_id = ${options.organizationId}::uuid`,
    sql`r.base_id = ${ctx.baseId}::uuid`,
    sql`r.archived_at IS NULL`,
    sql`(${filterSql})`,
  ];
  if (options.policyFilterSql) conditions.push(sql`(${options.policyFilterSql})`);

  const innerColumns: SQL[] = [sql`1 AS __one`];
  const joins: SQL[] = [];
  dimensions.forEach((dimension, index) => {
    const { expr, join } = dimensionExpr(dimension, index, ctx);
    innerColumns.push(sql`${expr} AS ${sql.raw(`g${index}`)}`);
    if (join) joins.push(join);
  });
  const outerColumns: SQL[] = dimensions.map((_, index) => sql.raw(`t.g${index}`));
  measures.forEach((measure, index) => {
    const { input, output } = measureSql(measure, index);
    if (input) innerColumns.push(sql`${input} AS ${sql.raw(`a${index}`)}`);
    outerColumns.push(sql`${output} AS ${sql.raw(`"m_${measure.as}"`)}`);
  });
  outerColumns.push(sql`count(*)::int AS __count`);

  const inner = sql`SELECT ${sql.join(innerColumns, sql`, `)} FROM base_rows AS r${sql.join(joins, sql``)} WHERE ${sql.join(conditions, sql` AND `)}`;
  const groupColumns = dimensions.map((_, index) => sql.raw(`t.g${index}`));
  const grouping = groupColumns.length
    ? sql` GROUP BY ${sql.join(groupColumns, sql`, `)} ORDER BY ${sql.join(
        groupColumns.map((column) => sql`${column} ASC NULLS LAST`),
        sql`, `,
      )}`
    : sql``;
  const query = sql`SELECT ${sql.join(outerColumns, sql`, `)} FROM (${inner}) AS t${grouping} LIMIT ${sql.raw(String(BASES_LIMITS.aggregateGroups + 1))}`;
  return { query, dimensions, measures };
}

// ---------------------------------------------------------------------------
// Hashing

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** SHA-256 (base64url) of the stable-key JSON of `parts`, for binding cursors to a query. */
export function baseQueryHash(parts: unknown): string {
  return createHash("sha256").update(stableStringify(parts)).digest("base64url");
}
