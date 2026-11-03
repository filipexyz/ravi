// CSV export of the rows a person sees through a view. Pure: the caller
// passes a page fetcher (the view query, with the same sort, search and
// view-as as the table) and saves the text. Cells use the table's display
// formatting (`plainValue`), so the file reads like the screen.

import type { BaseCellValue, BaseQueryResponse, BaseRow, BaseUserRef, BaseViewColumn, BaseViewingAs } from "@/shared/bases/types";
import { plainValue } from "./format";

/** At most this many rows go into one file. */
export const EXPORT_ROW_LIMIT = 10_000;
/** Rows per view query while exporting (the API maximum). */
export const EXPORT_PAGE_SIZE = 500;

/** First characters a spreadsheet may read as a formula (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A formatted number ("-1.234,5", "-12%"): safe to leave as is in a number column. */
const PLAIN_NUMBER = /^[-+]?\d[\d.,  ]*%?$/;

/**
 * One CSV field (RFC 4180). Text a spreadsheet would run as a formula gets a
 * leading `'`, except plain numbers in number columns, so negative values
 * stay numbers. Fields with a comma, quote, line break, or edge spaces are
 * quoted.
 */
export function csvCell(text: string, numeric = false) {
  let cell = text;
  if (FORMULA_START.test(cell) && !(numeric && PLAIN_NUMBER.test(cell))) cell = `'${cell}`;
  return /[",\r\n]|^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function isNumericColumn(column: BaseViewColumn) {
  return column.type === "number" || (column.type === "agent" && column.config.output === "number");
}

function cellText(column: BaseViewColumn, row: BaseRow, users: Record<string, BaseUserRef>, timezone: string) {
  if (column.type === "body") return row.body ?? "";
  return plainValue(column, row.values[column.key] as BaseCellValue | undefined, users, timezone);
}

/** The file's text: a header with the column names, then one line per row, CRLF line ends. */
export function buildCsv(columns: readonly BaseViewColumn[], rows: readonly BaseRow[], users: Record<string, BaseUserRef>, timezone: string) {
  const lines = [columns.map((column) => csvCell(column.name)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(cellText(column, row, users, timezone), isNumericColumn(column))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function fileSlug(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** `<base-slug>-<view-name>.csv`, with the view name made safe for a file name. */
export function csvFileName(baseSlug: string, viewName: string) {
  const view = fileSlug(viewName) || "view";
  return `${fileSlug(baseSlug) || "base"}-${view}.csv`;
}

export type ExportPage = (cursor: string | null, limit: number) => Promise<BaseQueryResponse>;

export type CollectedRows = {
  /** Column keys of the first page, in display order. */
  columns: string[];
  rows: BaseRow[];
  users: Record<string, BaseUserRef>;
  /** More rows matched than the file holds. */
  truncated: boolean;
  viewingAs?: BaseViewingAs;
};

/** Pages through the view query until it ends or `max` rows are in. */
export async function collectExportRows(
  fetchPage: ExportPage,
  options: { max?: number; onProgress?: (count: number) => void; signal?: AbortSignal } = {},
): Promise<CollectedRows> {
  const max = options.max ?? EXPORT_ROW_LIMIT;
  const rows: BaseRow[] = [];
  const users: Record<string, BaseUserRef> = {};
  let columns: string[] | null = null;
  let viewingAs: BaseViewingAs | undefined;
  let cursor: string | null = null;
  do {
    options.signal?.throwIfAborted();
    const page: BaseQueryResponse = await fetchPage(cursor, Math.min(EXPORT_PAGE_SIZE, max - rows.length));
    columns ??= page.columns;
    viewingAs ??= page.viewingAs;
    Object.assign(users, page.users);
    rows.push(...page.rows);
    cursor = page.nextCursor;
    options.onProgress?.(Math.min(rows.length, max));
  } while (cursor && rows.length < max);
  return {
    columns: columns ?? [],
    rows: rows.slice(0, max),
    truncated: Boolean(cursor) || rows.length > max,
    users,
    ...(viewingAs ? { viewingAs } : {}),
  };
}
