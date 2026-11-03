import { assertCurrentBasesManagement } from "./access";
import { assertBasesServiceOperation } from "./service-principal";
// Views: CRUD (`base.manage`), and reads and writes through a view for the
// principals it admits. See SPEC "Views", "Rules", "Writes Through A View".

import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { findAccessibleProjectRecord } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import { BASES_LIMITS } from "@/shared/bases/limits";
import {
  baseCreateRowsSchema,
  baseCreateViewSchema,
  baseQueryRequestSchema,
  baseRowLifecycleSchema,
  baseUpdateRowSchema,
  baseUpdateViewSchema,
  baseVersionedLifecycleSchema,
} from "@/shared/bases/schemas";
import type {
  BaseQueryResponse,
  BaseRow,
  BaseRowHistoryResponse,
  BaseRowWriteResponse,
  BaseView,
  BaseViewDescribeResponse,
  BaseViewingAs,
  BaseViewPublic,
  BaseViewVersionResponse,
} from "@/shared/bases/types";
import { isBaseUuid } from "@/shared/bases/values";
import { parseWidgetManifest, WIDGET_MANIFEST_FILE } from "@/shared/widgets/template/manifest";

import { loadBasesCallerAccess, type ViewAdmission } from "./access";
import { insertBasesAudit } from "./audit";
import { buildBaseRowMatchQuery, compileBaseSearch, type BaseCompileColumn, type BaseCompileContext } from "./compiler";
import type { BasesCaller } from "./context";
import { basesError, conflict, forbidden, limitExceeded, notFound, parseBasesBody, payloadInvalid, validationFailed } from "./errors";
import {
  baseCreateRequestHash,
  completeBaseOperation,
  reserveBaseCreateOperation,
  resolveBaseIdempotencyKey,
  resolveOptionalBaseIdempotencyKey,
} from "./idempotency";
import { historyPage, queryRowsPage, runBasesRead } from "./reads";
import {
  activeMemberIds,
  executeRows,
  findActiveMember,
  findChartRecord,
  findLayoutWidgetItem,
  findLibraryFileText,
  findRowRecord,
  findUserRefs,
  findViewRecord,
  libraryItemRef,
  lockBaseRecord,
  loadLibraryItemRefs,
  loadViewRecords,
  projectPageSiteIds,
  type BaseViewRecord,
  type BasesTx,
  type LayoutWidgetItem,
} from "./repository";
import { changeRowLifecycle, createRows, updateRow, viewPolicySql } from "./row-writes";
import { historyLimit } from "./rows";
import { assertWritable, compileContext, type BaseScope } from "./scope";
import { BASE_BODY_REF, projectRow, referencedUserIds, rowDataFromRecord, type BaseRowData } from "./serialize";
import {
  bindLayoutWidget,
  layoutWidget,
  normalizeViewSpec,
  parseStoredView,
  viewAdmission,
  viewProjectedColumns,
  viewToApi,
  viewInvalid,
  viewToPublic,
  viewValidity,
  widgetBindingErrors,
  type LayoutWidgetBinding,
  type NormalizedViewSpec,
  type ParsedView,
  type StoredViewWidget,
  type WidgetRefs,
} from "./view-model";

const emptyBodySchema = z.object({}).strict();

export type ViewRequirement = "admitted" | "read" | "chart" | "write" | "create" | "archive";

export type LoadedView = { view: ParsedView; admission: ViewAdmission };

function requireManage(scope: BaseScope) {
  if (!scope.access.manage) forbidden("Managing views needs project write access.");
}

/**
 * Loads a view of the base for the caller. Views that do not admit the caller
 * (and archived views for non-managers) are `404 not_found`; admitted callers
 * lacking the requirement get `403 base_forbidden`. Reads and writes through
 * an invalid or archived view are `409 view_invalid`.
 */
export async function loadViewForCaller(scope: BaseScope, viewId: string, requirement: ViewRequirement): Promise<LoadedView> {
  const record = await findViewRecord(db, { baseId: scope.base.id, viewId });
  if (!record) notFound();
  if (record.status !== "active" && !scope.access.manage) notFound();
  const view = parseStoredView(record);
  const admission = viewAdmission(view, scope);
  if (!admission.admitted) notFound();
  const allowed =
    requirement === "admitted" ||
    (requirement === "read" && admission.read) ||
    (requirement === "chart" && (admission.read || admission.aggregateOnly)) ||
    (requirement === "write" && admission.write) ||
    (requirement === "create" && admission.create) ||
    (requirement === "archive" && admission.archive);
  if (!allowed) forbidden(requirement === "read" ? "This view does not grant row reads." : "This view does not grant this write.");
  if (requirement !== "admitted") assertViewUsable(scope, view);
  return { view, admission };
}

