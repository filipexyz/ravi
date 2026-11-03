import { assertCurrentBasesManagement } from "./access";
// Bases: list, create, get, update, archive, restore. See SPEC "Base",
// "Scope And Roles", and the API table. Managers see every base and full
// schemas; other callers see only bases with a view that admits them, and only
// the public shapes of those views.

import { and, eq, sql } from "drizzle-orm";

import { suggestConsoleSlug } from "@/lib/console/slugs";
import { validateConsoleSlug } from "@/server/console/slugs";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import { BASES_LIMITS } from "@/shared/bases/limits";
import { baseCreateSchema, baseLifecycleSchema, baseUpdateSchema } from "@/shared/bases/schemas";
import type { BaseDetail, BaseSummary } from "@/shared/bases/types";
import { canonicalTimeZone } from "@/shared/bases/time";

import { computeViewAdmission } from "./access";
import { insertBasesAudit } from "./audit";
import { listCharts } from "./charts";
import { baseArchived, basesError, conflict, forbidden, limitExceeded, notFound, parseBasesBody, postgresErrorCode, validationFailed } from "./errors";
import {
  baseCreateRequestHash,
  checkBaseCreateOperation,
  insertBaseCreatedOperation,
  resolveOptionalBaseIdempotencyKey,
  type BaseCreatedResult,
} from "./idempotency";
import { preparePropertyDefinitions, propertyInsertValues } from "./properties";
import {
  countActiveRows,
  countActiveRowsByBase,
  findBaseRecord,
  listActiveMemberRefs,
  listBaseRecords,
  loadPropertyRecords,
  loadViewRecords,
  lockBaseRecord,
  type BaseRecord,
  type BasesTx,
} from "./repository";
import { assertWritable, buildBaseScope, scopeCapabilities, type BaseScope, type BasesProjectScope } from "./scope";
import { BASE_BODY_REF, baseSummaryFromRecord, propertyFromRecord, propertyToApi } from "./serialize";
import { emptyStoredAccess, parseStoredView } from "./view-model";
import { listViews } from "./views";

export const DEFAULT_BASE_VIEW_NAME = "All rows";
const SLUG_MAX_CHARS = 63;

function requireManage(scope: BasesProjectScope, action: string) {
  if (!scope.access.manage) forbidden(`${action} needs project write access.`);
}

function projectArchived(): never {
  throw basesError(409, { error: "base_archived", reason: "This project is archived; its bases are read-only." });
}

function slugTaken(): never {
  throw basesError(409, {
    error: "slug_taken",
    reason: "That slug is already used in this project.",
    fieldErrors: { slug: "That slug is already used in this project." },
  });
}

function isUniqueViolation(error: unknown) {
  return postgresErrorCode(error) === "23505";
}

/** Derives a free slug from a name: DNS-label grammar, reserved words avoided, `-2`, `-3`, ... on collision. */
export function deriveBaseSlug(name: string, taken: ReadonlySet<string>): string {
  let stem = suggestConsoleSlug(name, SLUG_MAX_CHARS - 4);
  if (!stem || validateConsoleSlug(stem)) stem = suggestConsoleSlug(`base-${stem}`, SLUG_MAX_CHARS - 4);
  if (!stem || validateConsoleSlug(stem)) stem = "base";
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? stem : `${stem}-${n}`;
    if (!taken.has(candidate) && !validateConsoleSlug(candidate)) return candidate;
  }
}

function checkSlug(slug: string, fieldErrors: Record<string, string>) {
  if (validateConsoleSlug(slug)) fieldErrors.slug = "This slug is unavailable. Use 2-63 lowercase letters, digits, and hyphens.";
}

/** Validates `timezone` and returns its canonical IANA name, so stored zones have one spelling. */
function checkTimezone(timezone: string | undefined, fieldErrors: Record<string, string>) {
  if (timezone === undefined) return undefined;
  const canonical = canonicalTimeZone(timezone);
  if (!canonical) fieldErrors.timezone = "Use an IANA time zone such as UTC or America/Sao_Paulo.";
  return canonical ?? undefined;
}

