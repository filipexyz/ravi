// Direct row operations (`base.read_direct`, `base.write_direct`): all rows,
// all columns, no view. See SPEC "Row" and the API table.

import { BASES_LIMITS } from "@/shared/bases/limits";
import {
  baseAgentFillSchema,
  baseAgentRerunSchema,
  baseAggregateRequestSchema,
  baseCreateRowsSchema,
  baseQueryRequestSchema,
  baseRowLifecycleSchema,
  baseRowPurgeSchema,
  baseUpdateRowSchema,
} from "@/shared/bases/schemas";
import type {
  BaseAggregateRequest,
  BaseAggregateResponse,
  BaseQueryResponse,
  BaseRow,
  BaseRowBatchWriteResponse,
  BaseRowHistoryResponse,
  BaseRowWriteResponse,
} from "@/shared/bases/types";

import { baseCompileColumns, compileBaseSearch } from "./compiler";
import { forbidden, notFound, parseBasesBody, payloadInvalid } from "./errors";
import { resolveBaseIdempotencyKey } from "./idempotency";
import { aggregateUsers, historyPage, queryRowsPage, runAggregate } from "./reads";
import { loadLedgerPage } from "./ledger";
import { findRowRecord, findUserRefs, type BaseRowRecord } from "./repository";
import {
  changeRowLifecycle,
  createRows,
  fillAgentValue,
  purgeRow,
  rerunAgentValue,
  resolveAgentProperty,
  updateRow,
} from "./row-writes";
import { compileContext, type BaseScope } from "./scope";
import {
  directColumns,
  projectRow,
  referencedUserIds,
  rowDataFromRecord,
  type BaseRowData,
} from "./serialize";
import { db } from "@/server/db";
import { assertBasesServiceOperation, type BasesServiceOperation } from "./service-principal";

function requireDirect(scope: BaseScope, operation?: BasesServiceOperation) {
  assertBasesServiceOperation(scope, operation);
  if (!scope.access.manage) forbidden("Direct row access needs project write access. Use a view.");
}

function projectDirect(scope: BaseScope, row: BaseRowData, includeArchivedAt = false): BaseRow {
  return projectRow(row, [...directColumns(scope.properties), { ref: "body", key: "body", kind: "body" }], {
    includeBody: true,
    includeArchivedAt,
  });
}

async function writeResponse(scope: BaseScope, rows: BaseRowData[], replay: boolean, includeArchivedAt = false) {
  const projected = rows.map((row) => projectDirect(scope, row, includeArchivedAt));
  const users = await findUserRefs(db, referencedUserIds(projected, directColumns(scope.properties)));
  return { projected, users, replay };
}

export async function queryRowsDirect(scope: BaseScope, body: unknown): Promise<BaseQueryResponse> {
  requireDirect(scope, "rows.query");
  const request = parseBasesBody(baseQueryRequestSchema, body);
  if (request.asUserId !== undefined) payloadInvalid("asUserId is only available on view queries.");
  const ctx = compileContext(scope);
  const includeBody = request.includeBody === true;
  const includeArchived = request.includeArchived === true;
  const columns = [...directColumns(scope.properties), ...(includeBody ? [{ ref: "body" as const, key: "body" as const, kind: "body" as const }] : [])];
  return queryRowsPage({
    scope,
    cursorScope: `base:${scope.base.id}`,
    viewVersion: 0,
    policySql: null,
    requestFilter: request.filter,
    filterCtx: ctx,
    searchSql: request.search ? compileBaseSearch(request.search, baseCompileColumns(scope.properties)) : null,
    sort: request.sort,
    sortCtx: ctx,
    columns,
    includeBody,
    includeArchived,
    limit: request.limit ?? BASES_LIMITS.queryLimitDefault,
    cursor: request.cursor,
    hashParts: {
      filter: request.filter ?? null,
      sort: request.sort ?? null,
      includeBody,
      includeArchived,
      ...(request.search ? { search: request.search } : {}),
    },
  });
}

export async function aggregateRowsDirect(scope: BaseScope, body: unknown): Promise<BaseAggregateResponse> {
  requireDirect(scope);
  const request = parseBasesBody(baseAggregateRequestSchema, body) as BaseAggregateRequest;
  const result = await runAggregate({ scope, request, ctx: compileContext(scope), policySql: null });
  const groups = result.groups.map(({ keys, values }) => ({ keys, values }));
  return { groups, suppressedGroups: 0, users: await aggregateUsers(result.dimensions, groups) };
}

export async function createRowsDirect(
  scope: BaseScope,
  body: unknown,
  headerKey: string | null,
): Promise<{ status: number; payload: BaseRowWriteResponse | BaseRowBatchWriteResponse }> {
  requireDirect(scope, "rows.create");
  const input = parseBasesBody(baseCreateRowsSchema, body);
  const idempotencyKey = resolveBaseIdempotencyKey(input.idempotencyKey, headerKey);
  const batch = "rows" in input;
  const rows = batch ? input.rows : [{ values: input.values, body: input.body }];
  const outcome = await createRows({
    scope,
    target: { kind: "direct" },
    rows,
    batch,
    operation: "console.bases.rows.create",
    idempotencyKey,
  });
  const { projected, users, replay } = await writeResponse(scope, outcome.rows, outcome.replay);
  const status = replay ? 200 : 201;
  if (batch) return { status, payload: { rows: projected, users, idempotentReplay: replay } };
  const row = projected[0];
  if (!row) notFound();
  return { status, payload: { row, users, idempotentReplay: replay } };
}