export function assertViewUsable(scope: BaseScope, view: ParsedView) {
  if (view.record.status !== "active") throw basesError(409, { error: "view_invalid", reason: "This view is archived." });
  const validity = viewValidity(view, scope);
  if (!validity.valid) viewInvalid(scope, validity.reason);
}

/** Current refs of the Library widgets the views' layouts name. */
export async function loadWidgetRefs(scope: BaseScope, views: readonly ParsedView[]): Promise<WidgetRefs> {
  const itemIds = views.flatMap((view) => layoutWidget(view.layout)?.itemId ?? []);
  if (!itemIds.length) return new Map();
  return loadLibraryItemRefs(db, { organizationId: scope.base.organizationId, itemIds });
}

export function viewForCaller(view: ParsedView, scope: BaseScope, admission: ViewAdmission, widgetRefs: WidgetRefs): BaseView | BaseViewPublic {
  return scope.access.manage ? viewToApi(view, scope, widgetRefs, admission) : viewToPublic(view, scope, widgetRefs, admission);
}

export async function describeLoadedView(scope: BaseScope, loaded: LoadedView): Promise<BaseViewDescribeResponse> {
  const widgetRefs = await loadWidgetRefs(scope, [loaded.view]);
  const publicShape = viewToPublic(loaded.view, scope, widgetRefs, loaded.admission);
  return scope.access.manage ? { ...publicShape, view: viewToApi(loaded.view, scope, widgetRefs, loaded.admission) } : publicShape;
}

/** Manager response of a view create, update, or archive. */
async function savedViewToApi(scope: BaseScope, record: BaseViewRecord): Promise<BaseView> {
  const view = parseStoredView(record);
  return viewToApi(view, scope, await loadWidgetRefs(scope, [view]));
}

// ---------------------------------------------------------------------------
// CRUD

export async function listViews(scope: BaseScope, options: { includeArchived?: boolean } = {}) {
  assertBasesServiceOperation(scope, "view.list");
  const records = await loadViewRecords(db, [scope.base.id], { includeArchived: scope.access.manage && options.includeArchived === true });
  const admitted: LoadedView[] = [];
  for (const record of records) {
    const view = parseStoredView(record);
    const admission = viewAdmission(view, scope);
    if (admission.admitted) admitted.push({ view, admission });
  }
  const widgetRefs = await loadWidgetRefs(scope, admitted.map((loaded) => loaded.view));
  return { views: admitted.map((loaded): BaseView | BaseViewPublic => viewForCaller(loaded.view, scope, loaded.admission, widgetRefs)) };
}

export async function getView(scope: BaseScope, viewId: string): Promise<BaseViewDescribeResponse> {
  return describeLoadedView(scope, await loadViewForCaller(scope, viewId, "admitted"));
}

/**
 * Checks the Library item a request's `layout.widget` names (only when it is
 * saved; archiving or deleting it later leaves the view valid): it exists in
 * the base's organization, is a widget, is an org item or one of the base's
 * project, is not archived, and has a published version whose `widget.json`
 * accepts the mapping. Returns the binding to store, or null after recording
 * field errors.
 */