async function lockProjectBases(tx: BasesTx, projectId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`bases:${projectId}`}::text))`);
}

async function projectSlugs(tx: BasesTx, scope: BasesProjectScope, excludeBaseId?: string) {
  const rows = await tx
    .select({ id: schema.bases.id, slug: schema.bases.slug })
    .from(schema.bases)
    .where(and(eq(schema.bases.organizationId, scope.caller.organizationId), eq(schema.bases.projectId, scope.project.id)));
  return new Set(rows.filter((row) => row.id !== excludeBaseId).map((row) => row.slug));
}

function auditBase(tx: BasesTx, scope: BasesProjectScope, base: BaseRecord, action: string, metadata: JsonRecord) {
  return insertBasesAudit(tx, {
    caller: scope.caller,
    organizationId: base.organizationId,
    projectId: base.projectId,
    targetType: "base",
    targetId: base.id,
    action,
    metadata: { baseId: base.id, slug: base.slug, version: base.version, ...metadata },
  });
}

// ---------------------------------------------------------------------------
// Reads

export async function listBases(scope: BasesProjectScope, options: { includeArchived?: boolean } = {}): Promise<{ bases: BaseSummary[] }> {
  const includeArchived = scope.access.manage && options.includeArchived === true;
  const records = (await listBaseRecords(db, { organizationId: scope.caller.organizationId, projectId: scope.project.id })).filter(
    (record) => includeArchived || record.status === "active",
  );
  const capabilities = scopeCapabilities(scope);
  if (scope.access.manage) {
    const counts = await countActiveRowsByBase(db, records.map((record) => record.id));
    return { bases: records.map((record) => baseSummaryFromRecord(record, capabilities, counts.get(record.id) ?? 0)) };
  }
  const views = await loadViewRecords(db, records.map((record) => record.id));
  const admitted = new Set<string>();
  for (const view of views) {
    if (admitted.has(view.baseId)) continue;
    if (computeViewAdmission(parseStoredView(view), scope.access).admitted) admitted.add(view.baseId);
  }
  return {
    bases: records.filter((record) => admitted.has(record.id)).map((record) => baseSummaryFromRecord(record, capabilities, null)),
  };
}

/** Managers: full schema, views, charts, members. Others: public shapes of admitted views; no admitted view is `404`. */
export async function getBaseDetail(scope: BaseScope): Promise<BaseDetail> {
  const capabilities = scopeCapabilities(scope);
  const [{ views }, { charts }] = await Promise.all([listViews(scope), listCharts(scope)]);
  if (scope.access.manage) {
    const [rowCount, members] = await Promise.all([
      countActiveRows(db, scope.base.id),
      listActiveMemberRefs(db, scope.base.organizationId),
    ]);
    const properties = scope.properties.map((property) => propertyToApi(property, scope.propertiesById));
    return { ...baseSummaryFromRecord(scope.base, capabilities, rowCount), properties, views, charts, members };
  }
  if (!views.length) notFound();
  return { ...baseSummaryFromRecord(scope.base, capabilities, null), properties: [], views, charts, members: [] };
}

// ---------------------------------------------------------------------------
// Create

const BASE_CREATE_OPERATION = "console.bases.create";

/** Replays an idempotent base create: the base the first request created. */
async function replayCreatedBase(scope: BasesProjectScope, createdId: string): Promise<BaseDetail> {
  const base = await findBaseRecord(db, { organizationId: scope.caller.organizationId, projectId: scope.project.id, ref: createdId });
  if (!base) notFound();
  const records = await loadPropertyRecords(db, base.id);
  return getBaseDetail(buildBaseScope(scope, base, records.map(propertyFromRecord)));
}

/**
 * Creates a base with its properties and default view. With an idempotency
 * key, the same key and request replay the created base (200) and a different
 * request is `409 idempotency_conflict`.
 */
export async function createBase(
  scope: BasesProjectScope,
  body: unknown,
  headerKey: string | null = null,
): Promise<{ status: number; payload: BaseDetail }> {
  requireManage(scope, "Creating bases");
  if (scope.projectReadOnly) projectArchived();
  const input = parseBasesBody(baseCreateSchema, body);
  const idempotencyKey = resolveOptionalBaseIdempotencyKey(input.idempotencyKey, headerKey);
  const fieldErrors: Record<string, string> = {};
  if (input.slug !== undefined) checkSlug(input.slug, fieldErrors);
  const timezone = checkTimezone(input.timezone, fieldErrors);
  if (Object.keys(fieldErrors).length) validationFailed(fieldErrors);
  const prepared = preparePropertyDefinitions(input.properties ?? [], new Set(), 0, (index) => `properties.${index}.`);
  const requestHash = idempotencyKey ? baseCreateRequestHash(BASE_CREATE_OPERATION, `project:${scope.project.id}`, input) : "";
  const operation = idempotencyKey
    ? { caller: scope.caller, organizationId: scope.caller.organizationId, operation: BASE_CREATE_OPERATION, key: idempotencyKey, requestHash }
    : null;

  let created: { base: BaseRecord; properties: ReturnType<typeof propertyFromRecord>[] } | { replay: BaseCreatedResult };
  try {
    created = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope, "base.create", input.slug);
      await lockProjectBases(tx, scope.project.id);
      if (operation) {
        const replay = await checkBaseCreateOperation(tx, operation);
        if (replay) return { replay };
      }
      const taken = await projectSlugs(tx, scope);
      if (taken.size >= BASES_LIMITS.basesPerProject) limitExceeded(`A project has at most ${BASES_LIMITS.basesPerProject} bases.`);
      if (input.slug !== undefined && taken.has(input.slug)) slugTaken();
      const slug = input.slug ?? deriveBaseSlug(input.name, taken);
      const [base] = await tx
        .insert(schema.bases)
        .values({
          organizationId: scope.caller.organizationId,
          projectId: scope.project.id,
          slug,
          name: input.name,
          description: input.description ?? null,
          icon: input.icon ?? null,
          timezone: timezone ?? "UTC",
          createdByActorType: scope.caller.actorType,
          createdByActorId: scope.caller.actorId,
          updatedByActorType: scope.caller.actorType,
          updatedByActorId: scope.caller.actorId,
        })
        .returning();
      if (!base) throw new Error("Failed to create base.");
      const propertyRecords = prepared.length
        ? await tx.insert(schema.baseProperties).values(prepared.map((property) => propertyInsertValues(base, property))).returning()
        : [];
      const properties = propertyRecords.map(propertyFromRecord).sort((a, b) => a.position - b.position);
      const [view] = await tx
        .insert(schema.baseViews)
        .values({
          baseId: base.id,
          organizationId: base.organizationId,
          projectId: base.projectId,
          name: DEFAULT_BASE_VIEW_NAME,
          columnsJson: [...properties.map((property) => property.id), BASE_BODY_REF],
          queryJson: { filter: null, sort: [], refTypes: {} },
          layoutJson: { type: "table" },
          accessJson: emptyStoredAccess() as unknown as JsonRecord,
          position: 0,
          createdByActorType: scope.caller.actorType,
          createdByActorId: scope.caller.actorId,
          updatedByActorType: scope.caller.actorType,
          updatedByActorId: scope.caller.actorId,
        })
        .returning();
      await auditBase(tx, scope, base, "bases.base.created", {
        propertyCount: properties.length,
        timezone: base.timezone,
        defaultViewId: view?.id ?? null,
      });
      if (operation) await insertBaseCreatedOperation(tx, { ...operation, base });
      return { base, properties };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent request with the same key won: replay it (or 409 for another request).
    const replay = operation ? await db.transaction(async (tx) => { await assertCurrentBasesManagement(tx, scope, "base.create", input.slug); return checkBaseCreateOperation(tx, operation); }) : null;
    if (!replay) slugTaken();
    created = { replay };
  }
  if ("replay" in created) return { status: 200, payload: await replayCreatedBase(scope, created.replay.createdId) };
  return { status: 201, payload: await getBaseDetail(buildBaseScope(scope, created.base, created.properties)) };
}

// ---------------------------------------------------------------------------
// Update and lifecycle

async function selectBaseForUpdate(tx: BasesTx, scope: BaseScope, expectedVersion: number) {
  const locked = await lockBaseRecord(tx, scope.base.id, "update");
  if (!locked || locked.organizationId !== scope.base.organizationId) notFound();
  if (locked.version !== expectedVersion) conflict("version_conflict", { reason: "The base changed since it was read." });
  return locked;
}

async function summaryFor(scope: BaseScope, base: BaseRecord): Promise<BaseSummary> {
  return baseSummaryFromRecord(base, scopeCapabilities(scope), await countActiveRows(db, base.id));
}

export async function updateBase(scope: BaseScope, body: unknown): Promise<BaseSummary> {
  requireManage(scope, "Changing bases");
  assertWritable(scope);
  const input = parseBasesBody(baseUpdateSchema, body);
  const fieldErrors: Record<string, string> = {};
  if (input.slug !== undefined) checkSlug(input.slug, fieldErrors);
  const timezone = checkTimezone(input.timezone, fieldErrors);
  if (Object.keys(fieldErrors).length) validationFailed(fieldErrors);
  let updated: BaseRecord;
  try {
    updated = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
      const locked = await selectBaseForUpdate(tx, scope, input.expectedVersion);
      if (locked.status !== "active") baseArchived();
      if (input.slug !== undefined && input.slug !== locked.slug) {
        await lockProjectBases(tx, locked.projectId);
        if ((await projectSlugs(tx, scope, locked.id)).has(input.slug)) slugTaken();
      }
      const changed = (["slug", "name", "description", "icon", "timezone"] as const).filter((key) => input[key] !== undefined);
      const [record] = await tx
        .update(schema.bases)
        .set({
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
          version: locked.version + 1,
          updatedByActorType: scope.caller.actorType,
          updatedByActorId: scope.caller.actorId,
          updatedAt: new Date(),
        })
        .where(eq(schema.bases.id, locked.id))
        .returning();
      if (!record) notFound();
      await auditBase(tx, scope, record, "bases.base.updated", { changed });
      return record;
    });
  } catch (error) {
    if (isUniqueViolation(error)) slugTaken();
    throw error;
  }
  return summaryFor(scope, updated);
}

export async function changeBaseLifecycle(scope: BaseScope, action: "archive" | "restore", body: unknown): Promise<BaseSummary> {
  requireManage(scope, action === "archive" ? "Archiving bases" : "Restoring bases");
  if (scope.projectReadOnly) projectArchived();
  const input = parseBasesBody(baseLifecycleSchema, body);
  const status = action === "archive" ? "archived" : "active";
  const updated = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
    const locked = await selectBaseForUpdate(tx, scope, input.expectedVersion);
    if (locked.status === status) return locked;
    const now = new Date();
    const [record] = await tx
      .update(schema.bases)
      .set({
        status,
        archivedAt: status === "archived" ? now : null,
        version: locked.version + 1,
        updatedByActorType: scope.caller.actorType,
        updatedByActorId: scope.caller.actorId,
        updatedAt: now,
      })
      .where(eq(schema.bases.id, locked.id))
      .returning();
    if (!record) notFound();
    await auditBase(tx, scope, record, action === "archive" ? "bases.base.archived" : "bases.base.restored", {});
    return record;
  });
  return summaryFor(scope, updated);
}
