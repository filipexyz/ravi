// Row reads shared by direct reads and reads through a view: compiled page
// queries with keyset cursors, aggregations, and history pages. Reads run in a
// transaction with `SET LOCAL statement_timeout`.

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/server/db";
import { BASES_LIMITS } from "@/shared/bases/limits";
import type {
  BaseAggregateGroup,
  BaseAggregateRequest,
  BaseFilter,
  BaseLedgerEntry,
  BaseProperty,
  BaseQueryResponse,
  BaseSort,
  BaseUserRef,
} from "@/shared/bases/types";

import {
  baseQueryHash,
  buildBaseRowsQuery,
  compileBaseAggregate,
  compileBaseFilter,
  compileBaseSort,
  type BaseAggregateDimension,
  type BaseCompileContext,
  type BaseRowsQueryRow,
} from "./compiler";
import { basesCallerPrincipal } from "./context";
import { decodeBaseCursor, encodeBaseCursor, type BaseCursorBinding } from "./cursor";
import { basesError, conflict, postgresErrorCode } from "./errors";
import { ledgerEntryToApi, loadLedgerPage, type LedgerVisibility } from "./ledger";
import { executeRows, findUserRefs, withStatementTimeout, type BasesTx } from "./repository";
import type { BaseScope } from "./scope";
import {
  approvalUserIds,
  projectRow,
  referencedUserIds,
  rowDataFromQueryRow,
  type BaseProjectedColumn,
} from "./serialize";

function isStatementTimeout(error: unknown) {
  return postgresErrorCode(error) === "57014";
}

/** Runs a read with a statement timeout; a timeout is `503 query_timeout`. */
export async function runBasesRead<T>(timeoutMs: number, fn: (tx: BasesTx) => Promise<T>): Promise<T> {
  try {
    return await withStatementTimeout(timeoutMs, fn);
  } catch (error) {
    if (isStatementTimeout(error)) {
      throw basesError(503, { error: "query_timeout", reason: "The query took too long. Narrow the filter and retry." });
    }
    throw error;
  }
}

export type RowsPageInput = {
  scope: BaseScope;
  /** `base:<id>` or `view:<id>`. */
  cursorScope: string;
  viewVersion: number;
  /** View policy (already compiled), ANDed with the request filter. */
  policySql: SQL | null;
  requestFilter: BaseFilter | null | undefined;
  /** Resolves request filter columns (view-restricted through a view). */
  filterCtx: BaseCompileContext;
  /** Compiled `search` (`compileBaseSearch`), ANDed with the filters. */
  searchSql?: SQL | null;
  sort: BaseSort[] | null | undefined;
  sortCtx: BaseCompileContext;
  columns: BaseProjectedColumn[];
  includeBody: boolean;
  includeArchived: boolean;
  limit: number;
  cursor: string | null | undefined;
  /** Parts of the request bound into the cursor. */
  hashParts: unknown;
};

export async function queryRowsPage(input: RowsPageInput): Promise<BaseQueryResponse> {
  const { scope } = input;
  const compiledRequest = compileBaseFilter(input.requestFilter ?? null, input.filterCtx);
  const requestSql = input.searchSql ? sql`(${compiledRequest}) AND (${input.searchSql})` : compiledRequest;
  const filterSql = input.policySql ? sql`(${input.policySql}) AND (${requestSql})` : requestSql;
  const sort = compileBaseSort(input.sort ?? [], input.sortCtx);
  const binding: BaseCursorBinding = {
    scope: input.cursorScope,
    viewVersion: input.viewVersion,
    schemaVersion: scope.base.schemaVersion,
    queryHash: baseQueryHash(input.hashParts),
    principal: basesCallerPrincipal(scope.caller),
  };
  const cursorValues = input.cursor ? decodeBaseCursor(input.cursor, binding).values : null;
  const query = buildBaseRowsQuery({
    organizationId: scope.base.organizationId,
    baseId: scope.base.id,
    filterSql,
    sort,
    cursorValues,
    limit: input.limit,
    includeArchived: input.includeArchived,
    includeBody: input.includeBody,
  });
  const rows = await runBasesRead(BASES_LIMITS.queryTimeoutMs, (tx) => executeRows<BaseRowsQueryRow>(tx, query));
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > input.limit && last
      ? encodeBaseCursor({ ...binding, values: sort.keys.map((_, index) => last[`__s${index}`] ?? null) })
      : null;
  const projected = page.map((row) =>
    projectRow(rowDataFromQueryRow(row), input.columns, {
      includeBody: input.includeBody,
      includeArchivedAt: input.includeArchived,
    }),
  );
  const users = await findUserRefs(db, referencedUserIds(projected, input.columns));
  return {
    columns: input.columns.filter((column) => column.kind !== "body" || input.includeBody).map((column) => column.key),
    rows: projected,
    nextCursor,
    users,
  };
}