async function resolveLayoutWidget(
  scope: BaseScope,
  binding: LayoutWidgetBinding,
  fieldErrors: Record<string, string>,
): Promise<StoredViewWidget | null> {
  const where = { organizationId: scope.base.organizationId, projectId: scope.base.projectId };
  let byRef: LayoutWidgetItem | null = null;
  if (binding.ref !== null) {
    const parts = binding.ref.split("/");
    const slug = parts.length <= 2 ? parts[parts.length - 1] : undefined;
    const scopeRef = parts.length === 2 ? (parts[0] ?? "") : null;
    if (!slug || scopeRef === "") {
      fieldErrors["layout.widget.ref"] = "Name the widget as org/<slug>, <project-slug>/<slug>, or <slug>.";
      return null;
    }
    if (scopeRef !== null && scopeRef !== "org" && scopeRef !== scope.project.slug && scopeRef !== scope.project.id) {
      fieldErrors["layout.widget.ref"] = `Widget "${binding.ref}" is not visible to this base: use an organization widget or one of project "${scope.project.slug}".`;
      return null;
    }
    byRef = await findLayoutWidgetItem(db, { ...where, slug, scope: scopeRef === null ? "visible" : scopeRef === "org" ? "org" : "project" });
    if (!byRef) {
      fieldErrors["layout.widget.ref"] = `No widget "${binding.ref}" in the Library of this project.`;
      return null;
    }
  }
  let item = byRef;
  if (binding.itemId !== null) {
    const byId = await findLayoutWidgetItem(db, { ...where, itemId: binding.itemId });
    if (!byId) {
      fieldErrors["layout.widget.itemId"] = "No Library item with this id in this organization.";
      return null;
    }
    if (byRef && byRef.id !== byId.id) {
      fieldErrors["layout.widget.ref"] = "itemId and ref name different Library items: send one of them.";
      return null;
    }
    item = byId;
  }
  if (!item) return null;
  const field = binding.itemId !== null ? "layout.widget.itemId" : "layout.widget.ref";
  const ref = libraryItemRef(item);
  // Another project's item is not named: its project may be closed to the caller.
  if (item.projectId !== null && item.projectId !== scope.base.projectId) {
    fieldErrors[field] = `This Library item belongs to another project: use an organization widget or one of project "${scope.project.slug}".`;
  } else if (item.kind !== "widget") fieldErrors[field] = `Library item "${ref}" is a ${item.kind}, not a widget.`;
  else if (item.archived) fieldErrors[field] = `Widget "${ref}" is archived.`;
  else if (!item.currentVersionId) fieldErrors[field] = `Widget "${ref}" has no published version.`;
  else {
    const text = await findLibraryFileText(db, { versionId: item.currentVersionId, path: WIDGET_MANIFEST_FILE });
    const errors = widgetBindingErrors(parseWidgetManifest(text ?? undefined).manifest, binding);
    if (!Object.keys(errors).length) return { itemId: item.id, fields: binding.fields, variant: binding.variant };
    Object.assign(fieldErrors, errors);
  }
  return null;
}

/** Async save-time checks; returns the spec with `layout.widget` bound. */
async function resolveViewReferences(scope: BaseScope, spec: NormalizedViewSpec): Promise<NormalizedViewSpec> {
  const fieldErrors: Record<string, string> = {};
  if (spec.memberIds.size) {
    const members = await activeMemberIds(db, scope.base.organizationId, spec.memberIds);
    const missing = [...spec.memberIds].filter((id) => !members.has(id));
    if (missing.length) fieldErrors["access"] = "Every user principal and person preset must be an active member of this organization.";
  }
  if (spec.siteIds.size) {
    const sites = await projectPageSiteIds(db, { projectId: scope.base.projectId, siteIds: [...spec.siteIds] });
    if ([...spec.siteIds].some((id) => !sites.has(id))) fieldErrors["access"] = "Pages viewer principals must name a Ravi Pages site of this project.";
  }
  if (spec.chartId) {
    const chart = await findChartRecord(db, { baseId: scope.base.id, chartId: spec.chartId });
    if (!chart || chart.status !== "active") fieldErrors["layout.chartId"] = "Chart layouts must reference a chart of this base.";
  }
  const widget = spec.widget ? await resolveLayoutWidget(scope, spec.widget, fieldErrors) : null;
  if (Object.keys(fieldErrors).length) validationFailed(fieldErrors);
  return widget ? { ...spec, layout: bindLayoutWidget(spec.layout, widget) } : spec;
}

function storedViewFields(spec: NormalizedViewSpec) {
  return {
    columnsJson: spec.columns,
    queryJson: spec.query as unknown as JsonRecord,
    layoutJson: spec.layout as unknown as JsonRecord,
    accessJson: spec.access as unknown as JsonRecord,
  };
}

