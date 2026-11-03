// View rows as render records. With a widget, records are keyed by widget
// field (the kit maps each field to a view column); without one, by column
// key for the default card. Capabilities from describe are mapped back to
// the same keys, and `set` values of widget buttons resolve against the
// mapped column's config.

import type { BaseViewColumn } from "@/shared/bases/types";
import { formatValue, type FormatContext } from "@/shared/widgets/render/format";
import type { ConfirmChange } from "@/shared/widgets/render/messages";
import {
  FIELD_ROLE_DISPLAYS,
  FIELD_TYPE_DISPLAYS,
  type CompiledWidget,
  type FieldDisplayRules,
  type RenderColumn,
  type RenderRecord,
  type SetValue,
  type WidgetActionVerb,
} from "@/shared/widgets/types";

import { RaviError } from "./errors";
import type { ViewRow } from "./view";

/** The first display of every type and role (what a theme without `fields.json` gives). */
export function defaultDisplayRules(): FieldDisplayRules {
  const first = (table: Record<string, readonly string[]>) => Object.fromEntries(Object.entries(table).map(([key, list]) => [key, list[0]]));
  return { types: first(FIELD_TYPE_DISPLAYS), roles: first(FIELD_ROLE_DISPLAYS) } as FieldDisplayRules;
}

/** Render keys (widget fields, or column keys) and the view column behind each. */
export type Binding = {
  widget: CompiledWidget | null;
  columnOf: Record<string, string>;
  columns: Record<string, RenderColumn>;
};

/** Widget fields without a mapped (projected) column are left out: they render empty. */
export function bind(columns: readonly BaseViewColumn[], widget: CompiledWidget | null, fields: Record<string, string>): Binding {
  const binding: Binding = { widget, columnOf: {}, columns: {} };
  for (const key of widget ? Object.keys(widget.fields) : columns.map((column) => column.key)) {
    const column = columns.find((candidate) => candidate.key == (widget ? fields[key] : key));
    if (column) {
      binding.columnOf[key] = column.key;
      binding.columns[key] = { key, name: column.name, type: column.type, config: column.config ?? {} };
    }
  }
  return binding;
}

/** A row as a render record; rows still being created (version 0) have no id, so their buttons stay off. */
export function toRecord(row: ViewRow, binding: Binding): RenderRecord {
  const values: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(binding.columnOf)) if (column in row.values) values[key] = row.values[column];
  return { id: row.version ? row.rowId : null, version: row.version, values, body: row.body };
}

/** Render keys whose column passes `writable`. */
export const writeKeys = (binding: Binding, writable: (column: string) => boolean) =>
  new Set(Object.keys(binding.columnOf).filter((key) => writable(binding.columnOf[key] as string)));

/** `YYYY-MM-DD` of `now` in the viewer's local time. */
export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function setValueFor(value: Exclude<SetValue, { kind: "me" }>, column: RenderColumn, now: Date): unknown {
  const options = column.config.options ?? [];
  if (value.kind == "now") return column.config.includeTime ? now.toISOString() : localDate(now);
  if (value.kind == "today") return localDate(now);
  if (value.kind != "status_group" && (value.kind != "literal" || !/^(select|status)$/.test(column.type))) return value.value;
  const matches = options.filter((option) => (value.kind == "status_group" ? option.group == value.group : option.name == value.value || option.id == value.value));
  const option = matches.find((candidate) => !candidate.archived) ?? (value.kind == "literal" ? matches[0] : undefined);
  if (!option) throw new RaviError("validation_failed");
  return option.id;
}

/**
 * Column values for a button's `set` and the confirmation lines. `@me` is
 * left out of a create: the view's `$viewer` write preset fills it (anywhere
 * else it is refused). Fields without a mapped column are refused.
 */
export function resolveSet(
  set: Record<string, SetValue>,
  binding: Binding,
  verb: WidgetActionVerb,
  ctx: FormatContext,
): { values: Record<string, unknown>; changes: ConfirmChange[] } {
  const values: Record<string, unknown> = {};
  const changes: ConfirmChange[] = [];
  for (const [field, value] of Object.entries(set)) {
    const key = binding.columnOf[field];
    const column = binding.columns[field];
    if (!key || !column) throw new RaviError("unknown_property");
    if (value.kind == "me") {
      if (verb != "create") throw new RaviError("payload_invalid");
      continue;
    }
    values[key] = setValueFor(value, column, ctx.now);
    changes.push({ label: column.name, value: formatValue(column, values[key], ctx) });
  }
  return { values, changes };
}
