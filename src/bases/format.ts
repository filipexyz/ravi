// Human and CSV rendering of Bases rows. Display only; raw values stay in JSON output.

import { neutralizeCsvFormula, toCsv } from "./csv.js";
import type { BaseProperty, BaseRow, BaseViewColumn, BasesUserRef } from "./schemas.js";

export interface BasesColumnDescriptor {
  key: string;
  name: string;
  type: string;
  /** Option id -> name for select, multi_select, and status. */
  options: Map<string, string>;
}

const SYSTEM_COLUMNS: Record<string, string> = {
  created_time: "Created",
  created_by: "Created by",
  updated_time: "Updated",
  updated_by: "Updated by",
  body: "Body",
};

export function descriptorsFromProperties(properties: readonly BaseProperty[]): Map<string, BasesColumnDescriptor> {
  const map = systemDescriptors();
  for (const property of properties) {
    if (property.deletedAt) continue;
    map.set(property.key, {
      key: property.key,
      name: property.name,
      type: property.type,
      options: optionNames(property.config?.options),
    });
  }
  return map;
}

export function descriptorsFromViewColumns(columns: readonly BaseViewColumn[]): Map<string, BasesColumnDescriptor> {
  const map = systemDescriptors();
  for (const column of columns) {
    map.set(column.key, {
      key: column.key,
      name: column.name,
      type: column.type,
      options: optionNames(column.config?.options),
    });
  }
  return map;
}

/** Text for one cell. `csv` keeps ids for persons and refs so exports can be re-imported. */
export function formatCellText(
  value: unknown,
  descriptor: BasesColumnDescriptor | undefined,
  users: Record<string, BasesUserRef>,
  mode: "table" | "csv",
): string {
  if (value === undefined || value === null) return "";
  const type = descriptor?.type;
  const optionName = (id: unknown) => {
    const key = String(id);
    return descriptor?.options.get(key) ?? key;
  };
  const userName = (id: unknown) => {
    const key = String(id);
    if (mode === "csv") return key;
    return users[key]?.displayName ?? key;
  };
  if (type === "select" || type === "status") return optionName(value);
  if (type === "multi_select" && Array.isArray(value)) return value.map(optionName).join(", ");
  if ((type === "person" && Array.isArray(value)) || type === "created_by" || type === "updated_by") {
    return Array.isArray(value) ? value.map(userName).join(", ") : userName(value);
  }
  if (type === "ref" && Array.isArray(value)) {
    return value
      .map((item) => (isRecord(item) ? `${String(item.type ?? "")}:${String(item.id ?? "")}` : String(item)))
      .join(", ");
  }
  if (isRecord(value) && "start" in value) {
    const start = String(value.start ?? "");
    return value.end ? `${start}/${String(value.end)}` : start;
  }
  if (Array.isArray(value))
    return value.map((item) => (isRecord(item) ? JSON.stringify(item) : String(item))).join(", ");
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

export function rowsToCsv(
  columns: readonly string[],
  rows: readonly BaseRow[],
  descriptors: Map<string, BasesColumnDescriptor>,
  users: Record<string, BasesUserRef>,
): string {
  const header = ["row_id", "version", ...columns];
  const lines = rows.map((row) => [
    row.rowId,
    String(row.version),
    ...columns.map((key) => {
      const raw = key === "body" ? (row.body ?? row.values.body) : row.values[key];
      const textValue = formatCellText(raw, descriptors.get(key), users, "csv");
      return isTypedScalar(descriptors.get(key)?.type) ? textValue : neutralizeCsvFormula(textValue);
    }),
  ]);
  return toCsv([header, ...lines]);
}

export function renderRowsTable(
  columns: readonly string[],
  rows: readonly BaseRow[],
  descriptors: Map<string, BasesColumnDescriptor>,
  users: Record<string, BasesUserRef>,
  maxWidth = 32,
): string[] {
  const header = ["row", "v", ...columns];
  const body = rows.map((row) => [
    row.rowId.slice(0, 8),
    String(row.version),
    ...columns.map((key) => {
      const raw = key === "body" ? (row.body ?? row.values.body) : row.values[key];
      return formatCellText(raw, descriptors.get(key), users, "table");
    }),
  ]);
  return renderTable(header, body, maxWidth);
}

export function renderTable(
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string>>,
  maxWidth = 32,
): string[] {
  const clean = (value: string) => {
    const single = value.replace(/\s+/g, " ").trim();
    return single.length > maxWidth ? `${single.slice(0, maxWidth - 1)}…` : single;
  };
  const cells = [header.map(clean), ...rows.map((row) => row.map(clean))];
  const widths = header.map((_, index) => Math.max(...cells.map((row) => (row[index] ?? "").length)));
  const line = (row: readonly string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(cells[0] ?? []), widths.map((width) => "-".repeat(width)).join("  "), ...cells.slice(1).map(line)];
}

/** Numbers and checkboxes are written as typed scalars; every other cell is neutralized. */
function isTypedScalar(type: string | undefined): boolean {
  return type === "number" || type === "checkbox";
}

function systemDescriptors(): Map<string, BasesColumnDescriptor> {
  const map = new Map<string, BasesColumnDescriptor>();
  for (const [key, name] of Object.entries(SYSTEM_COLUMNS)) {
    map.set(key, { key, name, type: key, options: new Map() });
  }
  return map;
}

function optionNames(options: ReadonlyArray<{ id: string; name: string }> | undefined): Map<string, string> {
  return new Map((options ?? []).map((option) => [option.id, option.name]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