function auditMetadata(view: { id: string; version: number; name?: string }, spec?: NormalizedViewSpec) {
  return {
    viewId: view.id,
    version: view.version,
    ...(spec
      ? {
          columnCount: spec.columns.length,
          layout: spec.layout.type,
          widgetItemId: layoutWidget(spec.layout)?.itemId ?? null,
          readPrincipals: spec.access.read.map((principal) => principal.kind),
          writePrincipals: spec.access.write.principals.map((principal) => principal.kind),
          writeColumnCount: spec.access.write.columns.length,
          create: spec.access.write.create,
          archive: spec.access.write.archive,
          allowEscape: spec.access.write.allowEscape,
        }
      : {}),
  };
}

const VIEW_CREATE_OPERATION = "console.bases.views.create";

/** Creates a view (201). With an idempotency key the same key and request replay the created view (200). */
export async function createView(scope: BaseScope, body: unknown, headerKey: string | null = null): Promise<{ status: number; payload: BaseView }> {
  requireManage(scope);
  assertWritable(scope);
  const input = parseBasesBody(baseCreateViewSchema, body);
  const idempotencyKey = resolveOptionalBaseIdempotencyKey(input.idempotencyKey, headerKey);
  const spec = await resolveViewReferences(
    scope,
    normalizeViewSpec(scope, { columns: input.columns, query: input.query, layout: input.layout, access: input.access }, null),
  );
  const record = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope, "view.create");
    const locked = await lockBaseRecord(tx, scope.base.id, "update");
    if (!locked || locked.status !== "active") notFound();
    const reservation = idempotencyKey
      ? await reserveBaseCreateOperation(tx, {
          caller: scope.caller,
          base: scope.base,
          operation: VIEW_CREATE_OPERATION,
          key: idempotencyKey,
          requestHash: baseCreateRequestHash(VIEW_CREATE_OPERATION, scope.base.id, input),
        })
      : null;
    if (reservation?.replay) {
      const replayed = await findViewRecord(tx, { baseId: scope.base.id, viewId: reservation.replay.createdId });
      if (!replayed) notFound();
      return { kind: "replayed" as const, record: replayed };
    }
    const [counts] = await tx
      .select({ count: sql<number>`count(*)::int`, maxPosition: sql<number | null>`max(${schema.baseViews.position})` })
      .from(schema.baseViews)
      .where(and(eq(schema.baseViews.baseId, scope.base.id), eq(schema.baseViews.status, "active")));
    if (Number(counts?.count ?? 0) >= BASES_LIMITS.viewsPerBase) limitExceeded(`A base has at most ${BASES_LIMITS.viewsPerBase} views.`);
    const [created] = await tx
      .insert(schema.baseViews)
      .values({
        baseId: scope.base.id,
        organizationId: scope.base.organizationId,
        projectId: scope.base.projectId,
        name: input.name,
        description: input.description ?? null,
        ...storedViewFields(spec),
        position: input.position ?? Number(counts?.maxPosition ?? -1) + 1,
        createdByActorType: scope.caller.actorType,
        createdByActorId: scope.caller.actorId,
        updatedByActorType: scope.caller.actorType,
        updatedByActorId: scope.caller.actorId,
      })
      .returning();
    if (!created) throw new Error("Failed to create view.");
    await insertBasesAudit(tx, {
      caller: scope.caller,
      organizationId: scope.base.organizationId,
      projectId: scope.base.projectId,
      targetType: "base_view",
      targetId: created.id,
      action: "bases.view.created",
      metadata: { baseId: scope.base.id, ...auditMetadata(created, spec) },
    });
    if (reservation) await completeBaseOperation(tx, reservation.id, { createdId: created.id });
    return { kind: "created" as const, record: created };
  });
  return { status: record.kind === "replayed" ? 200 : 201, payload: await savedViewToApi(scope, record.record) };
}

async function selectViewForUpdate(tx: BasesTx, scope: BaseScope, viewId: string, expectedVersion: number) {
  const [record] = await tx
    .select()
    .from(schema.baseViews)
    .where(and(eq(schema.baseViews.baseId, scope.base.id), eq(schema.baseViews.id, viewId)))
    .limit(1)
    .for("update");
  if (!record) notFound();
  if (record.version !== expectedVersion) conflict("version_conflict", { reason: "The view changed since it was read." });
  return record;
}

