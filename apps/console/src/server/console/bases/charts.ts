import { assertCurrentBasesManagement } from "./access";
// Charts: a view plus a Vega-Lite subset encoding (SPEC "Charts"). Fields
// must be columns of the chart's view; aggregation runs on the server through
// the Query AST and the client receives groups only. Aggregate-mode callers
// get groups with at least 5 rows.

import { and, eq, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import { BASES_LIMITS } from "@/shared/bases/limits";
import { isBaseSystemColumn } from "@/shared/bases/operators";
import {
  baseCreateChartSchema,
  baseUpdateChartSchema,
  baseVersionedLifecycleSchema,
} from "@/shared/bases/schemas";
import type {
  BaseAggregateRequest,
  BaseChart,
  BaseChartDataResponse,
  BaseChartDatum,
  BaseChartEncoding,
  BaseChartFieldDef,
  BaseChartMarkType,
  BaseChartPublic,
  BaseChartSpec,
  BaseTimeUnit,
  BaseViewColumn,
} from "@/shared/bases/types";

import type { ViewAdmission } from "./access";
import { insertBasesAudit } from "./audit";
import { compileBaseAggregate, type BaseCompileContext } from "./compiler";
import { basesError, conflict, forbidden, isConsoleApiError, limitExceeded, notFound, parseBasesBody, validationFailed } from "./errors";
import { aggregateUsers, runAggregate } from "./reads";
import { baseCreateRequestHash, completeBaseOperation, reserveBaseCreateOperation, resolveOptionalBaseIdempotencyKey } from "./idempotency";
import { findChartRecord, findViewRecord, loadChartRecords, lockBaseRecord, type BaseChartRecord, type BasesTx } from "./repository";
import { viewPolicySql } from "./row-writes";
import { assertWritable, compileContext, type BaseScope } from "./scope";
import { BASE_BODY_REF, toIso, viewColumnDescriptor } from "./serialize";
import { parseStoredView, viewAdmission, type ParsedView } from "./view-model";
import { assertViewUsable } from "./views";

export const BASE_CHART_CHANNELS = ["x", "y", "color", "theta", "text"] as const;
export type BaseChartChannel = (typeof BASE_CHART_CHANNELS)[number];

export type ParsedChart = { record: BaseChartRecord; spec: BaseChartSpec };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseStoredChart(record: BaseChartRecord): ParsedChart {
  const raw = isRecord(record.specJson) ? record.specJson : {};
  const encoding = isRecord(raw.encoding) ? (raw.encoding as BaseChartEncoding) : {};
  const mark = (typeof raw.mark === "string" || isRecord(raw.mark) ? raw.mark : "bar") as BaseChartSpec["mark"];
  const spec: BaseChartSpec = { mark, encoding };
  if (typeof raw.title === "string") spec.title = raw.title;
  return { record, spec };
}

export function chartMarkType(spec: BaseChartSpec): BaseChartMarkType {
  return typeof spec.mark === "string" ? spec.mark : spec.mark.type;
}

function mapEncodingFields(encoding: BaseChartEncoding, map: (field: string) => string): BaseChartEncoding {
  const out: BaseChartEncoding = {};
  for (const channel of BASE_CHART_CHANNELS) {
    const def = encoding[channel];
    if (!def) continue;
    out[channel] = def.field === undefined ? { ...def } : { ...def, field: map(def.field) };
  }
  return out;
}

function refToKey(scope: BaseScope, ref: string) {
  return scope.propertiesById.get(ref)?.key ?? ref;
}

function specToApi(spec: BaseChartSpec, scope: BaseScope): BaseChartSpec {
  return { ...spec, encoding: mapEncodingFields(spec.encoding, (ref) => refToKey(scope, ref)) };
}

export function chartToApi(chart: ParsedChart, scope: BaseScope): BaseChart {
  return {
    id: chart.record.id,
    baseId: chart.record.baseId,
    viewId: chart.record.viewId,
    name: chart.record.name,
    description: chart.record.description,
    spec: specToApi(chart.spec, scope),
    position: chart.record.position,
    version: chart.record.version,
    status: chart.record.status === "archived" ? "archived" : "active",
    createdAt: toIso(chart.record.createdAt) ?? "",
    updatedAt: toIso(chart.record.updatedAt) ?? "",
  };
}

/**
 * Public spec: fields that are no longer active columns of the chart's view
 * (its columns shrank or a property was deleted) are dropped, so the spec
 * never names a non-projected property. Such a chart's data is `view_invalid`.
 */
function specToPublic(spec: BaseChartSpec, scope: BaseScope, view: ParsedView): BaseChartSpec {
  const projected = new Set(view.columns);
  const encoding: BaseChartEncoding = {};
  for (const channel of BASE_CHART_CHANNELS) {
    const def = spec.encoding[channel];
    if (!def) continue;
    if (def.field === undefined) {
      encoding[channel] = { ...def };
      continue;
    }
    const property = scope.propertiesById.get(def.field);
    const visible = projected.has(def.field) && (isBaseSystemColumn(def.field) || (property !== undefined && !property.deletedAt));
    if (visible) encoding[channel] = { ...def, field: refToKey(scope, def.field) };
    else {
      const rest: BaseChartFieldDef = { ...def };
      delete rest.field;
      encoding[channel] = rest;
    }
  }
  return { ...spec, encoding };
}

export function chartToPublic(chart: ParsedChart, scope: BaseScope, view: ParsedView): BaseChartPublic {
  return {
    id: chart.record.id,
    baseId: chart.record.baseId,
    viewId: chart.record.viewId,
    name: chart.record.name,
    description: chart.record.description,
    spec: specToPublic(chart.spec, scope, view),
    version: chart.record.version,
  };
}

// ---------------------------------------------------------------------------
// Encoding -> aggregation

type ChannelPlan =
  | { channel: BaseChartChannel; role: "dimension"; index: number; key: string }
  | { channel: BaseChartChannel; role: "measure"; as: string };

export type ChartAggregatePlan = {
  request: BaseAggregateRequest;
  channels: ChannelPlan[];
  /** Field refs or keys used by the encoding. */
  fields: string[];
};

/**
 * Channels without `aggregate` become group-by dimensions (shared when two
 * channels use the same field and time unit); channels with `aggregate`
 * become measures named after the channel. `count` needs no field.
 */
export function chartAggregatePlan(encoding: BaseChartEncoding): ChartAggregatePlan {
  const groupBy: Array<{ prop: string; timeUnit?: BaseTimeUnit }> = [];
  const aggregate: BaseAggregateRequest["aggregate"] = [];
  const channels: ChannelPlan[] = [];
  const fields: string[] = [];
  for (const channel of BASE_CHART_CHANNELS) {
    const def = encoding[channel];
    if (!def) continue;
    if (def.field !== undefined && !fields.includes(def.field)) fields.push(def.field);
    if (def.aggregate) {
      aggregate.push(def.aggregate === "count" ? { op: "count", as: channel } : { op: def.aggregate, prop: def.field ?? "", as: channel });
      channels.push({ channel, role: "measure", as: channel });
      continue;
    }
    const prop = def.field ?? "";
    let index = groupBy.findIndex((entry) => entry.prop === prop && entry.timeUnit === def.timeUnit);
    if (index < 0) {
      groupBy.push(def.timeUnit ? { prop, timeUnit: def.timeUnit } : { prop });
      index = groupBy.length - 1;
    }
    channels.push({ channel, role: "dimension", index, key: prop });
  }
  return { request: { groupBy, aggregate }, channels, fields };
}

/** Structural chart rules: fields present, at least one measure, theta only with arc. */
export function chartSpecErrors(spec: BaseChartSpec): Record<string, string> {
  const errors: Record<string, string> = {};
  const mark = chartMarkType(spec);
  let measures = 0;
  for (const channel of BASE_CHART_CHANNELS) {
    const def: BaseChartFieldDef | undefined = spec.encoding[channel];
    if (!def) continue;
    if (def.aggregate) measures += 1;
    if (def.field === undefined && def.aggregate !== "count") errors[`spec.encoding.${channel}.field`] = "A field is required unless the aggregate is count.";
    if (def.field === BASE_BODY_REF) errors[`spec.encoding.${channel}.field`] = "The body cannot be charted.";
  }
  if (!measures) errors["spec.encoding"] = "Charts need at least one aggregated channel.";
  if (spec.encoding.theta && mark !== "arc") errors["spec.encoding.theta"] = "theta is only valid with the arc mark.";
  if (mark === "arc" && !spec.encoding.theta) errors["spec.encoding.theta"] = "Arc charts need a theta channel.";
  return errors;
}

function chartCompileContext(scope: BaseScope, view: ParsedView): BaseCompileContext {
  return compileContext(scope, { allowed: view.columns.filter((ref) => ref !== BASE_BODY_REF) });
}

/** Validates an API spec against the view and returns its storage form (fields as refs). */
export function normalizeChartSpec(scope: BaseScope, view: ParsedView, spec: BaseChartSpec): BaseChartSpec {
  const errors = chartSpecErrors(spec);
  if (Object.keys(errors).length) validationFailed(errors);
  const ctx = chartCompileContext(scope, view);
  const plan = chartAggregatePlan(spec.encoding);
  compileBaseAggregate(plan.request, ctx, { organizationId: scope.base.organizationId });
  const encoding = mapEncodingFields(spec.encoding, (field) => {
    const column = ctx.resolve(field);
    if (!column) throw basesError(400, { error: "unknown_property", reason: `Unknown property "${field}".` });
    return column.ref;
  });
  const stored: BaseChartSpec = { mark: spec.mark, encoding };
  if (spec.title !== undefined) stored.title = spec.title;
  return stored;
}

// ---------------------------------------------------------------------------
// Loading

function requireManage(scope: BaseScope) {
  if (!scope.access.manage) forbidden("Managing charts needs project write access.");
}

async function loadChartView(scope: BaseScope, viewId: string) {
  const record = await findViewRecord(db, { baseId: scope.base.id, viewId });
  if (!record) return null;
  const view = parseStoredView(record);
  return { view, admission: viewAdmission(view, scope) };
}

function canReadChart(scope: BaseScope, view: ParsedView, admission: ViewAdmission) {
  if (scope.access.manage) return true;
  return view.record.status === "active" && (admission.read || admission.aggregateOnly);
}

export type LoadedChart = { chart: ParsedChart; view: ParsedView; admission: ViewAdmission };

/**
 * Loads a chart the caller can read (managers: any; others: view read or
 * aggregate mode). A view that does not admit the caller is `404 not_found`;
 * a caller the view admits only to write is `403 base_forbidden`.
 */
export async function loadChartForCaller(scope: BaseScope, chartId: string): Promise<LoadedChart> {
  const record = await findChartRecord(db, { baseId: scope.base.id, chartId });
  if (!record) notFound();
  if (record.status !== "active" && !scope.access.manage) notFound();
  const loaded = await loadChartView(scope, record.viewId);
  if (!loaded) notFound();
  if (!canReadChart(scope, loaded.view, loaded.admission)) {
    if (loaded.view.record.status === "active" && loaded.admission.admitted) forbidden("This view does not grant row or aggregate reads.");
    notFound();
  }
  return { chart: parseStoredChart(record), view: loaded.view, admission: loaded.admission };
}

export async function listCharts(scope: BaseScope, options: { includeArchived?: boolean } = {}) {
  const records = await loadChartRecords(db, scope.base.id, { includeArchived: scope.access.manage && options.includeArchived === true });
  const charts: Array<BaseChart | BaseChartPublic> = [];
  const views = new Map<string, Awaited<ReturnType<typeof loadChartView>>>();
  for (const record of records) {
    if (!views.has(record.viewId)) views.set(record.viewId, await loadChartView(scope, record.viewId));
    const loaded = views.get(record.viewId);
    if (!loaded || !canReadChart(scope, loaded.view, loaded.admission)) continue;
    const chart = parseStoredChart(record);
    charts.push(scope.access.manage ? chartToApi(chart, scope) : chartToPublic(chart, scope, loaded.view));
  }
  return { charts };
}

export async function getChart(scope: BaseScope, chartId: string): Promise<BaseChart | BaseChartPublic> {
  const { chart, view } = await loadChartForCaller(scope, chartId);
  return scope.access.manage ? chartToApi(chart, scope) : chartToPublic(chart, scope, view);
}

// ---------------------------------------------------------------------------
// Mutations

async function activeViewOf(scope: BaseScope, viewId: string) {
  const loaded = await loadChartView(scope, viewId);
  if (!loaded || loaded.view.record.status !== "active") validationFailed({ viewId: "Charts must reference an active view of this base." });
  return loaded.view;
}

function chartAuditMetadata(chart: { id: string; version: number; viewId: string }, spec?: BaseChartSpec) {
  return {
    chartId: chart.id,
    viewId: chart.viewId,
    version: chart.version,
    ...(spec ? { mark: chartMarkType(spec), channels: BASE_CHART_CHANNELS.filter((channel) => spec.encoding[channel]) } : {}),
  };
}

const CHART_CREATE_OPERATION = "console.bases.charts.create";

/** Creates a chart (201). With an idempotency key the same key and request replay the created chart (200). */
export async function createChart(scope: BaseScope, body: unknown, headerKey: string | null = null): Promise<{ status: number; payload: BaseChart }> {
  requireManage(scope);
  assertWritable(scope);
  const input = parseBasesBody(baseCreateChartSchema, body);
  const idempotencyKey = resolveOptionalBaseIdempotencyKey(input.idempotencyKey, headerKey);
  const view = await activeViewOf(scope, input.viewId);
  const spec = normalizeChartSpec(scope, view, input.spec as BaseChartSpec);
  const record = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
    const locked = await lockBaseRecord(tx, scope.base.id, "update");
    if (!locked || locked.status !== "active") notFound();
    const reservation = idempotencyKey
      ? await reserveBaseCreateOperation(tx, {
          caller: scope.caller,
          base: scope.base,
          operation: CHART_CREATE_OPERATION,
          key: idempotencyKey,
          requestHash: baseCreateRequestHash(CHART_CREATE_OPERATION, scope.base.id, input),
        })
      : null;
    if (reservation?.replay) {
      const replayed = await findChartRecord(tx, { baseId: scope.base.id, chartId: reservation.replay.createdId });
      if (!replayed) notFound();
      return { kind: "replayed" as const, record: replayed };
    }
    const [counts] = await tx
      .select({ count: sql<number>`count(*)::int`, maxPosition: sql<number | null>`max(${schema.baseCharts.position})` })
      .from(schema.baseCharts)
      .where(and(eq(schema.baseCharts.baseId, scope.base.id), eq(schema.baseCharts.status, "active")));
    if (Number(counts?.count ?? 0) >= BASES_LIMITS.chartsPerBase) limitExceeded(`A base has at most ${BASES_LIMITS.chartsPerBase} charts.`);
    const [created] = await tx
      .insert(schema.baseCharts)
      .values({
        baseId: scope.base.id,
        viewId: view.record.id,
        organizationId: scope.base.organizationId,
        projectId: scope.base.projectId,
        name: input.name,
        description: input.description ?? null,
        specJson: spec as unknown as JsonRecord,
        position: input.position ?? Number(counts?.maxPosition ?? -1) + 1,
        createdByActorType: scope.caller.actorType,
        createdByActorId: scope.caller.actorId,
        updatedByActorType: scope.caller.actorType,
        updatedByActorId: scope.caller.actorId,
      })
      .returning();
    if (!created) throw new Error("Failed to create chart.");
    await insertBasesAudit(tx, {
      caller: scope.caller,
      organizationId: scope.base.organizationId,
      projectId: scope.base.projectId,
      targetType: "base_chart",
      targetId: created.id,
      action: "bases.chart.created",
      metadata: { baseId: scope.base.id, ...chartAuditMetadata(created, spec) },
    });
    if (reservation) await completeBaseOperation(tx, reservation.id, { createdId: created.id });
    return { kind: "created" as const, record: created };
  });
  return { status: record.kind === "replayed" ? 200 : 201, payload: chartToApi(parseStoredChart(record.record), scope) };
}