export async function getRowDirect(scope: BaseScope, rowId: string, includeArchived: boolean): Promise<BaseRowWriteResponse> {
  requireDirect(scope);
  const record = await findRowRecord(db, { organizationId: scope.base.organizationId, baseId: scope.base.id, rowId });
  if (!record || (record.archivedAt && !includeArchived)) notFound();
  const { projected, users } = await writeResponse(scope, [rowDataFromRecord(record)], false, includeArchived);
  const row = projected[0];
  if (!row) notFound();
  return { row, users, idempotentReplay: false };
}

export async function updateRowDirect(scope: BaseScope, rowId: string, body: unknown, headerKey: string | null): Promise<BaseRowWriteResponse> {
  requireDirect(scope, "rows.update");
  const input = parseBasesBody(baseUpdateRowSchema, body);
  const idempotencyKey = resolveBaseIdempotencyKey(input.idempotencyKey, headerKey);
  const outcome = await updateRow({
    scope,
    target: { kind: "direct" },
    rowId,
    values: input.values,
    body: input.body,
    expectedVersion: input.expectedVersion,
    lastWriteWins: input.lastWriteWins === true,
    operation: "console.bases.rows.update",
    idempotencyKey,
    project: (row) => projectDirect(scope, row),
  });
  const { projected, users, replay } = await writeResponse(scope, outcome.rows, outcome.replay);
  const row = projected[0];
  if (!row) notFound();
  return { row, users, idempotentReplay: replay };
}

export async function changeRowLifecycleDirect(
  scope: BaseScope,
  rowId: string,
  action: "archive" | "restore",
  body: unknown,
): Promise<BaseRowWriteResponse> {
  requireDirect(scope);
  const input = parseBasesBody(baseRowLifecycleSchema, body);
  const row = await changeRowLifecycle({
    scope,
    target: { kind: "direct" },
    rowId,
    action,
    expectedVersion: input.expectedVersion,
    lastWriteWins: input.lastWriteWins === true,
    project: (current) => projectDirect(scope, current, true),
  });
  const { projected, users } = await writeResponse(scope, [row], false, true);
  const projectedRow = projected[0];
  if (!projectedRow) notFound();
  return { row: projectedRow, users, idempotentReplay: false };
}

/** `POST rows/<row>/agent/<prop>`: an agent stores its value or error (SPEC "Agent Property"). Returns the row as a direct read. */
export async function fillAgentDirect(
  scope: BaseScope,
  rowId: string,
  propertyRef: string,
  body: unknown,
  headerKey: string | null,
): Promise<BaseRowWriteResponse> {
  requireDirect(scope);
  const input = parseBasesBody(baseAgentFillSchema, body);
  const idempotencyKey = resolveBaseIdempotencyKey(input.idempotencyKey, headerKey);
  const property = resolveAgentProperty(scope, propertyRef);
  const outcome = await fillAgentValue({
    scope,
    rowId,
    property,
    inputsHash: input.inputsHash,
    outcome: input.error !== undefined ? { error: input.error } : { value: input.value },
    idempotencyKey,
  });
  return agentWriteResponse(scope, outcome.row, outcome.replay);
}

/** `POST rows/<row>/agent/<prop>/rerun`: asks for the agent value again (pending + `bases.agent.requested`). */
export async function rerunAgentDirect(
  scope: BaseScope,
  rowId: string,
  propertyRef: string,
  body: unknown,
  headerKey: string | null,
): Promise<BaseRowWriteResponse> {
  requireDirect(scope);
  const input = parseBasesBody(baseAgentRerunSchema, body ?? {});
  const hasKey = Boolean(input.idempotencyKey?.trim() || headerKey?.trim());
  const idempotencyKey = hasKey ? resolveBaseIdempotencyKey(input.idempotencyKey, headerKey) : null;
  const property = resolveAgentProperty(scope, propertyRef);
  const outcome = await rerunAgentValue({ scope, rowId, property, idempotencyKey });
  return agentWriteResponse(scope, outcome.row, outcome.replay);
}

async function agentWriteResponse(scope: BaseScope, record: BaseRowRecord, replay: boolean): Promise<BaseRowWriteResponse> {
  const { projected, users } = await writeResponse(scope, [rowDataFromRecord(record)], replay);
  const row = projected[0];
  if (!row) notFound();
  return { row, users, idempotentReplay: replay };
}

export async function purgeRowDirect(scope: BaseScope, rowId: string, body: unknown) {
  requireDirect(scope);
  parseBasesBody(baseRowPurgeSchema, body);
  return purgeRow({ scope, rowId });
}

export async function rowHistoryDirect(scope: BaseScope, rowId: string, searchParams: URLSearchParams): Promise<BaseRowHistoryResponse> {
  requireDirect(scope);
  const [latest] = await loadLedgerPage(db, { baseId: scope.base.id, rowId: rowId.toLowerCase(), beforeSequence: null, limit: 1 });
  if (!latest) notFound();
  return historyPage({
    scope,
    rowId,
    cursorScope: `base-history:${scope.base.id}`,
    viewVersion: 0,
    cursor: searchParams.get("cursor"),
    limit: historyLimit(searchParams),
    visibility: { propertyIds: null, bodyVisible: true, skipInvisibleUpdates: false },
    propertiesById: scope.propertiesById,
  });
}

export function historyLimit(searchParams: URLSearchParams) {
  const raw = searchParams.get("limit");
  if (raw === null || raw === "") return BASES_LIMITS.historyLimitDefault;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > BASES_LIMITS.historyLimitMax) {
    return Math.min(Math.max(Number.isFinite(parsed) ? Math.trunc(parsed) : BASES_LIMITS.historyLimitDefault, 1), BASES_LIMITS.historyLimitMax);
  }
  return parsed;
}