export async function updateView(scope: BaseScope, viewId: string, body: unknown): Promise<BaseView> {
  requireManage(scope);
  assertWritable(scope);
  const input = parseBasesBody(baseUpdateViewSchema, body);
  const existing = await findViewRecord(db, { baseId: scope.base.id, viewId });
  if (!existing) notFound();
  const spec = await resolveViewReferences(
    scope,
    normalizeViewSpec(scope, { columns: input.columns, query: input.query, layout: input.layout, access: input.access }, parseStoredView(existing)),
  );
  const record = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope, "view.update");
    const current = await selectViewForUpdate(tx, scope, existing.id, input.expectedVersion);
    if (current.version !== existing.version) conflict("version_conflict", { reason: "The view changed since it was read." });
    const [updated] = await tx
      .update(schema.baseViews)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...storedViewFields(spec),
        version: current.version + 1,
        updatedByActorType: scope.caller.actorType,
        updatedByActorId: scope.caller.actorId,
        updatedAt: new Date(),
      })
      .where(eq(schema.baseViews.id, current.id))
      .returning();
    if (!updated) notFound();
    await insertBasesAudit(tx, {
      caller: scope.caller,
      organizationId: scope.base.organizationId,
      projectId: scope.base.projectId,
      targetType: "base_view",
      targetId: updated.id,
      action: "bases.view.updated",
      metadata: { baseId: scope.base.id, ...auditMetadata(updated, spec) },
    });
    return updated;
  });
  return savedViewToApi(scope, record);
}

export async function archiveView(scope: BaseScope, viewId: string, body: unknown): Promise<BaseView> {
  requireManage(scope);
  assertWritable(scope);
  const input = parseBasesBody(baseVersionedLifecycleSchema, body);
  const existing = await findViewRecord(db, { baseId: scope.base.id, viewId });
  if (!existing) notFound();
  const record: BaseViewRecord = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
    const current = await selectViewForUpdate(tx, scope, existing.id, input.expectedVersion);
    if (current.status === "archived") return current;
    const [updated] = await tx
      .update(schema.baseViews)
      .set({
        status: "archived",
        version: current.version + 1,
        updatedByActorType: scope.caller.actorType,
        updatedByActorId: scope.caller.actorId,
        updatedAt: new Date(),
      })
      .where(eq(schema.baseViews.id, current.id))
      .returning();
    if (!updated) notFound();
    await insertBasesAudit(tx, {
      caller: scope.caller,
      organizationId: scope.base.organizationId,
      projectId: scope.base.projectId,
      targetType: "base_view",
      targetId: updated.id,
      action: "bases.view.archived",
      metadata: { baseId: scope.base.id, ...auditMetadata(updated) },
    });
    return updated;
  });
  return savedViewToApi(scope, record);
}

// ---------------------------------------------------------------------------
// Reads through a view

/**
 * The row as a write through the view returns it (output and `version_conflict`
 * `current`). Writers without row read, such as form principals, get the ids
 * and version only.
 */
function projectThroughView(scope: BaseScope, loaded: LoadedView, row: BaseRowData): BaseRow {
  if (!loaded.admission.read) return { rowId: row.id, version: row.version, values: {} };
  return projectRow(row, viewProjectedColumns(loaded.view, scope), { includeBody: true });
}

async function viewWriteResponse(
  scope: BaseScope,
  loaded: LoadedView,
  rows: BaseRowData[],
  replay: boolean,
  hiddenRowIds: ReadonlySet<string> = new Set(),
) {
  const columns = viewProjectedColumns(loaded.view, scope);
  const projected = rows.map((row): BaseRow =>
    hiddenRowIds.has(row.id) ? { rowId: row.id, version: row.version, values: {} } : projectThroughView(scope, loaded, row),
  );
  const users = await findUserRefs(db, referencedUserIds(projected, columns));
  return { projected, users, replay };
}

/** Compile columns `search` reads through a view: its projected property columns. */
export function viewSearchColumns(view: ParsedView, ctx: BaseCompileContext): BaseCompileColumn[] {
  return view.columns.flatMap((ref) => {
    if (ref === BASE_BODY_REF) return [];
    const column = ctx.resolve(ref);
    return column && column.property ? [column] : [];
  });
}

// ---------------------------------------------------------------------------
// View-as (managers on the console and cli surfaces)

/** A view evaluated as another organization member: their scope (access and `$viewer`) and whether the view admits them to rows. */
export type ViewAsTarget = { userId: string; scope: BaseScope; admitted: boolean };