async function selectChartForUpdate(tx: BasesTx, scope: BaseScope, chartId: string, expectedVersion: number) {
  const [record] = await tx
    .select()
    .from(schema.baseCharts)
    .where(and(eq(schema.baseCharts.baseId, scope.base.id), eq(schema.baseCharts.id, chartId)))
    .limit(1)
    .for("update");
  if (!record) notFound();
  if (record.version !== expectedVersion) conflict("version_conflict", { reason: "The chart changed since it was read." });
  return record;
}

export async function updateChart(scope: BaseScope, chartId: string, body: unknown): Promise<BaseChart> {
  requireManage(scope);
  assertWritable(scope);
  const input = parseBasesBody(baseUpdateChartSchema, body);
  const existing = await findChartRecord(db, { baseId: scope.base.id, chartId });
  if (!existing) notFound();
  const parsed = parseStoredChart(existing);
  const view = await activeViewOf(scope, input.viewId ?? existing.viewId);
  const specInput = (input.spec as BaseChartSpec | undefined) ?? specToApi(parsed.spec, scope);
  const spec = normalizeChartSpec(scope, view, specInput);
  const record = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
    const current = await selectChartForUpdate(tx, scope, existing.id, input.expectedVersion);
    const [updated] = await tx
      .update(schema.baseCharts)
      .set({
        viewId: view.record.id,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        specJson: spec as unknown as JsonRecord,
        version: current.version + 1,
        updatedByActorType: scope.caller.actorType,
        updatedByActorId: scope.caller.actorId,
        updatedAt: new Date(),
      })
      .where(eq(schema.baseCharts.id, current.id))
      .returning();
    if (!updated) notFound();
    await insertBasesAudit(tx, {
      caller: scope.caller,
      organizationId: scope.base.organizationId,
      projectId: scope.base.projectId,
      targetType: "base_chart",
      targetId: updated.id,
      action: "bases.chart.updated",
      metadata: { baseId: scope.base.id, ...chartAuditMetadata(updated, spec) },
    });
    return updated;
  });
  return chartToApi(parseStoredChart(record), scope);
}

