// CSV import planning for `ravi bases rows import`. Maps CSV columns to property
// keys and shapes cell text into API input values. The Console still validates
// every value; local coercion only picks the JSON type the API expects.

import { createHash } from "node:crypto";
import { parseCsv, restoreCsvFormula } from "./csv.js";
import { invalidInput } from "./input.js";
import type { BaseProperty } from "./schemas.js";

export const BASES_IMPORT_MAX_BATCH_BYTES = 900 * 1024;

export interface CsvImportColumn {
  column: string;
  key: string | null;
  type: string | null;
  skipped: boolean;
  reason?: string;
}

export interface CsvImportIssue {
  /** 1-based CSV line of the data row (header is line 1). */
  line: number;
  column: string;
  key: string;
  message: string;
}

export interface CsvImportRecord {
  line: number;
  values: Record<string, unknown>;
  body?: string;
}

export interface CsvImportPlan {
  columns: CsvImportColumn[];
  records: CsvImportRecord[];
  issues: CsvImportIssue[];
  emptyRows: number;
}

const UNWRITABLE_KEYS = new Set(["row_id", "version", "created_time", "created_by", "updated_time", "updated_by"]);

/** `--map "Deal Name=name" --map "Notes=body" --map "Internal=-"` (`-` skips a column). */
export function parseColumnMap(values: readonly string[] | undefined): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const raw of values ?? []) {
    const separator = raw.lastIndexOf("=");
    if (separator <= 0) throw invalidInput(`--map expects "CSV column=key" (or "column=-" to skip), got "${raw}".`);
    const column = raw.slice(0, separator).trim();
    const key = raw.slice(separator + 1).trim();
    if (!column || !key) throw invalidInput(`--map expects "CSV column=key" (or "column=-" to skip), got "${raw}".`);
    map.set(column, key === "-" ? null : key);
  }
  return map;
}

export function normalizeHeaderKey(header: string): string {
  return header
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1");
}

export function planCsvImport(input: {
  text: string;
  properties: readonly BaseProperty[];
  columnMap: Map<string, string | null>;
}): CsvImportPlan {
  let rows: string[][];
  try {
    rows = parseCsv(input.text);
  } catch (error) {
    throw invalidInput(error instanceof Error ? error.message : "CSV could not be parsed.");
  }
  const header = rows[0];
  if (!header || header.length === 0) throw invalidInput("CSV file has no header row.");
  const active = input.properties.filter((property) => !property.deletedAt);
  const byKey = new Map(active.map((property) => [property.key, property]));
  const byName = new Map(active.map((property) => [property.name.trim().toLowerCase(), property]));

  for (const column of input.columnMap.keys()) {
    if (!header.includes(column))
      throw invalidInput(`--map names a column that is not in the CSV header: "${column}".`);
  }

  const seenKeys = new Set<string>();
  const columns: CsvImportColumn[] = header.map((column) => {
    const mapped = input.columnMap.get(column);
    if (mapped === null) return { column, key: null, type: null, skipped: true, reason: "skipped by --map" };
    if (mapped !== undefined) {
      if (mapped === "body") return claim(column, "body", "body");
      const property = byKey.get(mapped);
      if (!property) throw invalidInput(`--map "${column}=${mapped}": the base has no property with key "${mapped}".`);
      return claim(column, property.key, property.type);
    }
    if (column === "row_id" || column === "version") {
      return { column, key: null, type: null, skipped: true, reason: "system column" };
    }
    if (column.trim().toLowerCase() === "body") return claim(column, "body", "body");
    const property =
      byKey.get(column) ?? byKey.get(normalizeHeaderKey(column)) ?? byName.get(column.trim().toLowerCase());
    if (!property) return { column, key: null, type: null, skipped: true, reason: "no matching property" };
    return claim(column, property.key, property.type);
  });

  function claim(column: string, key: string, type: string): CsvImportColumn {
    if (UNWRITABLE_KEYS.has(key)) return { column, key: null, type: null, skipped: true, reason: "system column" };
    if (seenKeys.has(key)) throw invalidInput(`Two CSV columns map to "${key}". Use --map to pick one.`);
    seenKeys.add(key);
    return { column, key, type, skipped: false };
  }

  const records: CsvImportRecord[] = [];
  const issues: CsvImportIssue[] = [];
  let emptyRows = 0;
  rows.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const record: CsvImportRecord = { line, values: {} };
    let hasValue = false;
    columns.forEach((column, columnIndex) => {
      if (column.skipped || !column.key || !column.type) return;
      const raw = restoreCsvFormula(cells[columnIndex] ?? "");
      if (raw.trim() === "") return;
      if (column.key === "body") {
        record.body = raw;
        hasValue = true;
        return;
      }
      const coerced = coerceCsvCell(column.type, raw);
      if ("error" in coerced) {
        issues.push({ line, column: column.column, key: column.key, message: coerced.error });
        return;
      }
      record.values[column.key] = coerced.value;
      hasValue = true;
    });
    if (!hasValue) {
      emptyRows += 1;
      return;
    }
    records.push(record);
  });
  return { columns, records, issues, emptyRows };
}

