// The `where` and `sort` attributes of `<ravi-view>` as Bases Query AST.
//
// `where`: `key<op>value` pairs separated by `;`, all ANDed with the view's
// own filter. Operators: `=` (`eq`; `contains` for multi_select and person;
// `state_in` for approval and agent), `!=` (`neq`, `not_contains`, or a
// `not`), `>` `>=` `<` `<=` (numbers; dates as after, on or after, before, on
// or before) and `~` (contains, for text-like columns, multi_select and
// person). Values: text; numbers; `true`/`false`; option names or ids;
// `YYYY-MM-DD`; `@me` (person, created_by, updated_by: the viewer's id;
// email: the viewer's e-mail); `@today`/`@now` (dates);
// `@todo|@in_progress|@done` (status group). An empty value (`key=`) is
// `is_empty` (`key!=` is `is_not_empty`). Keys must be columns the view
// projects; an operator the column cannot take is `invalid_filter`.
//
// `sort`: `key,-key2` (minus for descending), at most 3 keys.

import type { BaseFilter, BaseFilterLeaf, BaseSort, BaseViewColumn } from "@/shared/bases/types";

import { RaviError } from "./errors";

const MAX_SORT_KEYS = 3;
const GROUPS = new Set(["@todo", "@in_progress", "@done"]);

export function parseSort(text: string | null | undefined): BaseSort[] | undefined {
  if (!text?.trim()) return undefined;
  const sort = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, MAX_SORT_KEYS)
    .map((part): BaseSort => (part.startsWith("-") ? { prop: part.slice(1).trim(), dir: "desc" } : { prop: part, dir: "asc" }));
  return sort.length ? sort : undefined;
}

function leafFor(column: BaseViewColumn, raw: string): BaseFilterLeaf {
  const prop = column.key;
  const value = raw.trim();
  if (!value) return { prop, op: "is_empty" };
  switch (column.type) {
    case "number": {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new RaviError("invalid_filter");
      return { prop, op: "eq", value: number };
    }
    case "checkbox":
      return { prop, op: "eq", value: value === "true" };
    case "date":
    case "created_time":
    case "updated_time":
      return { prop, op: "eq", value: value === "@today" ? "$today" : value === "@now" ? "$now" : value };
    case "status":
      return GROUPS.has(value) ? { prop, op: "eq", value: { group: value.slice(1) } } : { prop, op: "eq", value };
    case "multi_select":
      return { prop, op: "contains", value };
    case "person":
      return { prop, op: "contains", value: value === "@me" ? "$viewer.raviUserId" : value };
    case "created_by":
    case "updated_by":
      return { prop, op: "eq", value: value === "@me" ? "$viewer.raviUserId" : value };
    case "email":
      return { prop, op: "eq", value: value === "@me" ? "$viewer.email" : value };
    case "approval":
    case "agent":
      return { prop, op: "state_in", value };
    default:
      return { prop, op: "eq", value };
  }
}

const PAIR = /^([^!<>=~]*?)\s*(!=|>=|<=|=|>|<|~)([\s\S]*)$/;
/** Range operators: `[number op, date op]`. */
const RANGES: Record<string, [string, string]> = { ">": ["gt", "after"], ">=": ["gte", "on_or_after"], "<": ["lt", "before"], "<=": ["lte", "on_or_before"] };
const TEXTY = /^(text|url|email|phone)$/;
const DATES = /^(date|created_time|updated_time)$/;

function opLeaf(column: BaseViewColumn, op: string, raw: string): BaseFilter {
  const leaf = leafFor(column, raw);
  const { type } = column;
  if (op == "=") return leaf;
  if (op == "~") {
    if (leaf.op == "contains" || (TEXTY.test(type) && leaf.op == "eq")) return { ...leaf, op: "contains" };
  } else if (op == "!=") {
    if (leaf.op == "is_empty") return { ...leaf, op: "is_not_empty" };
    if (leaf.op == "contains") return { ...leaf, op: "not_contains" };
    if (type == "checkbox") return { ...leaf, value: !leaf.value };
    return /^(text|url|email|phone|number|select|status|created_by|updated_by)$/.test(type) ? { ...leaf, op: "neq" } : { not: leaf };
  } else if (leaf.op == "eq") {
    const range = RANGES[op] as [string, string];
    if (type == "number") return { ...leaf, op: range[0] as BaseFilterLeaf["op"] };
    if (DATES.test(type)) return { ...leaf, op: range[1] as BaseFilterLeaf["op"] };
  }
  throw new RaviError("invalid_filter");
}

/** `where` text → filter, using the view's column types. Unknown keys are `invalid_filter`. */
export function parseWhere(text: string | null | undefined, columns: readonly BaseViewColumn[]): BaseFilter | undefined {
  if (!text?.trim()) return undefined;
  const leaves: BaseFilter[] = [];
  for (const pair of text.split(";")) {
    if (!pair.trim()) continue;
    const match = PAIR.exec(pair.trim());
    const column = match && columns.find((candidate) => candidate.key === match[1]);
    if (!match || !column) throw new RaviError("invalid_filter");
    leaves.push(opLeaf(column, match[2] as string, match[3] as string));
  }
  if (!leaves.length) return undefined;
  return leaves.length === 1 ? leaves[0] : { and: leaves };
}
