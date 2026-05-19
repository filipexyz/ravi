import type { Database, SQLQueryBindings } from "bun:sqlite";

const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface LimitOffsetPage {
  limit: number;
  offset: number;
}

export interface ListPage<T> extends LimitOffsetPage {
  total: number;
  items: T[];
}

export interface OffsetPagination extends LimitOffsetPage {
  returned: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
  nextCommand: string | null;
}

export interface LimitOffsetOptions {
  defaultLimit?: number;
  maxLimit?: number;
  minLimit?: number;
}

export interface CountRowsOptions {
  db: Database;
  table: string;
  where?: readonly string[];
  params?: readonly SQLQueryBindings[];
}

export function normalizePageLimit(
  value: number | string | null | undefined,
  options: LimitOffsetOptions = {},
): number {
  const defaultLimit = options.defaultLimit ?? 50;
  const minLimit = options.minLimit ?? 1;
  const maxLimit = options.maxLimit ?? 500;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultLimit;
  return Math.max(minLimit, Math.min(maxLimit, limit));
}

export function normalizePageOffset(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export function normalizeLimitOffsetPage(
  input: { limit?: number | string | null; offset?: number | string | null },
  options: LimitOffsetOptions = {},
): LimitOffsetPage {
  return {
    limit: normalizePageLimit(input.limit, options),
    offset: normalizePageOffset(input.offset),
  };
}

export function paginateItems<T>(
  items: readonly T[],
  input: { limit?: number | string | null; offset?: number | string | null },
  options: LimitOffsetOptions = {},
): ListPage<T> {
  const { limit, offset } = normalizeLimitOffsetPage(input, options);
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
  };
}

export function buildSqlWhereClause(where: readonly string[] = []): string {
  const clauses = where.map((item) => item.trim()).filter(Boolean);
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export function countRows({ db, table, where = [], params = [] }: CountRowsOptions): number {
  assertSqlIdentifier(table, "table");
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table} ${buildSqlWhereClause(where)}`).get(...params) as
    | { total: number }
    | undefined;
  return row?.total ?? 0;
}

export function buildOffsetPagination(args: {
  limit: number;
  offset: number;
  returned: number;
  total: number;
  nextCommand?: (nextOffset: number) => string;
}): OffsetPagination {
  const nextOffset = args.offset + args.returned;
  const hasMore = nextOffset < args.total;
  return {
    limit: args.limit,
    offset: args.offset,
    returned: args.returned,
    total: args.total,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
    nextCommand: hasMore && args.nextCommand ? args.nextCommand(nextOffset) : null,
  };
}

export function buildCommand(tokens: ReadonlyArray<string | number | false | null | undefined>): string {
  const resolved: Array<string | number> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === false || token === null || token === undefined) continue;
    if (typeof token === "string" && token.startsWith("--") && index + 1 < tokens.length) {
      const next = tokens[index + 1];
      if (next === false || next === null || next === undefined) {
        index += 1;
        continue;
      }
    }
    resolved.push(token);
  }
  return resolved.map((token) => quoteCommandToken(String(token))).join(" ");
}

export function quoteCommandToken(token: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(token) ? token : JSON.stringify(token);
}

function assertSqlIdentifier(value: string, label: string): void {
  if (!SQL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid SQL ${label}: ${value}`);
  }
}