/**
 * Resolves `asUserId` for a view read. Only managers on the console and cli
 * surfaces may ask (Pages, page chat, and MCP never reach here with it);
 * the user must be an active member of the base organization
 * (`validation_failed` otherwise). The view is evaluated as if they called
 * it on the Console: their project access (no project read: not admitted),
 * the view's principals, and `$viewer.*` bound to them.
 */
export async function resolveViewAs(scope: BaseScope, view: ParsedView, asUserId: string): Promise<ViewAsTarget> {
  if (!scope.access.manage || (scope.caller.surface !== "console" && scope.caller.surface !== "cli")) {
    forbidden("Only project managers on the Console or the CLI may view as another member.");
  }
  if (!isBaseUuid(asUserId)) validationFailed({ asUserId: "asUserId must be a user id." });
  const member = await findActiveMember(db, { organizationId: scope.base.organizationId, userId: asUserId.toLowerCase() });
  if (!member) validationFailed({ asUserId: "asUserId must be an active member of this organization." });
  const caller: BasesCaller = {
    ...scope.caller,
    // Read-only manager simulation, not delegated execution as this member.
    // Keeping the source user's CLI session here incorrectly binds it to the
    // simulated user. The actual manager remains the actor in auditViewedAs.
    authorization: undefined,
    user: { id: member.userId, email: member.email },
    orgRole: member.role,
    actorType: "user",
    actorId: member.userId,
    surface: "console",
    pageSiteId: null,
    localInstallationId: null,
    clientHint: null,
  };
  const workspace = { user: { id: member.userId }, organization: { id: scope.base.organizationId }, membership: { role: member.role } };
  const project = await findAccessibleProjectRecord(workspace, scope.project.id, "read");
  const access = await loadBasesCallerAccess(db, caller, scope.project);
  const target: BaseScope = { ...scope, caller, access };
  const admitted = Boolean(project) && viewAdmission(view, target).read;
  return { userId: member.userId, scope: target, admitted };
}

async function auditViewedAs(scope: BaseScope, view: ParsedView, target: ViewAsTarget, extra: Record<string, string> = {}) {
  await insertBasesAudit(db, {
    caller: scope.caller,
    organizationId: scope.base.organizationId,
    projectId: scope.base.projectId,
    targetType: "base_view",
    targetId: view.record.id,
    action: "bases.view.viewed_as",
    metadata: { baseId: scope.base.id, viewId: view.record.id, asUserId: target.userId, admitted: target.admitted, ...extra },
  });
}

export async function queryThroughLoadedView(scope: BaseScope, loaded: LoadedView, body: unknown): Promise<BaseQueryResponse> {
  const request = parseBasesBody(baseQueryRequestSchema, body);
  if (request.includeArchived) payloadInvalid("includeArchived is only available on direct reads.");
  const { view } = loaded;
  const columns = viewProjectedColumns(view, scope);
  let viewingAs: BaseViewingAs | undefined;
  // The scope filters and `$viewer.*` are evaluated in: the caller's, or the member a manager views as.
  let evalScope = scope;
  if (request.asUserId !== undefined) {
    const target = await resolveViewAs(scope, view, request.asUserId);
    if (!request.cursor) await auditViewedAs(scope, view, target);
    viewingAs = { userId: target.userId, admitted: target.admitted };
    if (!target.admitted) {
      return { columns: columns.filter((column) => column.kind !== "body").map((column) => column.key), rows: [], nextCursor: null, users: {}, viewingAs };
    }
    evalScope = target.scope;
  }
  const policyCtx = compileContext(evalScope);
  const requestCtx = compileContext(evalScope, { allowed: view.columns.filter((ref) => ref !== BASE_BODY_REF) });
  const policySql = viewPolicySql(evalScope, view, policyCtx);
  const bodyProjected = columns.some((column) => column.kind === "body");
  const includeBody = bodyProjected && request.includeBody === true;
  const useRequestSort = Boolean(request.sort && request.sort.length);
  const result = await queryRowsPage({
    scope,
    cursorScope: `view:${view.record.id}`,
    viewVersion: view.record.version,
    policySql,
    requestFilter: request.filter,
    filterCtx: requestCtx,
    searchSql: request.search ? compileBaseSearch(request.search, viewSearchColumns(view, requestCtx)) : null,
    sort: useRequestSort ? request.sort : view.query.sort,
    sortCtx: useRequestSort ? requestCtx : policyCtx,
    columns,
    includeBody,
    includeArchived: false,
    limit: request.limit ?? BASES_LIMITS.queryLimitDefault,
    cursor: request.cursor,
    hashParts: {
      filter: request.filter ?? null,
      sort: useRequestSort ? request.sort : null,
      includeBody,
      includeArchived: false,
      ...(request.search ? { search: request.search } : {}),
      ...(viewingAs ? { asUserId: viewingAs.userId } : {}),
    },
  });
  return viewingAs ? { ...result, viewingAs } : result;
}