export async function archiveChart(scope: BaseScope, chartId: string, body: unknown): Promise<BaseChart> {
  requireManage(scope);
  assertWritable(scope);
  const input = parseBasesBody(baseVersionedLifecycleSchema, body);
  const existing = await findChartRecord(db, { baseId: scope.base.id, chartId });
  if (!existing) notFound();
  const record = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
    const current = await selectChartForUpdate(tx, scope, existing.id, input.expectedVersion);
    if (current.status === "archived") return current;
    const [updated] = await tx
      .update(schema.baseCharts)
      .set({
        status: "archived",
        version: current.version + 1,
        updatedByActorType: scope.caller.actorType,
        updatedByActorId: scope.caller.actorId,
        updatedAt: new Date(),
      })
      .where(eq(schema.baseCharts.id, current.id))
      .returning();
    if (!updated) notFound();
    await insertBasesAudit(tx, {
      caller: scope.caller,
      organizationId: scope.base.organizationId,
      projectId: scope.base.projectId,
      targetType: "base_chart",
      targetId: updated.id,
      action: "bases.chart.archived",
      metadata: { baseId: scope.base.id, ...chartAuditMetadata(updated) },
    });
    return updated;
  });
  return chartToApi(parseStoredChart(record), scope);
}

// ---------------------------------------------------------------------------
// Data