// ---------------------------------------------------------------------------
// Aggregation

export type AggregateRunResult = {
  groups: Array<BaseAggregateGroup & { count: number; raw: Record<string, unknown> }>;
  dimensions: BaseAggregateDimension[];
};

function aggregateValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Runs an aggregation; more than 5,000 groups is `409 aggregate_too_large`. */
export async function runAggregate(input: {
  scope: BaseScope;
  request: BaseAggregateRequest;
  ctx: BaseCompileContext;
  policySql: SQL | null;
}): Promise<AggregateRunResult> {
  const compiled = compileBaseAggregate(input.request, input.ctx, {
    organizationId: input.scope.base.organizationId,
    policyFilterSql: input.policySql,
  });
  const rows = await runBasesRead(BASES_LIMITS.aggregateTimeoutMs, (tx) =>
    executeRows<Record<string, unknown>>(tx, compiled.query),
  );
  if (rows.length > BASES_LIMITS.aggregateGroups) {
    conflict("aggregate_too_large", { reason: `Aggregations return at most ${BASES_LIMITS.aggregateGroups} groups.` });
  }
  const groups = rows.map((row) => {
    const keys: Record<string, string | number | boolean | null> = {};
    compiled.dimensions.forEach((dimension, index) => {
      keys[dimension.key] = aggregateValue(row[`g${index}`]);
    });
    const values: Record<string, number | string | null> = {};
    for (const measure of compiled.measures) {
      const value = aggregateValue(row[`m_${measure.as}`]);
      values[measure.as] = typeof value === "boolean" ? Number(value) : value;
    }
    return { keys, values, count: Number(row.__count ?? 0), raw: row };
  });
  return { groups, dimensions: compiled.dimensions };
}

/** User refs for person, created_by, and updated_by dimensions. */
export async function aggregateUsers(
  dimensions: readonly BaseAggregateDimension[],
  groups: ReadonlyArray<{ keys: Record<string, unknown> }>,
): Promise<Record<string, BaseUserRef>> {
  const ids = new Set<string>();
  for (const dimension of dimensions) {
    if (dimension.column.kind !== "person" && dimension.column.kind !== "created_by" && dimension.column.kind !== "updated_by") continue;
    for (const group of groups) {
      const value = group.keys[dimension.key];
      if (typeof value === "string") ids.add(value);
    }
  }
  return findUserRefs(db, ids);
}

// ---------------------------------------------------------------------------
// History

export async function historyPage(input: {
  scope: BaseScope;
  rowId: string;
  cursorScope: string;
  viewVersion: number;
  cursor: string | null;
  limit: number;
  visibility: LedgerVisibility;
  propertiesById: ReadonlyMap<string, BaseProperty>;
}): Promise<{ entries: BaseLedgerEntry[]; nextCursor: string | null; users: Record<string, BaseUserRef> }> {
  const binding: BaseCursorBinding = {
    scope: input.cursorScope,
    viewVersion: input.viewVersion,
    schemaVersion: input.scope.base.schemaVersion,
    queryHash: baseQueryHash({ history: input.rowId.toLowerCase() }),
    principal: basesCallerPrincipal(input.scope.caller),
  };
  let beforeSequence: number | null = null;
  if (input.cursor) {
    const decoded = decodeBaseCursor(input.cursor, binding);
    const value = decoded.values[0];
    const parsed = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed)) throw basesError(400, { error: "cursor_invalid" });
    beforeSequence = parsed;
  }
  const entries: BaseLedgerEntry[] = [];
  let cursorSequence = beforeSequence;
  let exhausted = false;
  // Entries hidden through a view are skipped; keep reading until the page is full.
  for (let round = 0; round < 10 && entries.length < input.limit; round += 1) {
    const records = await loadLedgerPage(db, {
      baseId: input.scope.base.id,
      rowId: input.rowId.toLowerCase(),
      beforeSequence: cursorSequence,
      limit: input.limit + 1,
    });
    let consumed = 0;
    for (const record of records) {
      if (entries.length >= input.limit) break;
      consumed += 1;
      cursorSequence = Number(record.sequence);
      const entry = ledgerEntryToApi(record, input.propertiesById, input.visibility);
      if (entry) entries.push(entry);
    }
    if (records.length <= input.limit && consumed === records.length) {
      exhausted = true;
      break;
    }
  }
  const nextCursor =
    exhausted || cursorSequence === null ? null : encodeBaseCursor({ ...binding, values: [String(cursorSequence)] });
  const actorIds = entries.map((entry) => entry.actorId).filter((id): id is string => typeof id === "string");
  // Approval values name who asked and who decided.
  for (const entry of entries) {
    for (const key of entry.changedKeys) {
      for (const value of [entry.before[key], entry.after[key]]) actorIds.push(...approvalUserIds(value));
    }
  }
  const users = await findUserRefs(db, actorIds);
  return { entries, nextCursor, users };
}
