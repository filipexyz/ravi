// Entry points for callers outside the Bases HTTP envelopes (Ravi Pages
// connector actions `ravi.bases.*`). Each resolves the view or chart by id
// within `caller.organizationId` and the given project (read through
// `findAccessibleProjectRecord`), then applies the same view admission as the
// API. Pages callers are admitted only by `page_viewer` principals for their
// site.

import { and, eq } from "drizzle-orm";

import { db, schema } from "@/server/db";
import type { BaseFilter, BaseSort } from "@/shared/bases/types";
import type {
  BaseChartDataResponse,
  BaseQueryResponse,
  BaseRowWriteResponse,
  BaseViewDescribeResponse,
  BaseViewVersionResponse,
} from "@/shared/bases/types";
import { isBaseUuid } from "@/shared/bases/values";

import { chartDataForLoaded, loadChartForCaller } from "./charts";
import type { BasesCaller } from "./context";
import { notFound } from "./errors";
import { resolveBaseScope, resolveBasesProject, type BaseScope } from "./scope";
import {
  archiveRowThroughView,
  createRowThroughLoadedView,
  describeLoadedView,
  getRowThroughView,
  loadViewForCaller,
  queryThroughLoadedView,
  updateRowThroughLoadedView,
  viewVersionForLoaded,
} from "./views";

export type BasesViewTarget = { projectId: string; viewId: string };

async function scopeForEntity(caller: BasesCaller, projectId: string, entity: "view" | "chart", id: string): Promise<BaseScope> {
  if (!isBaseUuid(id)) notFound();
  const projectScope = await resolveBasesProject({ caller, workspace: null, projectRef: projectId });
  const ref = id.toLowerCase();
  const [record] =
    entity === "view"
      ? await db
          .select({ baseId: schema.baseViews.baseId })
          .from(schema.baseViews)
          .where(
            and(
              eq(schema.baseViews.id, ref),
              eq(schema.baseViews.organizationId, caller.organizationId),
              eq(schema.baseViews.projectId, projectScope.project.id),
            ),
          )
          .limit(1)
      : await db
          .select({ baseId: schema.baseCharts.baseId })
          .from(schema.baseCharts)
          .where(
            and(
              eq(schema.baseCharts.id, ref),
              eq(schema.baseCharts.organizationId, caller.organizationId),
              eq(schema.baseCharts.projectId, projectScope.project.id),
            ),
          )
          .limit(1);
  if (!record) notFound();
  return resolveBaseScope(projectScope, record.baseId);
}

/** `ravi.bases.views.describe`: the view public shape (managers also get `view`). */
export async function describeViewForCaller(caller: BasesCaller, input: BasesViewTarget): Promise<BaseViewDescribeResponse> {
  const scope = await scopeForEntity(caller, input.projectId, "view", input.viewId);
  return describeLoadedView(scope, await loadViewForCaller(scope, input.viewId, "admitted"));
}

/** `ravi.bases.views.query`. */
export async function queryViewForCaller(
  caller: BasesCaller,
  input: BasesViewTarget & {
    filter?: BaseFilter | null;
    sort?: BaseSort[];
    limit?: number;
    cursor?: string | null;
    includeBody?: boolean;
    search?: string;
  },
): Promise<BaseQueryResponse> {
  const scope = await scopeForEntity(caller, input.projectId, "view", input.viewId);
  const loaded = await loadViewForCaller(scope, input.viewId, "read");
  return queryThroughLoadedView(scope, loaded, {
    ...(input.filter !== undefined ? { filter: input.filter } : {}),
    ...(input.sort !== undefined ? { sort: input.sort } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(input.includeBody !== undefined ? { includeBody: input.includeBody } : {}),
    ...(input.search !== undefined ? { search: input.search } : {}),
  });
}

/** `ravi.bases.views.version`: a fingerprint of the rows the caller sees through the view. */
export async function viewVersionForCaller(caller: BasesCaller, input: BasesViewTarget): Promise<BaseViewVersionResponse> {
  const scope = await scopeForEntity(caller, input.projectId, "view", input.viewId);
  return viewVersionForLoaded(scope, await loadViewForCaller(scope, input.viewId, "read"));
}

/** `ravi.bases.views.rows.get`: one row through a view that grants row reads; outside the filter, archived, or missing is `404 not_found`. */
export async function getRowThroughViewForCaller(
  caller: BasesCaller,
  input: BasesViewTarget & { rowId: string },
): Promise<BaseRowWriteResponse> {
  if (!isBaseUuid(input.rowId)) notFound();
  const scope = await scopeForEntity(caller, input.projectId, "view", input.viewId);
  return getRowThroughView(scope, input.viewId, input.rowId);
}

/** `ravi.bases.views.rows.archive`: archives one row through a view that grants `archive` to the caller. */
export async function archiveRowThroughViewForCaller(
  caller: BasesCaller,
  input: BasesViewTarget & { rowId: string; expectedVersion?: number; lastWriteWins?: boolean },
): Promise<BaseRowWriteResponse> {
  if (!isBaseUuid(input.rowId)) notFound();
  const scope = await scopeForEntity(caller, input.projectId, "view", input.viewId);
  return archiveRowThroughView(scope, input.viewId, input.rowId, {
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    ...(input.lastWriteWins !== undefined ? { lastWriteWins: input.lastWriteWins } : {}),
  });
}

/** `ravi.bases.views.rows.create`: one row through the view. The response row carries `rowId` and `version`. */
export async function createRowThroughViewForCaller(
  caller: BasesCaller,
  input: BasesViewTarget & { values: Record<string, unknown>; body?: string | null; idempotencyKey: string },
): Promise<BaseRowWriteResponse> {
  const scope = await scopeForEntity(caller, input.projectId, "view", input.viewId);
  const loaded = await loadViewForCaller(scope, input.viewId, "create");
  const result = await createRowThroughLoadedView(
    scope,
    loaded,
    {
      values: input.values,
      ...(input.body !== undefined ? { body: input.body } : {}),
      idempotencyKey: input.idempotencyKey,
    },
    null,
  );
  return result.payload;
}

/** `ravi.bases.views.rows.update`: PATCH through the view; returns the row projected through it. */
export async function updateRowThroughViewForCaller(
  caller: BasesCaller,
  input: BasesViewTarget & {
    rowId: string;
    values?: Record<string, unknown>;
    body?: string | null;
    expectedVersion?: number;
    lastWriteWins?: boolean;
    idempotencyKey: string;
  },
): Promise<BaseRowWriteResponse> {
  const scope = await scopeForEntity(caller, input.projectId, "view", input.viewId);
  const loaded = await loadViewForCaller(scope, input.viewId, "write");
  return updateRowThroughLoadedView(
    scope,
    loaded,
    input.rowId,
    {
      ...(input.values !== undefined ? { values: input.values } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
      ...(input.lastWriteWins !== undefined ? { lastWriteWins: input.lastWriteWins } : {}),
      idempotencyKey: input.idempotencyKey,
    },
    null,
  );
}

/** `ravi.bases.charts.data`: aggregated groups only; aggregate-mode callers get groups of at least 5 rows. */
export async function chartDataForCaller(
  caller: BasesCaller,
  input: { projectId: string; chartId: string },
): Promise<BaseChartDataResponse> {
  const scope = await scopeForEntity(caller, input.projectId, "chart", input.chartId);
  return chartDataForLoaded(scope, await loadChartForCaller(scope, input.chartId));
}
