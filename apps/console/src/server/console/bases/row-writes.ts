// Row write engine shared by direct writes and writes through a view (SPEC
// "Row", "Writes Through A View", "Idempotency", "Ledger", "Events"). Every
// write runs in one transaction: base lock, idempotency reservation, view
// pre-image, version check, apply, post-image check, ledger, inbox items.

import { randomUUID } from "node:crypto";

import { and, eq, sql, type SQL } from "drizzle-orm";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import { BASES_LIMITS } from "@/shared/bases/limits";
import { isBaseSystemColumn } from "@/shared/bases/operators";
import type { BaseAgentValue, BaseProperty, BaseRow } from "@/shared/bases/types";
import {
  BASE_AGENT_READONLY_ERROR,
  BASE_NUL_ERROR,
  baseHasNul,
  baseUtf8Bytes,
  isBaseApprovalIntent,
  normalizeBaseAgentOutput,
  normalizeBaseValueInput,
} from "@/shared/bases/values";

import type { ViewAdmission } from "./access";
import { insertBasesAudit } from "./audit";
import { buildBaseRowMatchQuery, compileBaseFilter, type BaseCompileContext } from "./compiler";
import { baseArchived, conflict, forbidden, isConsoleApiError, limitExceeded, notFound, validationFailed } from "./errors";
import {
  emitBaseRowEvents,
  evaluateSubscriptionViewMatches,
  listActiveBaseSubscriptions,
  type BaseEventSubscription,
  type BaseRowChange,
} from "./events";
import { baseIdempotencyRequestHash, completeBaseOperation, reserveBaseOperation, type BaseOperationResult } from "./idempotency";
import { appendLedgerEntries, type BaseLedgerWrite } from "./ledger";
import {
  activeMemberIds,
  countActiveRows,
  executeRows,
  findRowRecord,
  findRowRecords,
  lockBaseRecord,
  type BaseRowRecord,
  type BasesExecutor,
  type BasesTx,
} from "./repository";
import { compileContext, type BaseScope } from "./scope";
import { BASE_BODY_REF, rowDataFromRecord, type BaseRowData } from "./serialize";
import { resolveSetValue, viewAdmission, viewCreateCoverageError, viewInvalid, type ParsedView } from "./view-model";
import {
  agentFilledValue,
  agentInputsHash,
  agentPendingValue,
  applyAgentRequests,
  approvalReset,
  approvalsToReset,
  approvalTransitions,
  resolveApprovalWrite,
} from "./workflow";

export type RowWriteTarget =
  | { kind: "direct" }
  | { kind: "view"; view: ParsedView; admission: ViewAdmission };

export type RowWriteOutcome = {
  rows: BaseRowData[];
  replay: boolean;
  /** Replayed rows the caller can no longer read through the view: answer with `rowId` and `version` only. */
  hiddenRowIds: ReadonlySet<string>;
};

type WriteTxResult = { replay: BaseOperationResult } | { rows: BaseRowRecord[] };

const NOT_WRITABLE = "This column is not writable through this view.";

// ---------------------------------------------------------------------------
// Helpers

function stableJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function sameBaseValue(a: unknown, b: unknown) {
  return stableJson(a) === stableJson(b);
}

function viewId(target: RowWriteTarget) {
  return target.kind === "view" ? target.view.record.id : null;
}

/** The view filter compiled for the caller; a filter that no longer compiles is `409 view_invalid`. */
export function viewPolicySql(scope: BaseScope, view: ParsedView, ctx: BaseCompileContext = compileContext(scope)): SQL {
  try {
    return compileBaseFilter(view.query.filter, ctx);
  } catch (error) {
    if (isConsoleApiError(error, "unknown_property") || isConsoleApiError(error, "invalid_filter")) {
      viewInvalid(scope, "This view references a deleted or incompatible property.");
    }
    throw error;
  }
}

/** The row is active and matches `filterSql`. After `FOR UPDATE` in the same transaction it reads the locked version. */
async function rowMatches(executor: BasesExecutor, scope: BaseScope, rowId: string, filterSql: SQL) {
  const rows = await executeRows<{ id: string | null }>(
    executor,
    buildBaseRowMatchQuery({ organizationId: scope.base.organizationId, baseId: scope.base.id, rowId, filterSql }),
  );
  return rows.length > 0 && rows[0]?.id !== null;
}