export async function queryView(scope: BaseScope, viewId: string, body: unknown): Promise<BaseQueryResponse> {
  return queryThroughLoadedView(scope, await loadViewForCaller(scope, viewId, "read"), body);
}

/**
 * `POST views/<view>/version`: a fingerprint of the rows the caller sees
 * through the view (count, latest `updated_at`, and the sum of versions),
 * bound to the view and schema versions. One aggregate query under the
 * read timeout.
 */
export async function viewVersionForLoaded(scope: BaseScope, loaded: LoadedView): Promise<BaseViewVersionResponse> {
  const policySql = viewPolicySql(scope, loaded.view);
  const [row] = await runBasesRead(BASES_LIMITS.queryTimeoutMs, (tx) =>
    executeRows<{ n: string | number; u: string | null; v: string | number }>(
      tx,
      sql`SELECT count(*)::bigint AS n,
                 to_char(max(r.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS u,
                 COALESCE(sum(r.version), 0)::bigint AS v
          FROM base_rows AS r
          WHERE r.organization_id = ${scope.base.organizationId}::uuid
            AND r.base_id = ${scope.base.id}::uuid
            AND r.archived_at IS NULL
            AND (${policySql})`,
    ),
  );
  const parts = [String(row?.n ?? 0), row?.u ?? "", String(row?.v ?? 0), String(loaded.view.record.version), String(scope.base.schemaVersion)];
  return { fingerprint: createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32) };
}

export async function viewVersion(scope: BaseScope, viewId: string, body: unknown): Promise<BaseViewVersionResponse> {
  parseBasesBody(emptyBodySchema, body);
  return viewVersionForLoaded(scope, await loadViewForCaller(scope, viewId, "read"));
}