/** Shape CSV text into the JSON type the API expects for a property type. */
export function coerceCsvCell(type: string, raw: string): { value: unknown } | { error: string } {
  const value = raw.trim();
  switch (type) {
    case "number": {
      const normalized = value.replace(/[\s_]/g, "");
      const parsed = Number(normalized);
      if (!normalized || !Number.isFinite(parsed)) return { error: "not a number" };
      return { value: parsed };
    }
    case "checkbox": {
      const normalized = value.toLowerCase();
      if (["true", "yes", "y", "1", "x", "checked"].includes(normalized)) return { value: true };
      if (["false", "no", "n", "0", "unchecked"].includes(normalized)) return { value: false };
      return { error: "not a boolean" };
    }
    case "multi_select":
    case "person":
      return { value: splitCells(value) };
    case "ref": {
      const refs = splitCells(value).map((item) => {
        const separator = item.indexOf(":");
        return separator > 0 ? { type: item.slice(0, separator), id: item.slice(separator + 1) } : null;
      });
      if (refs.some((ref) => ref === null)) return { error: "refs must be type:id" };
      return { value: refs };
    }
    case "date": {
      const separator = value.indexOf("/");
      if (separator > 0)
        return { value: { start: value.slice(0, separator), end: value.slice(separator + 1) || null } };
      return { value };
    }
    default:
      return { value: raw };
  }
}

/**
 * Deterministic batches: the same file, mapping, and --batch always produce the
 * same batches. A retry with another --batch reuses keys with different bodies,
 * which the Console rejects as an idempotency conflict instead of duplicating rows.
 */
export function batchImportRecords(
  records: readonly CsvImportRecord[],
  batchSize: number,
  maxBytes = BASES_IMPORT_MAX_BATCH_BYTES,
): CsvImportRecord[][] {
  const batches: CsvImportRecord[][] = [];
  let current: CsvImportRecord[] = [];
  let currentBytes = 0;
  for (const record of records) {
    const bytes = Buffer.byteLength(JSON.stringify(toRowInput(record)));
    if (current.length > 0 && (current.length >= batchSize || currentBytes + bytes > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(record);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function toRowInput(record: CsvImportRecord): { values: Record<string, unknown>; body?: string } {
  return record.body !== undefined ? { values: record.values, body: record.body } : { values: record.values };
}

/**
 * Prefix of the per-batch idempotency keys. It binds the file bytes, the base,
 * the project, and the effective column mapping, so a retry of the same import
 * replays finished batches instead of creating duplicates.
 */
export function importIdempotencyPrefix(input: {
  fileBytes: Uint8Array | string;
  projectRef: string;
  baseRef: string;
  columns: readonly CsvImportColumn[];
}): string {
  const hash = createHash("sha256");
  hash.update(input.fileBytes);
  hash.update("\0");
  hash.update(input.projectRef);
  hash.update("\0");
  hash.update(input.baseRef);
  hash.update("\0");
  hash.update(JSON.stringify(input.columns.map((column) => [column.column, column.key])));
  return `ravi-import:${hash.digest("hex").slice(0, 40)}`;
}

export function importBatchKey(prefix: string, index: number): string {
  return `${prefix}:${index}`;
}

function splitCells(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