async function lockBaseForRowWrite(tx: BasesTx, scope: BaseScope, target?: RowWriteTarget, action: "create" | "write" | "archive" = "write") {
  const { assertBasesServiceOperation } = await import("./service-principal");
  assertBasesServiceOperation(scope, target?.kind === "direct" ? (action === "create" ? "rows.create" : action === "write" ? "rows.update" : undefined) : undefined);
  // Recheck inside the effect transaction, before ledger replay or writes.
  const { loadBasesCallerAccess } = await import("./access");
  const currentAccess = await loadBasesCallerAccess(tx, scope.caller, scope.project);
  if (!currentAccess.projectRead || !currentAccess.projectWrite) forbidden("Project access was revoked.");
  const locked = await lockBaseRecord(tx, scope.base.id, "share");
  if (!locked || locked.organizationId !== scope.base.organizationId) notFound();
  if (locked.status !== "active") baseArchived();
  if (locked.schemaVersion !== scope.base.schemaVersion) {
    conflict("schema_version_conflict", {
      reason: "The base schema changed while writing. Retry with the latest properties.",
      schemaVersion: locked.schemaVersion,
    });
  }
  if (target?.kind === "view") {
    const [view] = await tx.select({ version: schema.baseViews.version, status: schema.baseViews.status })
      .from(schema.baseViews).where(and(eq(schema.baseViews.id, target.view.record.id), eq(schema.baseViews.baseId, scope.base.id)))
      .limit(1).for("share");
    if (!view || view.status !== "active") notFound();
    if (view.version !== target.view.record.version) conflict("view_version_conflict", { reason: "The view changed. Reload it before retrying." });
    const admission = viewAdmission(target.view, { ...scope, access: currentAccess });
    if (!admission.write || (action === "create" && !admission.create) || (action === "archive" && !admission.archive)) {
      forbidden("The view no longer permits this operation.");
    }
  } else if (!currentAccess.manage) forbidden("Direct writes require current Base management access.");
  return locked;
}

/**
 * Serializes the active-row count and the writes that add active rows
 * (creates, restores) per base. The base lock is `FOR SHARE`, which does not
 * exclude other row writers.
 */