export async function chartDataForLoaded(scope: BaseScope, loaded: LoadedChart): Promise<BaseChartDataResponse> {
  const { chart, view, admission } = loaded;
  assertViewUsable(scope, view);
  if (chart.record.status !== "active") throw basesError(409, { error: "view_invalid", reason: "This chart is archived." });
  const ctx = chartCompileContext(scope, view);
  const plan = chartAggregatePlan(chart.spec.encoding);
  const policySql = viewPolicySql(scope, view);
  let result: Awaited<ReturnType<typeof runAggregate>>;
  try {
    result = await runAggregate({ scope, request: plan.request, ctx, policySql });
  } catch (error) {
    if (isConsoleApiError(error, "unknown_property") || isConsoleApiError(error, "invalid_filter")) {
      throw basesError(409, { error: "view_invalid", reason: "This chart references a column its view no longer has." });
    }
    throw error;
  }
  const suppress = admission.aggregateOnly && !scope.access.manage;
  const visible = suppress ? result.groups.filter((group) => group.count >= BASES_LIMITS.aggregateMinGroupSize) : result.groups;
  const data: BaseChartDatum[] = visible.map((group) => {
    const datum: BaseChartDatum = {};
    for (const channel of plan.channels) {
      if (channel.role === "measure") {
        const value = group.values[channel.as];
        datum[channel.channel] = value === undefined ? null : value;
      } else {
        const dimension = result.dimensions[channel.index];
        datum[channel.channel] = dimension ? (group.keys[dimension.key] ?? null) : null;
      }
    }
    return datum;
  });
  const fields: Record<string, BaseViewColumn> = {};
  for (const field of plan.fields) {
    const column = ctx.resolve(field);
    if (!column) continue;
    fields[column.key] = column.property
      ? viewColumnDescriptor({ ref: column.ref, key: column.key, kind: "property", property: column.property })
      : viewColumnDescriptor({ ref: column.kind as "created_time", key: column.kind as "created_time", kind: "system" });
  }
  return {
    chart: chartToPublic(chart, scope, view),
    fields,
    data,
    suppressedGroups: result.groups.length - visible.length,
    users: await aggregateUsers(result.dimensions, visible),
  };
}

export async function chartData(scope: BaseScope, chartId: string, body: unknown): Promise<BaseChartDataResponse> {
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)) {
    validationFailed({ body: "Chart data takes no request parameters." });
  }
  return chartDataForLoaded(scope, await loadChartForCaller(scope, chartId));
}