export async function getRowThroughView(
  scope: BaseScope,
  viewId: string,
  rowId: string,
  options: { asUserId?: string | null } = {},
): Promise<BaseRowWriteResponse> {
  const loaded = await loadViewForCaller(scope, viewId, "read");
  let viewingAs: BaseViewingAs | undefined;
  let evalScope = scope;
  if (options.asUserId) {
    const target = await resolveViewAs(scope, loaded.view, options.asUserId);
    await auditViewedAs(scope, loaded.view, target, { rowId });
    if (!target.admitted) notFound();
    viewingAs = { userId: target.userId, admitted: true };
    evalScope = target.scope;
  }
  const policySql = viewPolicySql(evalScope, loaded.view);
  // One snapshot for the filter match and the read: a row that leaves the view meanwhile is never returned.
  const record = await db.transaction(
    async (tx) => {
      const matches = await executeRows<{ id: string | null }>(
        tx,
        buildBaseRowMatchQuery({ organizationId: scope.base.organizationId, baseId: scope.base.id, rowId, filterSql: policySql }),
      );
      if (!matches.length || !matches[0]?.id) return null;
      return findRowRecord(tx, { organizationId: scope.base.organizationId, baseId: scope.base.id, rowId });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  if (!record || record.archivedAt) notFound();
  const { projected, users } = await viewWriteResponse(scope, loaded, [rowDataFromRecord(record)], false);
  const row = projected[0];
  if (!row) notFound();
  return viewingAs ? { row, users, idempotentReplay: false, viewingAs } : { row, users, idempotentReplay: false };
}

export async function historyThroughView(
  scope: BaseScope,
  viewId: string,
  rowId: string,
  searchParams: URLSearchParams,
): Promise<BaseRowHistoryResponse> {
  const { view } = await loadViewForCaller(scope, viewId, "read");
  const policySql = viewPolicySql(scope, view);
  const matches = await executeRows<{ id: string | null }>(
    db,
    buildBaseRowMatchQuery({ organizationId: scope.base.organizationId, baseId: scope.base.id, rowId, filterSql: policySql }),
  );
  if (!matches.length || !matches[0]?.id) notFound();
  const columns = viewProjectedColumns(view, scope);
  const propertyIds = new Set(columns.filter((column) => column.kind === "property").map((column) => column.ref));
  return historyPage({
    scope,
    rowId,
    cursorScope: `view-history:${view.record.id}`,
    viewVersion: view.record.version,
    cursor: searchParams.get("cursor"),
    limit: historyLimit(searchParams),
    visibility: {
      propertyIds,
      bodyVisible: columns.some((column) => column.kind === "body"),
      skipInvisibleUpdates: true,
      viewId: scope.access.manage ? undefined : view.record.id,
      systemColumns: scope.access.manage
        ? undefined
        : new Set(columns.filter((column) => column.kind === "system").map((column) => column.key)),
    },
    propertiesById: scope.propertiesById,
  });
}

// ---------------------------------------------------------------------------
// Writes through a view

export async function createRowThroughLoadedView(
  scope: BaseScope,
  loaded: LoadedView,
  body: unknown,
  headerKey: string | null,
): Promise<{ status: number; payload: BaseRowWriteResponse }> {
  const input = parseBasesBody(baseCreateRowsSchema, body);
  if ("rows" in input) payloadInvalid("Views create one row per request.");
  const idempotencyKey = resolveBaseIdempotencyKey(input.idempotencyKey, headerKey);
  const outcome = await createRows({
    scope,
    target: { kind: "view", view: loaded.view, admission: loaded.admission },
    rows: [{ values: input.values, body: input.body }],
    batch: false,
    operation: "console.bases.views.rows.create",
    idempotencyKey,
  });
  const { projected, users, replay } = await viewWriteResponse(scope, loaded, outcome.rows, outcome.replay, outcome.hiddenRowIds);
  const row = projected[0];
  if (!row) notFound();
  return { status: replay ? 200 : 201, payload: { row, users, idempotentReplay: replay } };
}

export async function createRowThroughView(scope: BaseScope, viewId: string, body: unknown, headerKey: string | null) {
  return createRowThroughLoadedView(scope, await loadViewForCaller(scope, viewId, "create"), body, headerKey);
}

export async function updateRowThroughLoadedView(
  scope: BaseScope,
  loaded: LoadedView,
  rowId: string,
  body: unknown,
  headerKey: string | null,
): Promise<BaseRowWriteResponse> {
  const input = parseBasesBody(baseUpdateRowSchema, body);
  const idempotencyKey = resolveBaseIdempotencyKey(input.idempotencyKey, headerKey);
  const outcome = await updateRow({
    scope,
    target: { kind: "view", view: loaded.view, admission: loaded.admission },
    rowId,
    values: input.values,
    body: input.body,
    expectedVersion: input.expectedVersion,
    lastWriteWins: input.lastWriteWins === true,
    operation: "console.bases.views.rows.update",
    idempotencyKey,
    project: (row) => projectThroughView(scope, loaded, row),
  });
  const { projected, users, replay } = await viewWriteResponse(scope, loaded, outcome.rows, outcome.replay, outcome.hiddenRowIds);
  const row = projected[0];
  if (!row) notFound();
  return { row, users, idempotentReplay: replay };
}

export async function updateRowThroughView(scope: BaseScope, viewId: string, rowId: string, body: unknown, headerKey: string | null) {
  return updateRowThroughLoadedView(scope, await loadViewForCaller(scope, viewId, "write"), rowId, body, headerKey);
}

export async function archiveRowThroughView(scope: BaseScope, viewId: string, rowId: string, body: unknown): Promise<BaseRowWriteResponse> {
  const loaded = await loadViewForCaller(scope, viewId, "archive");
  const input = parseBasesBody(baseRowLifecycleSchema, body);
  const row = await changeRowLifecycle({
    scope,
    target: { kind: "view", view: loaded.view, admission: loaded.admission },
    rowId,
    action: "archive",
    expectedVersion: input.expectedVersion,
    lastWriteWins: input.lastWriteWins === true,
    project: (current) => projectThroughView(scope, loaded, current),
  });
  const { projected, users } = await viewWriteResponse(scope, loaded, [row], false);
  const projectedRow = projected[0];
  if (!projectedRow) notFound();
  return { row: projectedRow, users, idempotentReplay: false };
}

