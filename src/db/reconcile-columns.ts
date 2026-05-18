/**
 * Declarative schema reconciliation for `bun:sqlite`.
 *
 * Diff a live SQLite database against a declarative `SCHEMA_SQL` string and
 * apply `ALTER TABLE ADD COLUMN` for any column declared in `SCHEMA_SQL` that
 * is missing in the live table. Inspired by Hermes Agent's `_reconcile_columns`
 * (NousResearch/hermes-agent, `hermes_state.py`).
 *
 * This replaces the ad-hoc pattern of scattered `ALTER TABLE` try-catch blocks
 * (or `PRAGMA table_info` introspection) that the Ravi codebase uses today.
 * The contract: `SCHEMA_SQL` is the source of truth. To add a column, edit
 * `SCHEMA_SQL` — `reconcileColumns()` picks it up on boot.
 *
 * Limitations (inherited from SQLite's `ALTER TABLE ADD COLUMN`):
 *  - Cannot add `PRIMARY KEY` or `UNIQUE` constraints inline.
 *  - Cannot add a `NOT NULL` column without a constant `DEFAULT`.
 *  - Cannot add a column with a non-constant default (e.g. `CURRENT_TIMESTAMP`
 *    is allowed; `now()` from a UDF is not).
 *
 * For schema changes that don't fit (`DROP COLUMN`, type changes, index
 * recreation, data backfills) use a version-gated migration runner instead.
 */

import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

const log = logger.child("db:reconcile-columns");

export interface ParsedColumn {
  /** Bare column name (unquoted). */
  name: string;
  /** Full column definition as it appears after the name (type + constraints). */
  definition: string;
}

export interface ReconcileColumnsResult {
  /** Added columns, keyed by table name. */
  added: Record<string, string[]>;
  /** Tables present in SCHEMA_SQL but missing in the live DB. */
  missingTables: string[];
  /** Total ALTER TABLE statements executed. */
  alterCount: number;
}

export interface ReconcileColumnsOptions {
  /** Optional label for logs (e.g. "router-db"). */
  label?: string;
}

const TABLE_CONSTRAINT_KEYWORDS = new Set(["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"]);

function stripComments(sql: string): string {
  // Remove block comments
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove line comments
  out = out.replace(/--[^\n]*\n/g, "\n");
  return out;
}

function unquoteIdent(ident: string): string {
  const trimmed = ident.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitTopLevelByComma(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: false | "'" | '"' = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString !== false) {
      if (ch === inString) {
        // SQLite escapes a quote by doubling it; peek next.
        if (body[i + 1] === inString) {
          i++;
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function isTableConstraint(token: string): boolean {
  // First word, ended by whitespace OR `(` (because `UNIQUE(...)` has no space
  // between the keyword and its argument list).
  const m = token.trimStart().match(/^([A-Za-z_][A-Za-z_0-9]*)/);
  const head = m?.[1]?.toUpperCase();
  return head !== undefined && TABLE_CONSTRAINT_KEYWORDS.has(head);
}

function parseColumnToken(token: string): ParsedColumn | null {
  if (isTableConstraint(token)) return null;
  // First identifier is the column name. It can be quoted: `"col"`, `` `col` ``,
  // `[col]`. Capture greedily up to the first space outside quoting.
  let nameEnd = -1;
  let inQuote: false | '"' | "`" | "]" = false;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (inQuote !== false) {
      const closer = inQuote === "]" ? "]" : inQuote;
      if (ch === closer) {
        // Quoted-quote handling for "
        if (closer === '"' && token[i + 1] === '"') {
          i++;
          continue;
        }
        inQuote = false;
        nameEnd = i + 1;
        break;
      }
      continue;
    }
    if (i === 0 && (ch === '"' || ch === "`")) {
      inQuote = ch as '"' | "`";
      continue;
    }
    if (i === 0 && ch === "[") {
      inQuote = "]";
      continue;
    }
    if (/\s/.test(ch)) {
      nameEnd = i;
      break;
    }
  }
  if (nameEnd === -1) {
    // Entire token is just the name (no type) — unusual but possible.
    return { name: unquoteIdent(token), definition: "" };
  }
  const rawName = token.slice(0, nameEnd).trim();
  const definition = token.slice(nameEnd).trim();
  const name = unquoteIdent(rawName);
  if (!name) return null;
  return { name, definition };
}

const CREATE_TABLE_REGEX = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(/gi;

export function parseSchemaColumns(sql: string): Map<string, ParsedColumn[]> {
  const stripped = stripComments(sql);
  const tables = new Map<string, ParsedColumn[]>();
  let match: RegExpExecArray | null;
  CREATE_TABLE_REGEX.lastIndex = 0;
  while ((match = CREATE_TABLE_REGEX.exec(stripped)) !== null) {
    const rawTableName = match[1];
    if (!rawTableName) continue;
    const tableName = unquoteIdent(rawTableName);
    // Find the matching closing paren for the opening one captured by the regex.
    const start = match.index + match[0].length;
    let depth = 1;
    let end = -1;
    let inString: false | "'" | '"' = false;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (inString !== false) {
        if (ch === inString) {
          if (stripped[i + 1] === inString) {
            i++;
            continue;
          }
          inString = false;
        }
        continue;
      }
      if (ch === "'" || ch === '"') {
        inString = ch;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    const body = stripped.slice(start, end);
    const tokens = splitTopLevelByComma(body);
    const cols: ParsedColumn[] = [];
    for (const token of tokens) {
      const col = parseColumnToken(token);
      if (col) cols.push(col);
    }
    tables.set(tableName, cols);
  }
  return tables;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function reconcileColumns(
  db: Database,
  sql: string,
  options: ReconcileColumnsOptions = {},
): ReconcileColumnsResult {
  const declared = parseSchemaColumns(sql);
  const added: Record<string, string[]> = {};
  const missingTables: string[] = [];
  let alterCount = 0;

  for (const [tableName, declaredCols] of declared) {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as TableInfoRow[];
    if (rows.length === 0) {
      missingTables.push(tableName);
      continue;
    }
    const liveCols = new Set(rows.map((r) => r.name));
    for (const col of declaredCols) {
      if (liveCols.has(col.name)) continue;
      // SQLite cannot add a column with PRIMARY KEY or UNIQUE constraints; the
      // caller is expected to keep ADD-COLUMN-safe defaults in SCHEMA_SQL. We
      // still emit the ALTER and surface any failure.
      const stmt = `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(col.name)} ${col.definition}`.trim();
      try {
        db.exec(stmt);
        alterCount++;
        const list = added[tableName] ?? [];
        list.push(col.name);
        added[tableName] = list;
        log.info("reconciled column", {
          table: tableName,
          column: col.name,
          label: options.label,
        });
      } catch (err) {
        log.error("failed to reconcile column", {
          table: tableName,
          column: col.name,
          definition: col.definition,
          label: options.label,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  }

  return { added, missingTables, alterCount };
}
