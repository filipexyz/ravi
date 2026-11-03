// Operator and capability tables for the Bases Query AST. Shared by the server
// compiler (authoritative) and the Console filter builder (hints only).

import type {
  BaseAggregateOp,
  BaseFilterOp,
  BasePropertyType,
  BaseSystemColumn,
} from "./types";

/** A filterable column kind: a property type or a system column. */
export type BaseColumnKind = BasePropertyType | BaseSystemColumn;

const TEXT_OPS = ["eq", "neq", "contains", "not_contains", "starts_with", "is_empty", "is_not_empty"] as const;
const DATE_OPS = [
  "eq",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "between",
  "within",
  "is_empty",
  "is_not_empty",
] as const;
const ARRAY_OPS = ["contains", "not_contains", "contains_any", "contains_all", "is_empty", "is_not_empty"] as const;

export const BASE_OPERATORS_BY_KIND: Record<BaseColumnKind, readonly BaseFilterOp[]> = {
  text: TEXT_OPS,
  url: TEXT_OPS,
  phone: TEXT_OPS,
  email: TEXT_OPS,
  number: ["eq", "neq", "lt", "lte", "gt", "gte", "between", "is_empty", "is_not_empty"],
  checkbox: ["eq"],
  date: DATE_OPS,
  created_time: DATE_OPS.filter((op) => op !== "is_empty" && op !== "is_not_empty"),
  updated_time: DATE_OPS.filter((op) => op !== "is_empty" && op !== "is_not_empty"),
  select: ["eq", "neq", "in", "nin", "is_empty", "is_not_empty"],
  status: ["eq", "neq", "in", "nin", "is_empty", "is_not_empty"],
  multi_select: ARRAY_OPS,
  person: ARRAY_OPS,
  ref: ["contains", "is_empty", "is_not_empty"],
  approval: ["state_in", "is_empty", "is_not_empty"],
  agent: ["state_in", "is_empty", "is_not_empty"],
  created_by: ["eq", "neq", "in"],
  updated_by: ["eq", "neq", "in"],
};

/** Operators that take no `value`. */
export const BASE_VALUELESS_OPS: ReadonlySet<BaseFilterOp> = new Set(["is_empty", "is_not_empty"]);

/**
 * Where `$viewer.*` variables may appear: column kind -> operators.
 * `$now` and `$today` are allowed wherever a date value is.
 */
export const BASE_VIEWER_VARIABLE_OPS: Partial<Record<BaseColumnKind, readonly BaseFilterOp[]>> = {
  person: ["contains", "not_contains"],
  email: ["eq", "neq"],
  created_by: ["eq", "neq", "in"],
  updated_by: ["eq", "neq", "in"],
};

export const BASE_SORTABLE_KINDS: ReadonlySet<BaseColumnKind> = new Set([
  "text",
  "url",
  "email",
  "phone",
  "number",
  "checkbox",
  "date",
  "select",
  "status",
  "created_time",
  "updated_time",
]);

export const BASE_GROUPABLE_KINDS: ReadonlySet<BaseColumnKind> = new Set([
  "select",
  "status",
  "multi_select",
  "checkbox",
  "person",
  "created_by",
  "updated_by",
  "date",
  "created_time",
  "updated_time",
  "number",
  "approval",
]);

/** Kinds that require `timeUnit` when grouped. */
export const BASE_TEMPORAL_KINDS: ReadonlySet<BaseColumnKind> = new Set(["date", "created_time", "updated_time"]);

export const BASE_AGGREGATE_OPS_BY_KIND: Partial<Record<BaseColumnKind, readonly BaseAggregateOp[]>> = {
  number: ["count_values", "sum", "avg", "min", "max"],
  date: ["count_values", "min", "max"],
  created_time: ["min", "max"],
  updated_time: ["min", "max"],
  text: ["count_values"],
  url: ["count_values"],
  email: ["count_values"],
  phone: ["count_values"],
  select: ["count_values"],
  status: ["count_values"],
  multi_select: ["count_values"],
  person: ["count_values"],
  ref: ["count_values"],
  checkbox: ["count_values"],
  approval: ["count_values"],
};

/** Board layouts group by these kinds. */
export const BASE_BOARD_GROUP_KINDS: ReadonlySet<BaseColumnKind> = new Set(["select", "status"]);

export function baseOperatorsForKind(kind: BaseColumnKind): readonly BaseFilterOp[] {
  return BASE_OPERATORS_BY_KIND[kind] ?? [];
}

export function baseOperatorAllowed(kind: BaseColumnKind, op: BaseFilterOp) {
  return baseOperatorsForKind(kind).includes(op);
}

export function baseViewerVariableAllowed(kind: BaseColumnKind, op: BaseFilterOp) {
  return (BASE_VIEWER_VARIABLE_OPS[kind] ?? []).includes(op);
}

export function isBaseSystemColumn(value: string): value is BaseSystemColumn {
  return value === "created_time" || value === "created_by" || value === "updated_time" || value === "updated_by";
}