async function lockActiveRowCount(tx: BasesTx, baseId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`bases:active_rows:${baseId}`}::text))`);
}

function writableRefs(target: RowWriteTarget): Set<string> | null {
  return target.kind === "view" ? new Set(target.admission.writeColumns) : null;
}

/** Resolves supplied keys to active properties the caller may write. */
function resolveWriteKeys(
  scope: BaseScope,
  target: RowWriteTarget,
  values: Record<string, unknown>,
  prefix: string,
  fieldErrors: Record<string, string>,
): Array<{ property: BaseProperty; input: unknown; key: string }> {
  const writable = writableRefs(target);
  const viewColumns = target.kind === "view" ? new Set(target.view.columns) : null;
  const resolved: Array<{ property: BaseProperty; input: unknown; key: string }> = [];
  const seen = new Set<string>();
  for (const [key, input] of Object.entries(values)) {
    const property =
      scope.properties.find((candidate) => !candidate.deletedAt && candidate.key === key) ??
      scope.properties.find((candidate) => !candidate.deletedAt && candidate.id === key) ??
      null;
    // Agent columns are filled by their agent only (the fill endpoint), on every surface.
    if (property?.type === "agent" && (!viewColumns || viewColumns.has(property.id))) {
      fieldErrors[`${prefix}${key}`] = BASE_AGENT_READONLY_ERROR;
      continue;
    }
    if (writable) {
      if (!property || !viewColumns?.has(property.id) || !writable.has(property.id)) {
        fieldErrors[`${prefix}${key}`] = NOT_WRITABLE;
        continue;
      }
    } else if (!property) {
      fieldErrors[`${prefix}${key}`] = isBaseSystemColumn(key) ? "System columns are read-only." : "Unknown property.";
      continue;
    }
    if (seen.has(property.id)) {
      fieldErrors[`${prefix}${key}`] = "This property is listed twice.";
      continue;
    }
    seen.add(property.id);
    resolved.push({ property, input, key: property.key });
  }
  return resolved;
}

function checkBody(target: RowWriteTarget, body: string | null | undefined, field: string, fieldErrors: Record<string, string>) {
  if (body === undefined) return;
  const writable = writableRefs(target);
  if (writable && !writable.has(BASE_BODY_REF)) {
    fieldErrors[field] = NOT_WRITABLE;
    return;
  }
  if (body !== null && baseUtf8Bytes(body) > BASES_LIMITS.bodyBytes) {
    fieldErrors[field] = `The body is limited to ${BASES_LIMITS.bodyBytes} bytes.`;
  } else if (baseHasNul(body)) {
    fieldErrors[field] = BASE_NUL_ERROR;
  }
}

function normalizedBody(body: string | null | undefined) {
  if (body === undefined) return undefined;
  return body === null || body === "" ? null : body;
}

function personIdsOf(property: BaseProperty, value: unknown): string[] {
  return property.type === "person" && Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function checkValuesSize(values: Record<string, unknown>, field: string, fieldErrors: Record<string, string>) {
  if (baseUtf8Bytes(JSON.stringify(values)) > BASES_LIMITS.rowValuesBytes) {
    fieldErrors[field] = `Row values are limited to ${BASES_LIMITS.rowValuesBytes} bytes.`;
  }
}

async function assertPeopleAreMembers(
  executor: BasesTx | typeof db,
  scope: BaseScope,
  people: Array<{ field: string; ids: string[] }>,
  fieldErrors: Record<string, string>,
) {
  const all = people.flatMap((entry) => entry.ids);
  if (!all.length) return;
  const members = await activeMemberIds(executor, scope.base.organizationId, all);
  for (const entry of people) {
    if (entry.ids.some((id) => !members.has(id.toLowerCase()))) {
      fieldErrors[entry.field] = "Every person must be an active member of this organization.";
    }
  }
}

function requireVersionChoice(expectedVersion: number | undefined, lastWriteWins: boolean | undefined) {
  if (expectedVersion === undefined && lastWriteWins !== true) {
    validationFailed({ expectedVersion: "Send expectedVersion, or lastWriteWins: true to overwrite." });
  }
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>, ids: string[]) {
  const beforeOut: Record<string, unknown> = {};
  const afterOut: Record<string, unknown> = {};
  for (const id of ids) {
    if (before[id] !== undefined) beforeOut[id] = before[id];
    if (after[id] !== undefined) afterOut[id] = after[id];
  }
  return { before: beforeOut, after: afterOut };
}

function baseEventInfo(scope: BaseScope) {
  return {
    id: scope.base.id,
    slug: scope.base.slug,
    name: scope.base.name,
    organizationId: scope.base.organizationId,
    projectId: scope.base.projectId,
    schemaVersion: scope.base.schemaVersion,
    timezone: scope.base.timezone,
  };
}

/** Stored value of a normalized input: approval intents become full approval values (who and when from the caller and clock). */
function storedInput(scope: BaseScope, property: BaseProperty, normalized: unknown, stored: unknown, now: Date): unknown {
  if (property.type !== "approval" || normalized === undefined || !isBaseApprovalIntent(normalized)) return normalized;
  return resolveApprovalWrite({ property, intent: normalized, stored, caller: scope.caller, access: scope.access, now });
}

/**
 * Re-reads replayed rows. Through a view, a row that is archived or no longer
 * matches the view filter is returned as ids only, with the version the
 * original write produced.
 */
async function replayRows(scope: BaseScope, target: RowWriteTarget, stored: BaseOperationResult): Promise<RowWriteOutcome> {
  const records = await findRowRecords(db, { organizationId: scope.base.organizationId, baseId: scope.base.id, rowIds: stored.rowIds });
  if (!records.length) notFound();
  const hiddenRowIds = new Set<string>();
  if (target.kind === "direct") return { rows: records.map(rowDataFromRecord), replay: true, hiddenRowIds };
  const filterSql = viewPolicySql(scope, target.view);
  const storedVersions = new Map(stored.rowIds.map((id, index) => [id.toLowerCase(), stored.versions[index] ?? 1]));
  const rows: BaseRowData[] = [];
  for (const record of records) {
    if (!record.archivedAt && (await rowMatches(db, scope, record.id, filterSql))) {
      rows.push(rowDataFromRecord(record));
      continue;
    }
    hiddenRowIds.add(record.id);
    rows.push({ ...rowDataFromRecord(record), version: storedVersions.get(record.id) ?? 1, values: {}, body: null });
  }
  return { rows, replay: true, hiddenRowIds };
}

// ---------------------------------------------------------------------------
// Create

export type CreateRowInput = { values: Record<string, unknown>; body?: string | null };

/**
 * Prepared create: stored values (with view presets) and the person ids to
 * verify. Preset people are kept apart: a preset is not a submitted key, so a
 * preset naming a former member makes the view invalid rather than adding a
 * field error.
 */
function prepareCreate(
  scope: BaseScope,
  target: RowWriteTarget,
  row: CreateRowInput,
  prefix: string,
  fieldErrors: Record<string, string>,
) {
  const values: Record<string, unknown> = {};
  const people: Array<{ field: string; ids: string[] }> = [];
  const presetPeople = new Map<string, { key: string; ids: string[] }>();
  if (target.kind === "view") {
    for (const [ref, stored] of Object.entries(target.view.access.write.set)) {
      const property = scope.propertiesById.get(ref);
      if (!property || property.deletedAt) viewInvalid(scope, "A view preset references a deleted property.");
      const result = resolveSetValue(property, stored, {
        userId: scope.caller.user?.id ?? null,
        email: scope.caller.user?.email ?? null,
        now: scope.now,
        timezone: scope.base.timezone,
      });
      if (!result.ok) {
        if ("viewerRequired" in result) forbidden("viewer_required");
        viewInvalid(scope, `Preset "${property.key}" is no longer valid.`);
      }
      values[property.id] = result.value;
      const ids = personIdsOf(property, result.value);
      if (ids.length) presetPeople.set(property.id, { key: property.key, ids });
    }
  }
  for (const { property, input, key } of resolveWriteKeys(scope, target, row.values, prefix, fieldErrors)) {
    const result = normalizeBaseValueInput(property, input, { timezone: scope.base.timezone });
    if (!result.ok) {
      fieldErrors[`${prefix}${key}`] = result.error;
      continue;
    }
    presetPeople.delete(property.id);
    const value = storedInput(scope, property, result.value, undefined, scope.now);
    if (value === undefined) delete values[property.id];
    else values[property.id] = value;
    const ids = personIdsOf(property, result.value);
    if (ids.length) people.push({ field: `${prefix}${key}`, ids });
  }
  if (target.kind === "view") {
    const coverageError = viewCreateCoverageError(target.view, scope);
    if (coverageError) viewInvalid(scope, coverageError);
  }
  for (const property of scope.properties) {
    if (property.deletedAt || !property.required) continue;
    if (values[property.id] === undefined && !fieldErrors[`${prefix}${property.key}`]) {
      fieldErrors[`${prefix}${property.key}`] = "This property is required.";
    }
  }
  checkBody(target, row.body, `${prefix}body`, fieldErrors);
  checkValuesSize(values, `${prefix}values`, fieldErrors);
  return { values, body: normalizedBody(row.body) ?? null, people, presetPeople: [...presetPeople.values()] };
}

/** A `write.set` person preset naming someone who left the organization is `409 view_invalid`. */
async function assertPresetPeopleAreMembers(scope: BaseScope, presets: Array<{ key: string; ids: string[] }>) {
  const all = presets.flatMap((preset) => preset.ids);
  if (!all.length) return;
  const members = await activeMemberIds(db, scope.base.organizationId, all);
  const stale = presets.find((preset) => preset.ids.some((id) => !members.has(id.toLowerCase())));
  if (stale) viewInvalid(scope, `Preset "${stale.key}" names a person who is no longer an active member of this organization.`);
}

/** Creates one row or a batch (≤ 500) directly or through a view. Requires an idempotency key. */
export async function createRows(input: {
  scope: BaseScope;
  target: RowWriteTarget;
  rows: CreateRowInput[];
  batch: boolean;
  operation: string;
  idempotencyKey: string;
}): Promise<RowWriteOutcome> {
  const { scope, target } = input;
  if (scope.readOnly) baseArchived();
  if (!input.rows.length || input.rows.length > BASES_LIMITS.batchRows) {
    validationFailed({ rows: `Send 1-${BASES_LIMITS.batchRows} rows.` });
  }
  const fieldErrors: Record<string, string> = {};
  const prepared = input.rows.map((row, index) =>
    prepareCreate(scope, target, row, input.batch ? `rows.${index}.` : "", fieldErrors),
  );
  if (!Object.keys(fieldErrors).length) {
    await assertPresetPeopleAreMembers(scope, prepared.flatMap((row) => row.presetPeople));
    await assertPeopleAreMembers(db, scope, prepared.flatMap((row) => row.people), fieldErrors);
  }
  if (Object.keys(fieldErrors).length) validationFailed(fieldErrors);

  const requestHash = baseIdempotencyRequestHash({
    operation: input.operation,
    baseId: scope.base.id,
    viewId: viewId(target),
    rowId: null,
    values: input.batch ? input.rows.map((row) => row.values) : input.rows[0]?.values ?? {},
    body: input.batch ? input.rows.map((row) => row.body ?? null) : input.rows[0]?.body ?? null,
    expectedVersion: null,
    lastWriteWins: false,
  });

  const result = await db.transaction(async (tx): Promise<WriteTxResult> => {
    await lockBaseForRowWrite(tx, scope, target, "create");
    const reservation = await reserveBaseOperation(tx, {
      caller: scope.caller,
      base: scope.base,
      operation: input.operation,
      key: input.idempotencyKey,
      requestHash,
    });
    if (reservation.replay) return { replay: reservation.replay };

    await lockActiveRowCount(tx, scope.base.id);
    const active = await countActiveRows(tx, scope.base.id);
    if (active + prepared.length > BASES_LIMITS.rowsPerBase) {
      limitExceeded(`A base holds at most ${BASES_LIMITS.rowsPerBase} active rows.`);
    }
    const now = new Date();
    // Every agent column of a new row asks its agent for a value.
    const agentRequests = prepared.map((row) => applyAgentRequests({ properties: scope.properties, before: null, next: row.values, now }));
    const inserts = prepared.map((row) => ({
      id: randomUUID(),
      baseId: scope.base.id,
      organizationId: scope.base.organizationId,
      projectId: scope.base.projectId,
      valuesJson: row.values as JsonRecord,
      body: row.body,
      version: 1,
      createdByActorType: scope.caller.actorType,
      createdByActorId: scope.caller.actorId,
      updatedByActorType: scope.caller.actorType,
      updatedByActorId: scope.caller.actorId,
      createdAt: now,
      updatedAt: now,
    }));
    const records: BaseRowRecord[] = [];
    for (let index = 0; index < inserts.length; index += 250) {
      records.push(...(await tx.insert(schema.baseRows).values(inserts.slice(index, index + 250)).returning()));
    }
    const byId = new Map(records.map((record) => [record.id, record]));
    const ordered = inserts.map((row) => byId.get(row.id)).filter((record): record is BaseRowRecord => Boolean(record));

    if (target.kind === "view" && !target.admission.allowEscape) {
      const filterSql = viewPolicySql(scope, target.view);
      for (const record of ordered) {
        if (!(await rowMatches(tx, scope, record.id, filterSql))) {
          conflict("write_escapes_view", { reason: "The new row would not be visible through this view." });
        }
      }
    }

    const ledger: BaseLedgerWrite[] = ordered.map((record) => {
      const values = (record.valuesJson ?? {}) as Record<string, unknown>;
      return {
        rowId: record.id,
        version: record.version,
        action: "created",
        changedPropertyIds: Object.keys(values),
        before: {},
        after: values,
        bodyChanged: record.body !== null,
        lastWriteWins: false,
        viewId: viewId(target),
      };
    });
    await appendLedgerEntries(tx, scope.base, scope.caller, ledger);
    const requestsById = new Map<string, Array<{ propertyId: string; inputsHash: string }>>(
      inserts.map((row, index) => [row.id, agentRequests[index] ?? []]),
    );
    const changes: BaseRowChange[] = ordered.map((record) => {
      const values = (record.valuesJson ?? {}) as Record<string, unknown>;
      return {
        rowId: record.id,
        version: record.version,
        verb: "created",
        changedPropertyCount: Object.keys(values).length,
        changedPropertyIds: Object.keys(values),
        approvals: approvalTransitions(scope.properties, {}, values),
        agentRequests: requestsById.get(record.id) ?? [],
      };
    });
    await emitBaseRowEvents(tx, { base: baseEventInfo(scope), caller: scope.caller, changes, occurredAt: now });
    await completeBaseOperation(tx, reservation.id, {
      rowIds: ordered.map((record) => record.id),
      versions: ordered.map((record) => record.version),
    });
    return { rows: ordered };
  });

  if ("replay" in result) return replayRows(scope, target, result.replay);
  return { rows: result.rows.map(rowDataFromRecord), replay: false, hiddenRowIds: new Set() };
}

// ---------------------------------------------------------------------------
// Update

/** PATCH a row: only supplied keys change. Requires an idempotency key and `expectedVersion` or `lastWriteWins`. */
export async function updateRow(input: {
  scope: BaseScope;
  target: RowWriteTarget;
  rowId: string;
  values: Record<string, unknown> | undefined;
  body: string | null | undefined;
  expectedVersion: number | undefined;
  lastWriteWins: boolean;
  operation: string;
  idempotencyKey: string;
  /** Projects the current row for `409 version_conflict` bodies. */
  project: (row: BaseRowData) => BaseRow;
}): Promise<RowWriteOutcome> {
  const { scope, target } = input;
  if (scope.readOnly) baseArchived();
  requireVersionChoice(input.expectedVersion, input.lastWriteWins);
  const fieldErrors: Record<string, string> = {};
  const supplied = resolveWriteKeys(scope, target, input.values ?? {}, "", fieldErrors);
  checkBody(target, input.body, "body", fieldErrors);
  if (Object.keys(fieldErrors).length) validationFailed(fieldErrors);

  const requestHash = baseIdempotencyRequestHash({
    operation: input.operation,
    baseId: scope.base.id,
    viewId: viewId(target),
    rowId: input.rowId,
    values: input.values ?? {},
    body: input.body,
    expectedVersion: input.expectedVersion ?? null,
    lastWriteWins: input.lastWriteWins,
  });

  const result = await db.transaction(async (tx): Promise<WriteTxResult> => {
    await lockBaseForRowWrite(tx, scope, target);
    const reservation = await reserveBaseOperation(tx, {
      caller: scope.caller,
      base: scope.base,
      operation: input.operation,
      key: input.idempotencyKey,
      requestHash,
    });
    if (reservation.replay) return { replay: reservation.replay };

    // Lock first, then apply the view filter to the locked version.
    const filterSql = target.kind === "view" ? viewPolicySql(scope, target.view) : null;
    const record = await findRowRecord(tx, { organizationId: scope.base.organizationId, baseId: scope.base.id, rowId: input.rowId }, { forUpdate: true });
    if (!record || record.archivedAt) notFound();
    if (filterSql && !(await rowMatches(tx, scope, record.id, filterSql))) notFound();
    const current = rowDataFromRecord(record);
    if (!input.lastWriteWins && input.expectedVersion !== record.version) {
      conflict("version_conflict", { reason: "The row changed since it was read.", current: input.project(current) });
    }

    const before = current.values;
    const next: Record<string, unknown> = { ...before };
    const changedIds: string[] = [];
    const people: Array<{ field: string; ids: string[] }> = [];
    const errors: Record<string, string> = {};
    const now = new Date();
    for (const { property, input: value, key } of supplied) {
      const stored = before[property.id];
      if (sameBaseValue(value, stored)) continue;
      const normalized = normalizeBaseValueInput(property, value, { timezone: scope.base.timezone, existing: stored });
      if (!normalized.ok) {
        errors[key] = normalized.error;
        continue;
      }
      const nextValue = storedInput(scope, property, normalized.value, stored, now);
      if (sameBaseValue(nextValue, stored)) continue;
      if (nextValue === undefined) {
        if (property.required) {
          errors[key] = "This property is required.";
          continue;
        }
        delete next[property.id];
      } else next[property.id] = nextValue;
      changedIds.push(property.id);
      const ids = personIdsOf(property, nextValue).filter((id) => !personIdsOf(property, stored).includes(id));
      if (ids.length) people.push({ field: key, ids });
    }
    // Side effects of changed values, in the same write: decided approvals whose
    // `resetOn` changed go back to pending; agent columns whose inputs changed are requested.
    let agentRequests: Array<{ propertyId: string; inputsHash: string }> = [];
    if (changedIds.length) {
      // Only approvals this write actually changed count as set by it: echoing the
      // stored value (skipped above) must not keep a `resetOn` reset from running.
      const explicit = new Set(changedIds);
      for (const approval of approvalsToReset(scope.properties, before, explicit, explicit)) {
        next[approval.id] = approvalReset(scope.caller, now);
        changedIds.push(approval.id);
      }
      agentRequests = applyAgentRequests({ properties: scope.properties, before, next, now });
      for (const request of agentRequests) if (!changedIds.includes(request.propertyId)) changedIds.push(request.propertyId);
    }
    const body = normalizedBody(input.body);
    const bodyChanged = body !== undefined && body !== current.body;
    checkValuesSize(next, "values", errors);
    await assertPeopleAreMembers(tx, scope, people, errors);
    if (Object.keys(errors).length) validationFailed(errors);

    if (!changedIds.length && !bodyChanged) {
      await completeBaseOperation(tx, reservation.id, { rowIds: [record.id], versions: [record.version] });
      return { rows: [record] };
    }

    const [updated] = await tx
      .update(schema.baseRows)
      .set({
        valuesJson: next as JsonRecord,
        ...(bodyChanged ? { body } : {}),
        version: record.version + 1,
        updatedByActorType: scope.caller.actorType,
        updatedByActorId: scope.caller.actorId,
        updatedAt: now,
      })
      .where(and(eq(schema.baseRows.id, record.id), eq(schema.baseRows.version, record.version)))
      .returning();
    if (!updated) conflict("version_conflict", { reason: "The row changed since it was read.", current: input.project(current) });

    if (filterSql && target.kind === "view" && !target.admission.allowEscape) {
      if (!(await rowMatches(tx, scope, updated.id, filterSql))) {
        conflict("write_escapes_view", { reason: "This change would move the row out of this view." });
      }
    }

    const { before: beforeChanged, after: afterChanged } = changedFields(before, next, changedIds);
    await appendLedgerEntries(tx, scope.base, scope.caller, [
      {
        rowId: updated.id,
        version: updated.version,
        action: "updated",
        changedPropertyIds: changedIds,
        before: beforeChanged,
        after: afterChanged,
        bodyChanged,
        lastWriteWins: input.lastWriteWins,
        viewId: viewId(target),
      },
    ]);
    await emitBaseRowEvents(tx, {
      base: baseEventInfo(scope),
      caller: scope.caller,
      changes: [
        {
          rowId: updated.id,
          version: updated.version,
          verb: "updated",
          changedPropertyCount: changedIds.length,
          changedPropertyIds: changedIds,
          approvals: approvalTransitions(scope.properties, before, next),
          agentRequests,
        },
      ],
      occurredAt: now,
    });
    await completeBaseOperation(tx, reservation.id, { rowIds: [updated.id], versions: [updated.version] });
    return { rows: [updated] };
  });

  if ("replay" in result) return replayRows(scope, target, result.replay);
  return { rows: result.rows.map(rowDataFromRecord), replay: false, hiddenRowIds: new Set() };
}

// ---------------------------------------------------------------------------
// Agent values (SPEC "Agent Property")

export type AgentWriteOutcome = { row: BaseRowRecord; replay: boolean };

/** An active agent property of the base by key or id; 404 when missing, 400 when not an agent column. */
export function resolveAgentProperty(scope: BaseScope, ref: string): BaseProperty {
  const lowered = ref.toLowerCase();
  const property = scope.properties.find((candidate) => !candidate.deletedAt && (candidate.key === ref || candidate.id === lowered));
  if (!property) notFound();
  if (property.type !== "agent") validationFailed({ property: "not_agent" }, "This property is not an agent column.");
  return property;
}

/**
 * Stores an agent's value (or error) for one row. The body's `inputsHash`
 * must equal the hash of the row's current inputs, else `409 agent_stale`
 * with the current hash. Bumps the version, writes a ledger entry, emits
 * `bases.row.updated` only.
 */
export async function fillAgentValue(input: {
  scope: BaseScope;
  rowId: string;
  property: BaseProperty;
  inputsHash: string;
  outcome: { value: unknown } | { error: string };
  idempotencyKey: string;
}): Promise<AgentWriteOutcome> {
  const { scope, property } = input;
  if (scope.readOnly) baseArchived();
  let outcome: { value: unknown } | { error: string } = input.outcome;
  if ("value" in outcome) {
    const normalized = normalizeBaseAgentOutput(property, outcome.value, { timezone: scope.base.timezone });
    if (!normalized.ok) validationFailed({ value: normalized.error });
    outcome = { value: normalized.value ?? null };
  }
  const operation = "console.bases.rows.agent.fill";
  const requestHash = baseIdempotencyRequestHash({
    operation,
    baseId: scope.base.id,
    viewId: null,
    rowId: input.rowId,
    values: { propertyId: property.id, inputsHash: input.inputsHash, ...outcome },
    body: undefined,
    expectedVersion: null,
    lastWriteWins: false,
  });
  return db.transaction(async (tx): Promise<AgentWriteOutcome> => {
    await lockBaseForRowWrite(tx, scope);
    const reservation = await reserveBaseOperation(tx, { caller: scope.caller, base: scope.base, operation, key: input.idempotencyKey, requestHash });
    if (reservation.replay) {
      const [replayed] = await findRowRecords(tx, { organizationId: scope.base.organizationId, baseId: scope.base.id, rowIds: reservation.replay.rowIds });
      if (!replayed) notFound();
      return { row: replayed, replay: true };
    }
    const record = await findRowRecord(tx, { organizationId: scope.base.organizationId, baseId: scope.base.id, rowId: input.rowId }, { forUpdate: true });
    if (!record || record.archivedAt) notFound();
    const before = (record.valuesJson ?? {}) as Record<string, unknown>;
    const current = agentInputsHash(property, before);
    if (current !== input.inputsHash) {
      conflict("agent_stale", { reason: "The row's inputs changed since this value was requested.", inputsHash: current });
    }
    const now = new Date();
    const filled = agentFilledValue(
      before[property.id],
      current,
      "error" in outcome ? { error: outcome.error } : { value: outcome.value as BaseAgentValue["value"] },
      now,
    );
    const next = { ...before, [property.id]: filled };
    const updated = await writeAgentValue(tx, scope, record, before, next, now, []);
    await completeBaseOperation(tx, reservation.id, { rowIds: [updated.id], versions: [updated.version] });
    return { row: updated, replay: false };
  });
}

/** Sets an agent value back to `pending` for the current inputs and emits `bases.agent.requested`. */
export async function rerunAgentValue(input: {
  scope: BaseScope;
  rowId: string;
  property: BaseProperty;
  idempotencyKey: string | null;
}): Promise<AgentWriteOutcome> {
  const { scope, property } = input;
  if (scope.readOnly) baseArchived();
  const operation = "console.bases.rows.agent.rerun";
  const requestHash = baseIdempotencyRequestHash({
    operation,
    baseId: scope.base.id,
    viewId: null,
    rowId: input.rowId,
    values: { propertyId: property.id },
    body: undefined,
    expectedVersion: null,
    lastWriteWins: false,
  });
  return db.transaction(async (tx): Promise<AgentWriteOutcome> => {
    await lockBaseForRowWrite(tx, scope);
    const reservation = input.idempotencyKey
      ? await reserveBaseOperation(tx, { caller: scope.caller, base: scope.base, operation, key: input.idempotencyKey, requestHash })
      : null;
    if (reservation?.replay) {
      const [replayed] = await findRowRecords(tx, { organizationId: scope.base.organizationId, baseId: scope.base.id, rowIds: reservation.replay.rowIds });
      if (!replayed) notFound();
      return { row: replayed, replay: true };
    }
    const record = await findRowRecord(tx, { organizationId: scope.base.organizationId, baseId: scope.base.id, rowId: input.rowId }, { forUpdate: true });
    if (!record || record.archivedAt) notFound();
    const before = (record.valuesJson ?? {}) as Record<string, unknown>;
    const now = new Date();
    const inputsHash = agentInputsHash(property, before);
    const next = { ...before, [property.id]: agentPendingValue(before[property.id], inputsHash, now) };
    const updated = await writeAgentValue(tx, scope, record, before, next, now, [{ propertyId: property.id, inputsHash }]);
    if (reservation) await completeBaseOperation(tx, reservation.id, { rowIds: [updated.id], versions: [updated.version] });
    return { row: updated, replay: false };
  });
}

async function writeAgentValue(
  tx: BasesTx,
  scope: BaseScope,
  record: BaseRowRecord,
  before: Record<string, unknown>,
  next: Record<string, unknown>,
  now: Date,
  agentRequests: Array<{ propertyId: string; inputsHash: string }>,
): Promise<BaseRowRecord> {
  const changedIds = Object.keys(next).filter((id) => !sameBaseValue(before[id], next[id]));
  const errors: Record<string, string> = {};
  checkValuesSize(next, "value", errors);
  if (Object.keys(errors).length) validationFailed(errors);
  const [updated] = await tx
    .update(schema.baseRows)
    .set({
      valuesJson: next as JsonRecord,
      version: record.version + 1,
      updatedByActorType: scope.caller.actorType,
      updatedByActorId: scope.caller.actorId,
      updatedAt: now,
    })
    .where(and(eq(schema.baseRows.id, record.id), eq(schema.baseRows.version, record.version)))
    .returning();
  if (!updated) conflict("version_conflict", { reason: "The row changed since it was read." });
  const { before: beforeChanged, after: afterChanged } = changedFields(before, next, changedIds);
  await appendLedgerEntries(tx, scope.base, scope.caller, [
    {
      rowId: updated.id,
      version: updated.version,
      action: "updated",
      changedPropertyIds: changedIds,
      before: beforeChanged,
      after: afterChanged,
      bodyChanged: false,
      lastWriteWins: false,
      viewId: null,
    },
  ]);
  await emitBaseRowEvents(tx, {
    base: baseEventInfo(scope),
    caller: scope.caller,
    changes: [
      {
        rowId: updated.id,
        version: updated.version,
        verb: "updated",
        changedPropertyCount: changedIds.length,
        changedPropertyIds: changedIds,
        agentRequests,
      },
    ],
    occurredAt: now,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Archive and restore

export async function changeRowLifecycle(input: {
  scope: BaseScope;
  target: RowWriteTarget;
  rowId: string;
  action: "archive" | "restore";
  expectedVersion: number | undefined;
  lastWriteWins: boolean;
  project: (row: BaseRowData) => BaseRow;
}): Promise<BaseRowData> {
  const { scope, target } = input;
  if (scope.readOnly) baseArchived();
  requireVersionChoice(input.expectedVersion, input.lastWriteWins);

  const record = await db.transaction(async (tx) => {
    await lockBaseForRowWrite(tx, scope, target, "archive");
    if (target.kind === "view" && input.action !== "archive") notFound();
    const filterSql = target.kind === "view" ? viewPolicySql(scope, target.view) : null;
    if (input.action === "restore") await lockActiveRowCount(tx, scope.base.id);
    // Lock first, then apply the view filter to the locked version.
    const row = await findRowRecord(tx, { organizationId: scope.base.organizationId, baseId: scope.base.id, rowId: input.rowId }, { forUpdate: true });
    if (!row) notFound();
    if (input.action === "archive" ? row.archivedAt !== null : row.archivedAt === null) notFound();
    if (filterSql && !(await rowMatches(tx, scope, row.id, filterSql))) notFound();
    if (!input.lastWriteWins && input.expectedVersion !== row.version) {
      conflict("version_conflict", { reason: "The row changed since it was read.", current: input.project(rowDataFromRecord(row)) });
    }
    if (input.action === "restore") {
      const active = await countActiveRows(tx, scope.base.id);
      if (active + 1 > BASES_LIMITS.rowsPerBase) limitExceeded(`A base holds at most ${BASES_LIMITS.rowsPerBase} active rows.`);
    }
    // A filtered subscription's view test for an archive runs on the row before it leaves.
    let archiveEvents: { subscriptions: BaseEventSubscription[]; viewMatches: Set<string> } | null = null;
    if (input.action === "archive") {
      const subscriptions = await listActiveBaseSubscriptions(tx, scope.base);
      archiveEvents = { subscriptions, viewMatches: await evaluateSubscriptionViewMatches(tx, baseEventInfo(scope), subscriptions, [row.id]) };
    }
    const now = new Date();
    const [updated] = await tx
      .update(schema.baseRows)
      .set({
        archivedAt: input.action === "archive" ? now : null,
        version: row.version + 1,
        updatedByActorType: scope.caller.actorType,
        updatedByActorId: scope.caller.actorId,
        updatedAt: now,
      })
      .where(and(eq(schema.baseRows.id, row.id), eq(schema.baseRows.version, row.version)))
      .returning();
    if (!updated) conflict("version_conflict", { reason: "The row changed since it was read.", current: input.project(rowDataFromRecord(row)) });
    const verb = input.action === "archive" ? "archived" : "restored";
    await appendLedgerEntries(tx, scope.base, scope.caller, [
      {
        rowId: updated.id,
        version: updated.version,
        action: verb,
        changedPropertyIds: [],
        before: {},
        after: {},
        bodyChanged: false,
        lastWriteWins: input.lastWriteWins,
        viewId: viewId(target),
      },
    ]);
    await emitBaseRowEvents(tx, {
      base: baseEventInfo(scope),
      caller: scope.caller,
      changes: [{ rowId: updated.id, version: updated.version, verb, changedPropertyCount: 0 }],
      occurredAt: now,
      ...(archiveEvents ?? {}),
    });
    return updated;
  });
  return rowDataFromRecord(record);
}

// ---------------------------------------------------------------------------
// Purge

/** Hard-deletes a row and its ledger, leaving a tombstone entry and an audit event without values. */
export async function purgeRow(input: { scope: BaseScope; rowId: string }): Promise<{ purged: true; rowId: string }> {
  const { scope } = input;
  if (scope.readOnly) baseArchived();
  return db.transaction(async (tx) => {
    await lockBaseForRowWrite(tx, scope);
    const row = await findRowRecord(tx, { organizationId: scope.base.organizationId, baseId: scope.base.id, rowId: input.rowId }, { forUpdate: true });
    if (!row) notFound();
    await tx
      .delete(schema.baseRowLedger)
      .where(and(eq(schema.baseRowLedger.baseId, scope.base.id), eq(schema.baseRowLedger.rowId, row.id)));
    await tx.delete(schema.baseRows).where(eq(schema.baseRows.id, row.id));
    await appendLedgerEntries(tx, scope.base, scope.caller, [
      {
        rowId: row.id,
        version: row.version + 1,
        action: "purged",
        changedPropertyIds: [],
        before: {},
        after: {},
        bodyChanged: false,
        lastWriteWins: false,
        viewId: null,
      },
    ]);
    await insertBasesAudit(tx, {
      caller: scope.caller,
      organizationId: scope.base.organizationId,
      projectId: scope.base.projectId,
      targetType: "base_row",
      targetId: row.id,
      action: "bases.row.purged",
      metadata: { baseId: scope.base.id, rowId: row.id, version: row.version, wasArchived: row.archivedAt !== null },
    });
    return { purged: true as const, rowId: row.id };
  });
}
