// Widget fields → view columns (CONTRACT 4.6), shared by `ravi pages ship`
// (the page kit), `layout.widget` saves and `ravi widgets init --from-view`.
// Per field, first match wins: the explicit map, then a compatible column with
// the same key, then a compatible column whose name (lowercased, accents
// removed, spaces as `_`) equals the key or the label, then the only unused
// column of exactly the field's type.

import { WIDGET_FIELD_KEY_PATTERN } from "./template/manifest";
import type { Diagnostic, RenderColumn, RenderColumnType, WidgetFieldSpec, WidgetFieldType } from "./types";

/** Column types each widget field type accepts; `text` takes any column. */
const COMPATIBLE_COLUMNS: Record<Exclude<WidgetFieldType, "text">, readonly RenderColumnType[]> = {
  number: ["number"],
  checkbox: ["checkbox"],
  date: ["date", "created_time", "updated_time"],
  select: ["select", "status"],
  status: ["status"],
  multi_select: ["multi_select"],
  url: ["url"],
  email: ["email"],
  phone: ["phone"],
  person: ["person", "created_by", "updated_by"],
  ref: ["ref"],
};

export function isCompatibleColumn(fieldType: WidgetFieldType, columnType: RenderColumnType): boolean {
  if (fieldType === "text") return true;
  return COMPATIBLE_COLUMNS[fieldType]?.includes(columnType) ?? false;
}

/** Column types a field type accepts, or `"any"` for text (for the catalog). */
export function compatibleColumnTypes(fieldType: WidgetFieldType): readonly RenderColumnType[] | "any" {
  return fieldType === "text" ? "any" : COMPATIBLE_COLUMNS[fieldType];
}

/** `Responsável Técnico` → `responsavel_tecnico`. */
export function normalizeColumnName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

export function matchFields(input: {
  fields: Record<string, WidgetFieldSpec>;
  columns: readonly RenderColumn[];
  explicit?: Record<string, string>;
}): { mapping: Record<string, string>; diagnostics: Diagnostic[] } {
  const { fields, columns } = input;
  const explicit = input.explicit ?? {};
  const mapping: Record<string, string> = {};
  const diagnostics: Diagnostic[] = [];
  const used = new Set<string>();
  const decided = new Set<string>();
  const keys = Object.keys(fields);
  const byKey = new Map(columns.map((column) => [column.key, column] as const));

  const assign = (key: string, column: RenderColumn) => {
    mapping[key] = column.key;
    used.add(column.key);
    decided.add(key);
  };
  const error = (code: string, message: string) => diagnostics.push({ severity: "error", code, message });
  const candidates = (type: WidgetFieldType) => {
    const list = columns.filter((column) => isCompatibleColumn(type, column.type)).map((column) => `${column.key}: ${column.type}`);
    return list.length ? `Candidates: ${list.join(", ")}.` : `The view has no column a ${type} field accepts.`;
  };

  for (const key of Object.keys(explicit)) {
    if (!Object.hasOwn(fields, key)) {
      error(
        "WIDGET_FIELD_UNKNOWN",
        `fields maps "${key}", which the widget does not take; its fields: ${keys.join(", ") || "none"}.`,
      );
    }
  }

  // 1. Explicit map: decides the field, right or wrong.
  for (const key of keys) {
    if (!Object.hasOwn(explicit, key)) continue;
    const field = fields[key] as WidgetFieldSpec;
    const columnKey = explicit[key] ?? "";
    const column = byKey.get(columnKey);
    decided.add(key);
    if (!column) {
      error("WIDGET_FIELD_COLUMN_MISSING", `fields maps ${key} to "${columnKey}", which the view does not project. ${candidates(field.type)}`);
    } else if (!isCompatibleColumn(field.type, column.type)) {
      error(
        "WIDGET_FIELD_INCOMPATIBLE",
        `fields maps ${key} (${field.type}) to ${column.key} (${column.type}), which a ${field.type} field cannot show. ${candidates(field.type)}`,
      );
    } else {
      assign(key, column);
    }
  }

  // 2. Same key, compatible type.
  for (const key of keys) {
    if (decided.has(key)) continue;
    const field = fields[key] as WidgetFieldSpec;
    const column = byKey.get(key);
    if (column && isCompatibleColumn(field.type, column.type)) assign(key, column);
  }

  // 3. Column name equals the key or the label.
  for (const key of keys) {
    if (decided.has(key)) continue;
    const field = fields[key] as WidgetFieldSpec;
    const names = new Set([key, ...(field.label ? [normalizeColumnName(field.label)] : [])]);
    const column = columns.find((candidate) => isCompatibleColumn(field.type, candidate.type) && names.has(normalizeColumnName(candidate.name)));
    if (column) assign(key, column);
  }

  // 4. The only unused column of exactly the field's type.
  for (const key of keys) {
    if (decided.has(key)) continue;
    const field = fields[key] as WidgetFieldSpec;
    const unused = columns.filter((column) => column.type === field.type && !used.has(column.key));
    if (unused.length === 1 && unused[0]) assign(key, unused[0]);
  }

  for (const key of keys) {
    if (decided.has(key)) continue;
    const field = fields[key] as WidgetFieldSpec;
    const hint = `Map it with fields="${key}:<column>". ${candidates(field.type)}`;
    diagnostics.push(
      field.required
        ? { severity: "error", code: "WIDGET_FIELD_MISSING", message: `Required widget field ${key} (${field.type}) matches no column. ${hint}` }
        : {
            severity: "warning",
            code: "WIDGET_FIELD_MISSING",
            message: `Optional widget field ${key} (${field.type}) matches no column and renders empty. ${hint}`,
          },
    );
  }

  return { mapping, diagnostics };
}

/** `fields="titulo:cliente_nome, valor:total"` → `{ titulo: "cliente_nome", valor: "total" }`. */
export function parseFieldsAttribute(text: string): { map: Record<string, string>; diagnostics: Diagnostic[] } {
  const map: Record<string, string> = {};
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string) => diagnostics.push({ severity: "error", code, message });
  if (!text.trim()) return { map, diagnostics };

  for (const part of text.split(",")) {
    const entry = part.trim();
    const colon = entry.indexOf(":");
    if (!entry || colon < 0) {
      error("FIELDS_ATTRIBUTE_SYNTAX", `fields takes widgetField:column pairs separated by commas; fix "${entry}".`);
      continue;
    }
    const key = entry.slice(0, colon).trim();
    const column = entry.slice(colon + 1).trim();
    if (!WIDGET_FIELD_KEY_PATTERN.test(key) || !WIDGET_FIELD_KEY_PATTERN.test(column)) {
      error(
        "FIELDS_ATTRIBUTE_SYNTAX",
        `fields entry "${entry}" must be widgetField:column with lowercase keys (letters, digits, _).`,
      );
      continue;
    }
    if (Object.hasOwn(map, key)) {
      error("FIELDS_ATTRIBUTE_DUPLICATE", `fields maps ${key} twice; keep one column for it.`);
      continue;
    }
    map[key] = column;
  }
  return { map, diagnostics };
}
