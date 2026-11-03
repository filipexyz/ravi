import { assertCurrentBasesManagement } from "./access";
// Property mutations (`base.manage`). Every mutation requires
// `expectedSchemaVersion` and increments `schema_version`. Type and
// `includeTime` changes are migrations: dry-run unless `confirm: true`, and
// refused above 10,000 active rows. Deletes are soft and dry-run unless
// confirmed. See SPEC "Property".

import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import { BASES_LIMITS } from "@/shared/bases/limits";
import {
  baseCreatePropertySchema,
  baseDeletePropertySchema,
  baseRestorePropertySchema,
  baseUpdatePropertySchema,
  type BasePropertyDefinitionInput,
} from "@/shared/bases/schemas";
import { BASE_RESERVED_KEYS } from "@/shared/bases/types";
import type {
  BaseProperty,
  BasePropertyConfig,
  BasePropertyMigrationReport,
  BasePropertyMutationResponse,
  BasePropertyType,
} from "@/shared/bases/types";
import {
  basePropertyKeyFromName,
  baseValueToApi,
  convertBaseValue,
  defaultStatusOptions,
  displayBaseValue,
  isBaseUuid,
  normalizeSelectOptions,
} from "@/shared/bases/values";

import { insertBasesAudit } from "./audit";
import { baseFilterColumnRefs } from "./compiler";
import { baseArchived, basesError, conflict, forbidden, limitExceeded, notFound, parseBasesBody, validationFailed } from "./errors";
import { emitBaseAgentBackfill, emitBaseRowEvents } from "./events";
import { baseCreateRequestHash, completeBaseOperation, reserveBaseCreateOperation, resolveOptionalBaseIdempotencyKey } from "./idempotency";
import { appendLedgerEntries } from "./ledger";
import {
  activeMemberIds,
  countActiveRows,
  executeRows,
  findBaseRecord,
  loadChartRecords,
  loadPropertyRecords,
  loadViewRecords,
  lockBaseRecord,
  type BaseRecord,
  type BasesExecutor,
  type BasesTx,
} from "./repository";
import { sameBaseValue } from "./row-writes";
import { scopeCapabilities, type BaseScope } from "./scope";
import { BASE_BODY_REF, baseSummaryFromRecord, propertyFromRecord, propertyToApi } from "./serialize";
import { layoutWidget, parseStoredView } from "./view-model";

type PropertyConfigInput = NonNullable<BasePropertyDefinitionInput["config"]>;

const OPTION_TYPES: ReadonlySet<BasePropertyType> = new Set(["select", "multi_select", "status"]);
const RESERVED_KEYS: ReadonlySet<string> = new Set(BASE_RESERVED_KEYS);
const MIGRATION_UPDATE_CHUNK = 1000;

function requireManage(scope: BaseScope) {
  if (!scope.access.manage) forbidden("Changing properties needs project write access.");
}

function assertProjectWritable(scope: BaseScope) {
  if (scope.projectReadOnly) baseArchived();
}

// ---------------------------------------------------------------------------
// Config and keys

/**
 * Builds the stored config for `type`. `existing` carries options (between
 * option types) and number/date settings of the same type. Keys that do not
 * apply to the type are field errors.
 */
/**
 * Resolves a property reference (key or id) inside config (`resetOn`,
 * `inputs`) to the referenced property, or null when unknown. `self` is the
 * property being defined.
 */
export type PropertyRefResolver = (ref: string) => { id: string; type: BasePropertyType; self: boolean } | null;

/** Resolver over existing properties plus new ones of the same request (by key or id). */
export function propertyRefResolver(
  properties: ReadonlyArray<Pick<BaseProperty, "id" | "key" | "type">>,
  selfId: string | null,
): PropertyRefResolver {
  return (ref) => {
    const lowered = ref.toLowerCase();
    const match = properties.find((property) => property.key === ref || property.id === lowered);
    return match ? { id: match.id, type: match.type, self: match.id === selfId } : null;
  };
}

const UNREFERENCEABLE: ReadonlySet<BasePropertyType> = new Set(["approval", "agent"]);

/** Ids of `refs` for `resetOn`/`inputs`: known, not itself, not approval or agent; unique in order. */
function resolveConfigRefs(refs: readonly string[], resolve: PropertyRefResolver | undefined, field: string, fieldErrors: Record<string, string>) {
  const ids: string[] = [];
  refs.forEach((ref, index) => {
    const target = resolve?.(ref) ?? null;
    if (!target) fieldErrors[`${field}.${index}`] = `Unknown property "${ref}".`;
    else if (target.self) fieldErrors[`${field}.${index}`] = "A property cannot reference itself.";
    else if (UNREFERENCEABLE.has(target.type)) fieldErrors[`${field}.${index}`] = "Approval and agent properties cannot be referenced here.";
    else if (!ids.includes(target.id)) ids.push(target.id);
  });
  return ids;
}

export function buildPropertyConfig(
  type: BasePropertyType,
  input: PropertyConfigInput | undefined,
  existing: BasePropertyConfig | null,
  field: string,
  fieldErrors: Record<string, string>,
  resolve?: PropertyRefResolver,
): BasePropertyConfig {
  const config: BasePropertyConfig = {};
  const reject = (key: string) => {
    fieldErrors[`${field}.${key}`] = `Not used by ${type} properties.`;
  };
  if (input) {
    if (input.options !== undefined && !OPTION_TYPES.has(type) && type !== "agent") reject("options");
    if (type !== "number") {
      if (input.format !== undefined) reject("format");
      if (input.currency !== undefined) reject("currency");
      if (input.precision !== undefined) reject("precision");
    }
    if (input.includeTime !== undefined && type !== "date") reject("includeTime");
    if (type !== "approval") {
      if (input.approvers !== undefined) reject("approvers");
      if (input.resetOn !== undefined) reject("resetOn");
    }
    if (type !== "agent") {
      for (const key of ["instructions", "inputs", "output", "agent"] as const) if (input[key] !== undefined) reject(key);
    }
  }
  if (type === "approval") {
    const approvers = input?.approvers ?? existing?.approvers;
    if (!approvers?.length) fieldErrors[`${field}.approvers`] = "An approval property needs at least one approver.";
    else config.approvers = approvers.map((principal) =>
      principal.kind === "user" ? { kind: "user", userId: principal.userId.toLowerCase() } : { kind: "project_role", minRole: principal.minRole },
    );
    const resetOn = input?.resetOn !== undefined ? resolveConfigRefs(input.resetOn, resolve, `${field}.resetOn`, fieldErrors) : existing?.resetOn;
    if (resetOn?.length) config.resetOn = resetOn;
    return config;
  }
  if (type === "agent") {
    const instructions = input?.instructions ?? existing?.instructions;
    if (!instructions) fieldErrors[`${field}.instructions`] = "An agent property needs instructions.";
    else config.instructions = instructions;
    const inputs = input?.inputs !== undefined ? resolveConfigRefs(input.inputs, resolve, `${field}.inputs`, fieldErrors) : existing?.inputs;
    if (!inputs?.length) {
      if (!fieldErrors[`${field}.inputs`] && !Object.keys(fieldErrors).some((key) => key.startsWith(`${field}.inputs.`))) {
        fieldErrors[`${field}.inputs`] = "An agent property needs at least one input property.";
      }
    } else config.inputs = inputs;
    const output = input?.output ?? existing?.output;
    if (!output) fieldErrors[`${field}.output`] = "An agent property needs an output type.";
    else config.output = output;
    if (output === "select" || output === "multi_select") {
      const prior = existing?.output === output ? (existing.options ?? []) : [];
      if (input?.options !== undefined) {
        const result = normalizeSelectOptions(output, prior, input.options);
        if (!result.ok) fieldErrors[`${field}.options`] = result.error;
        else if (!result.options.length) fieldErrors[`${field}.options`] = "A select output needs options.";
        else config.options = result.options;
      } else if (prior.length) config.options = prior;
      else fieldErrors[`${field}.options`] = "A select output needs options.";
    } else if (input?.options !== undefined) {
      fieldErrors[`${field}.options`] = "Options apply only to select and multi_select outputs.";
    }
    const agent = input?.agent !== undefined ? input.agent : existing?.agent;
    if (agent) config.agent = agent;
    return config;
  }
  if (OPTION_TYPES.has(type)) {
    const optionType = type as "select" | "multi_select" | "status";
    const prior = existing?.options ?? [];
    let options = prior;
    if (input?.options !== undefined) {
      if (optionType === "status" && !input.options.length && !prior.length) options = defaultStatusOptions();
      else {
        const result = normalizeSelectOptions(optionType, prior, input.options);
        if (!result.ok) fieldErrors[`${field}.options`] = result.error;
        else options = result.options;
      }
    } else if (prior.length) {
      const result = normalizeSelectOptions(
        optionType,
        prior,
        prior.map((option) => ({ id: option.id, name: option.name, color: option.color, group: option.group, archived: option.archived })),
      );
      if (!result.ok) fieldErrors[`${field}.options`] = result.error;
      else options = result.options;
    } else if (optionType === "status") {
      options = defaultStatusOptions();
    }
    config.options = options;
  }
  if (type === "number") {
    const format = input?.format ?? existing?.format;
    if (format) config.format = format;
    if (input?.currency !== undefined && format !== "currency") {
      fieldErrors[`${field}.currency`] = "A currency applies only to the currency format.";
    }
    if (format === "currency") config.currency = input?.currency ?? existing?.currency ?? "USD";
    const precision = input?.precision ?? existing?.precision;
    if (precision !== undefined) config.precision = precision;
  }
  if (type === "date") config.includeTime = input?.includeTime ?? existing?.includeTime ?? false;
  return config;
}

function keyTaken(field: string, key: string): never {
  throw basesError(409, {
    error: "key_taken",
    reason: `The key "${key}" is already used by another property.`,
    fieldErrors: { [field]: "This key is already used by another property." },
  });
}

function checkExplicitKey(key: string, field: string, fieldErrors: Record<string, string>) {
  if (RESERVED_KEYS.has(key)) fieldErrors[field] = `"${key}" is reserved.`;
}

export type PreparedProperty = {
  /** Assigned before insert so definitions of one request can reference each other. */
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: BasePropertyType;
  config: BasePropertyConfig;
  required: boolean;
  position: number;
};

/**
 * Validates new property definitions against the active keys. Explicit keys
 * that collide are `409 key_taken`; derived keys get `_2`, `_3`, ... suffixes.
 */
export function preparePropertyDefinitions(
  definitions: readonly BasePropertyDefinitionInput[],
  activeKeys: ReadonlySet<string>,
  firstPosition: number,
  fieldPrefix: (index: number) => string,
  /** Active properties of the base, for `resetOn` and `inputs` references. */
  existing: ReadonlyArray<Pick<BaseProperty, "id" | "key" | "type">> = [],
): PreparedProperty[] {
  const fieldErrors: Record<string, string> = {};
  const taken = new Set(activeKeys);
  const explicit = new Set<string>();
  definitions.forEach((definition, index) => {
    if (definition.key === undefined) return;
    const field = `${fieldPrefix(index)}key`;
    checkExplicitKey(definition.key, field, fieldErrors);
    if (taken.has(definition.key) || explicit.has(definition.key)) keyTaken(field, definition.key);
    explicit.add(definition.key);
  });
  for (const key of explicit) taken.add(key);
  const named = definitions.map((definition) => {
    const key = definition.key ?? basePropertyKeyFromName(definition.name, taken);
    taken.add(key);
    return { id: randomUUID(), key, type: definition.type };
  });
  const all = [...existing, ...named];
  const prepared = definitions.map((definition, index): PreparedProperty => {
    const { id, key } = named[index]!;
    const required = definition.required === true;
    if (required && UNREFERENCEABLE.has(definition.type)) {
      fieldErrors[`${fieldPrefix(index)}required`] = `${definition.type === "approval" ? "Approval" : "Agent"} properties cannot be required.`;
    }
    return {
      id,
      key,
      name: definition.name,
      description: definition.description ?? null,
      type: definition.type,
      config: buildPropertyConfig(definition.type, definition.config, null, `${fieldPrefix(index)}config`, fieldErrors, propertyRefResolver(all, id)),
      required,
      position: definition.position ?? firstPosition + index,
    };
  });
  if (Object.keys(fieldErrors).length) validationFailed(fieldErrors);
  return prepared;
}

/** User approvers must be active members of the organization (`config.approvers.<n>.userId`). */
export async function assertApproversAreMembers(
  executor: BasesExecutor,
  organizationId: string,
  entries: ReadonlyArray<{ config: BasePropertyConfig; field: string }>,
) {
  const wanted = entries.flatMap(({ config, field }) =>
    (config.approvers ?? []).flatMap((principal, index) => (principal.kind === "user" ? [{ id: principal.userId, field: `${field}.approvers.${index}.userId` }] : [])),
  );
  if (!wanted.length) return;
  const active = await activeMemberIds(executor, organizationId, wanted.map((entry) => entry.id));
  const fieldErrors: Record<string, string> = {};
  for (const entry of wanted) if (!active.has(entry.id)) fieldErrors[entry.field] = "Approvers must be active members of the organization.";
  if (Object.keys(fieldErrors).length) validationFailed(fieldErrors);
}

export function propertyInsertValues(base: Pick<BaseRecord, "id" | "organizationId" | "projectId">, property: PreparedProperty) {
  return {
    id: property.id,
    baseId: base.id,
    organizationId: base.organizationId,
    projectId: base.projectId,
    key: property.key,
    name: property.name,
    description: property.description,
    type: property.type,
    configJson: property.config as unknown as JsonRecord,
    required: property.required,
    position: property.position,
  };
}

// ---------------------------------------------------------------------------
// Reports

/** Whether the stored view names the property anywhere, including `layout.widget.fields`. */
export function viewReferences(view: ReturnType<typeof parseStoredView>, propertyId: string) {
  if (view.columns.includes(propertyId)) return true;
  if (baseFilterColumnRefs(view.query.filter).has(propertyId)) return true;
  if (view.query.sort.some((entry) => entry.prop === propertyId)) return true;
  const layout = view.layout;
  if (layout.type === "board" && layout.groupBy === propertyId) return true;
  if (layout.type === "calendar" && layout.dateProp === propertyId) return true;
  if (layout.type === "gallery" && layout.coverProp === propertyId) return true;
  if (Object.values(layoutWidget(layout)?.fields ?? {}).includes(propertyId)) return true;
  if (view.access.write.columns.includes(propertyId)) return true;
  return Object.prototype.hasOwnProperty.call(view.access.write.set, propertyId);
}

function chartReferences(specJson: unknown, propertyId: string) {
  if (!specJson || typeof specJson !== "object") return false;
  const encoding = (specJson as { encoding?: unknown }).encoding;
  if (!encoding || typeof encoding !== "object") return false;
  return Object.values(encoding as Record<string, unknown>).some(
    (channel) => Boolean(channel) && typeof channel === "object" && (channel as { field?: unknown }).field === propertyId,
  );
}

export async function propertyDependents(executor: BasesExecutor, baseId: string, propertyId: string) {
  const [views, charts] = await Promise.all([loadViewRecords(executor, [baseId]), loadChartRecords(executor, baseId)]);
  return {
    views: views
      .filter((record) => viewReferences(parseStoredView(record), propertyId))
      .map((record) => ({ id: record.id, name: record.name })),
    charts: charts.filter((record) => chartReferences(record.specJson, propertyId)).map((record) => ({ id: record.id, name: record.name })),
  };
}

async function countRowsMissing(executor: BasesExecutor, baseId: string, propertyId: string) {
  const [row] = await executeRows<{ count: number }>(
    executor,
    sql`SELECT count(*)::int AS count FROM base_rows AS r WHERE r.base_id = ${baseId}::uuid AND r.archived_at IS NULL AND NOT (r.values_json ? ${propertyId}::text)`,
  );
  return Number(row?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Transactions

async function lockSchema(tx: BasesTx, scope: BaseScope, expectedSchemaVersion: number) {
  const locked = await lockBaseRecord(tx, scope.base.id, "update");
  if (!locked || locked.organizationId !== scope.base.organizationId) notFound();
  if (locked.status !== "active") baseArchived();
  if (locked.schemaVersion !== expectedSchemaVersion) {
    conflict("schema_version_conflict", {
      reason: "The base schema changed. Review the latest properties and retry.",
      schemaVersion: locked.schemaVersion,
    });
  }
  const properties = (await loadPropertyRecords(tx, locked.id)).map(propertyFromRecord);
  return { locked, properties };
}

async function bumpSchemaVersion(tx: BasesTx, scope: BaseScope, locked: BaseRecord): Promise<BaseRecord> {
  const [updated] = await tx
    .update(schema.bases)
    .set({
      schemaVersion: locked.schemaVersion + 1,
      updatedByActorType: scope.caller.actorType,
      updatedByActorId: scope.caller.actorId,
      updatedAt: new Date(),
    })
    .where(eq(schema.bases.id, locked.id))
    .returning();
  if (!updated) notFound();
  return updated;
}

function findPropertyByRef(properties: readonly BaseProperty[], ref: string, mode: "active" | "deleted"): BaseProperty | null {
  const trimmed = ref.trim();
  if (isBaseUuid(trimmed)) return properties.find((property) => property.id === trimmed.toLowerCase()) ?? null;
  if (mode === "active") return properties.find((property) => !property.deletedAt && property.key === trimmed) ?? null;
  const deleted = properties
    .filter((property) => property.deletedAt && property.key === trimmed)
    .sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));
  return deleted[0] ?? null;
}

async function mutationResponse(
  scope: BaseScope,
  base: BaseRecord,
  property: BaseProperty,
  report: BasePropertyMigrationReport | null,
): Promise<BasePropertyMutationResponse> {
  const rowCount = await countActiveRows(db, base.id);
  const properties = (await loadPropertyRecords(db, base.id)).map(propertyFromRecord);
  const propertiesById = new Map(properties.map((candidate) => [candidate.id, candidate]));
  return { base: baseSummaryFromRecord(base, scopeCapabilities(scope), rowCount), property: propertyToApi(property, propertiesById), report };
}

function baseEventInfo(base: BaseRecord) {
  return {
    id: base.id,
    slug: base.slug,
    name: base.name,
    organizationId: base.organizationId,
    projectId: base.projectId,
    schemaVersion: base.schemaVersion,
    timezone: base.timezone,
  };
}

function auditProperty(tx: BasesTx, scope: BaseScope, property: { id: string; key: string; type: string }, action: string, extra: JsonRecord) {
  return insertBasesAudit(tx, {
    caller: scope.caller,
    organizationId: scope.base.organizationId,
    projectId: scope.base.projectId,
    targetType: "base_property",
    targetId: property.id,
    action,
    metadata: { baseId: scope.base.id, propertyId: property.id, key: property.key, type: property.type, ...extra },
  });
}

// ---------------------------------------------------------------------------
// Create

/**
 * Manager-only views (no read or write principals) that show every active
 * property keep doing so: the new property is added before `body`. Views that
 * admit anyone else are access contracts and never widen implicitly.
 */
async function extendShowAllViews(tx: BasesTx, baseId: string, activeBefore: readonly BaseProperty[], propertyId: string) {
  const records = await tx
    .select()
    .from(schema.baseViews)
    .where(and(eq(schema.baseViews.baseId, baseId), eq(schema.baseViews.status, "active")))
    .for("update");
  for (const record of records) {
    const view = parseStoredView(record);
    if (view.access.read.length || view.access.write.principals.length) continue;
    if (view.columns.length >= BASES_LIMITS.viewColumns) continue;
    if (!activeBefore.every((property) => view.columns.includes(property.id))) continue;
    const bodyIndex = view.columns.indexOf(BASE_BODY_REF);
    const columns =
      bodyIndex >= 0
        ? [...view.columns.slice(0, bodyIndex), propertyId, ...view.columns.slice(bodyIndex)]
        : [...view.columns, propertyId];
    await tx
      .update(schema.baseViews)
      .set({ columnsJson: columns, version: record.version + 1, updatedAt: new Date() })
      .where(eq(schema.baseViews.id, record.id));
  }
}

const PROPERTY_CREATE_OPERATION = "console.bases.properties.create";

/**
 * Adds a property (200, as before keys existed). With an idempotency key the
 * same key and request replay the created property even after the schema
 * version moved on.
 */
export async function createProperty(scope: BaseScope, body: unknown, headerKey: string | null = null): Promise<BasePropertyMutationResponse> {
  requireManage(scope);
  assertProjectWritable(scope);
  const input = parseBasesBody(baseCreatePropertySchema, body);
  const { expectedSchemaVersion, idempotencyKey: bodyKey, ...definition } = input;
  const idempotencyKey = resolveOptionalBaseIdempotencyKey(bodyKey, headerKey);
  const result = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope, "property.create");
    const reservation = idempotencyKey
      ? await reserveBaseCreateOperation(tx, {
          caller: scope.caller,
          base: scope.base,
          operation: PROPERTY_CREATE_OPERATION,
          key: idempotencyKey,
          requestHash: baseCreateRequestHash(PROPERTY_CREATE_OPERATION, scope.base.id, input),
        })
      : null;
    if (reservation?.replay) return { kind: "replayed" as const, createdId: reservation.replay.createdId };
    const { locked, properties } = await lockSchema(tx, scope, expectedSchemaVersion);
    const active = properties.filter((property) => !property.deletedAt);
    if (active.length >= BASES_LIMITS.propertiesPerBase) {
      limitExceeded(`A base has at most ${BASES_LIMITS.propertiesPerBase} properties.`);
    }
    const maxPosition = properties.reduce((max, property) => Math.max(max, property.position), -1);
    const [prepared] = preparePropertyDefinitions(
      [definition],
      new Set(active.map((property) => property.key)),
      maxPosition + 1,
      () => "",
      active,
    );
    if (!prepared) throw new Error("Failed to prepare property.");
    await assertApproversAreMembers(tx, locked.organizationId, [{ config: prepared.config, field: "config" }]);
    const [record] = await tx.insert(schema.baseProperties).values(propertyInsertValues(locked, prepared)).returning();
    if (!record) throw new Error("Failed to create property.");
    const property = propertyFromRecord(record);
    await extendShowAllViews(tx, locked.id, active, property.id);
    const base = await bumpSchemaVersion(tx, scope, locked);
    await auditProperty(tx, scope, property, "bases.property.created", { schemaVersion: base.schemaVersion, required: property.required });
    let report: BasePropertyMigrationReport | null = null;
    const activeRows = property.required || property.type === "agent" ? await countActiveRows(tx, locked.id) : 0;
    if (property.required) {
      report = {
        dryRun: false,
        activeRows,
        converted: 0,
        truncated: 0,
        cleared: 0,
        missing: activeRows,
        dependents: { views: [], charts: [] },
      };
    }
    // Existing rows have no value for a new agent column: one backfill request per matching subscription.
    if (property.type === "agent" && activeRows > 0) {
      await emitBaseAgentBackfill(tx, {
        base: baseEventInfo(base),
        caller: scope.caller,
        propertyId: property.id,
        rowCount: activeRows,
      });
    }
    if (reservation) await completeBaseOperation(tx, reservation.id, { createdId: property.id });
    return { kind: "created" as const, base, property, report };
  });
  if (result.kind === "replayed") {
    const base = await findBaseRecord(db, { organizationId: scope.base.organizationId, projectId: scope.base.projectId, ref: scope.base.id });
    if (!base) notFound();
    const properties = (await loadPropertyRecords(db, base.id)).map(propertyFromRecord);
    const property = properties.find((candidate) => candidate.id === result.createdId);
    if (!property) notFound();
    return mutationResponse(scope, base, property, null);
  }
  return mutationResponse(scope, result.base, result.property, result.report);
}

// ---------------------------------------------------------------------------
// Update and migrations

type MigrationRow = { id: string; archived: boolean; value: unknown };

async function loadMigrationRows(tx: BasesTx, baseId: string, propertyId: string): Promise<MigrationRow[]> {
  const rows = await executeRows<{ id: string; archived: boolean; value: unknown }>(
    tx,
    sql`SELECT r.id, (r.archived_at IS NOT NULL) AS archived, r.values_json -> ${propertyId}::text AS value
        FROM base_rows AS r
        WHERE r.base_id = ${baseId}::uuid AND r.values_json ? ${propertyId}::text`,
  );
  return rows.map((row) => ({ id: row.id, archived: row.archived === true, value: row.value }));
}

/** Distinct display values of the rows, used as options when converting into an option type. */
function derivedOptionNames(from: BaseProperty, rows: readonly MigrationRow[], split: boolean): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const text = displayBaseValue(from, baseValueToApi(from, row.value));
    const parts = split ? text.split(",") : [text];
    for (const part of parts) {
      const name = part.trim().slice(0, 100);
      const folded = name.toLowerCase();
      if (!name || seen.has(folded)) continue;
      seen.add(folded);
      names.push(name);
      if (names.length >= BASES_LIMITS.optionsPerProperty) return names;
    }
  }
  return names;
}

function emptyReport(dryRun: boolean, activeRows: number): BasePropertyMigrationReport {
  return { dryRun, activeRows, converted: 0, truncated: 0, cleared: 0, missing: 0, dependents: { views: [], charts: [] } };
}

export async function updateProperty(scope: BaseScope, propertyRef: string, body: unknown): Promise<BasePropertyMutationResponse> {
  requireManage(scope);
  assertProjectWritable(scope);
  const input = parseBasesBody(baseUpdatePropertySchema, body);
  const result = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
    const { locked, properties } = await lockSchema(tx, scope, input.expectedSchemaVersion);
    const current = findPropertyByRef(properties, propertyRef, "active");
    if (!current || current.deletedAt) notFound();
    const fieldErrors: Record<string, string> = {};

    if (input.key !== undefined && input.key !== current.key) {
      checkExplicitKey(input.key, "key", fieldErrors);
      if (properties.some((property) => !property.deletedAt && property.id !== current.id && property.key === input.key)) {
        keyTaken("key", input.key);
      }
    }

    const nextType = input.type ?? current.type;
    const typeChanged = nextType !== current.type;
    if (typeChanged && (UNREFERENCEABLE.has(current.type) || UNREFERENCEABLE.has(nextType))) {
      validationFailed({ type: "Type changes to or from approval and agent properties are not supported." });
    }
    if (input.required === true && UNREFERENCEABLE.has(nextType)) {
      validationFailed({ required: `${nextType === "approval" ? "Approval" : "Agent"} properties cannot be required.` });
    }
    const sameFamily = typeChanged ? OPTION_TYPES.has(current.type) && OPTION_TYPES.has(nextType) : true;
    const migrationRows =
      typeChanged || (current.type === "date" && input.config?.includeTime !== undefined)
        ? await loadMigrationRows(tx, locked.id, current.id)
        : null;
    let configInput = input.config;
    if (typeChanged && OPTION_TYPES.has(nextType) && !OPTION_TYPES.has(current.type) && configInput?.options === undefined && migrationRows) {
      const names = derivedOptionNames(current, migrationRows, nextType === "multi_select");
      if (names.length) configInput = { ...(configInput ?? {}), options: names.map((name) => ({ name })) };
    }
    const config =
      input.config !== undefined || typeChanged
        ? buildPropertyConfig(
            nextType,
            configInput,
            sameFamily ? current.config : null,
            "config",
            fieldErrors,
            propertyRefResolver(
              properties.filter((property) => !property.deletedAt),
              current.id,
            ),
          )
        : current.config;
    if (Object.keys(fieldErrors).length) validationFailed(fieldErrors);
    if (input.config?.approvers !== undefined) await assertApproversAreMembers(tx, locked.organizationId, [{ config, field: "config" }]);

    const next: BaseProperty = {
      ...current,
      key: input.key ?? current.key,
      name: input.name ?? current.name,
      description: input.description !== undefined ? input.description : current.description,
      type: nextType,
      config,
      required: input.required ?? current.required,
      position: input.position ?? current.position,
    };
    const migrates = typeChanged || (current.type === "date" && (current.config.includeTime === true) !== (config.includeTime === true));

    let report: BasePropertyMigrationReport | null = null;
    const updates: Array<{ id: string; v: unknown }> = [];
    if (migrates) {
      const activeRows = await countActiveRows(tx, locked.id);
      if (activeRows > BASES_LIMITS.migrationRowsMax) {
        conflict("migration_too_large", {
          reason: `Type changes run only on bases with at most ${BASES_LIMITS.migrationRowsMax} active rows.`,
        });
      }
      let converted = 0;
      let truncated = 0;
      let cleared = 0;
      for (const row of migrationRows ?? []) {
        const outcome = convertBaseValue(current, next, row.value, { timezone: locked.timezone });
        if (!row.archived) {
          if (outcome.cleared) cleared += 1;
          else if (outcome.value !== undefined) {
            converted += 1;
            if (outcome.truncated) truncated += 1;
          }
        }
        if (!sameBaseValue(outcome.value ?? null, row.value ?? null)) updates.push({ id: row.id, v: outcome.value ?? null });
      }
      report = {
        dryRun: input.confirm !== true,
        activeRows,
        converted,
        truncated,
        cleared,
        missing: Math.max(0, activeRows - converted),
        dependents: await propertyDependents(tx, locked.id, current.id),
      };
      if (report.dryRun) return { base: locked, property: current, report };
    } else if (next.required && !current.required) {
      const activeRows = await countActiveRows(tx, locked.id);
      report = { ...emptyReport(false, activeRows), missing: await countRowsMissing(tx, locked.id, current.id) };
    }

    // Migrated rows are row mutations: new version, attribution, a ledger entry, and an event for active rows.
    const migrated: Array<{ id: string; version: number; archived: boolean }> = [];
    const migratedAt = new Date();
    for (let index = 0; index < updates.length; index += MIGRATION_UPDATE_CHUNK) {
      const chunk = updates.slice(index, index + MIGRATION_UPDATE_CHUNK);
      const rows = await executeRows<{ id: string; version: number; archived: boolean }>(
        tx,
        sql`
        UPDATE base_rows AS r
        SET values_json = CASE WHEN u.v IS NULL THEN r.values_json - ${current.id}::text
                               ELSE jsonb_set(r.values_json, ARRAY[${current.id}::text], u.v) END,
            version = r.version + 1,
            updated_by_actor_type = ${scope.caller.actorType}::actor_type,
            updated_by_actor_id = ${scope.caller.actorId},
            updated_at = ${migratedAt.toISOString()}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS u(id uuid, v jsonb)
        WHERE r.id = u.id AND r.base_id = ${locked.id}::uuid
        RETURNING r.id::text AS id, r.version, (r.archived_at IS NOT NULL) AS archived`,
      );
      migrated.push(...rows.map((row) => ({ id: row.id, version: Number(row.version), archived: row.archived === true })));
    }

    const [record] = await tx
      .update(schema.baseProperties)
      .set({
        key: next.key,
        name: next.name,
        description: next.description,
        type: next.type,
        configJson: next.config as unknown as JsonRecord,
        required: next.required,
        position: next.position,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.baseProperties.id, current.id), isNull(schema.baseProperties.deletedAt)))
      .returning();
    if (!record) notFound();
    const base = await bumpSchemaVersion(tx, scope, locked);
    const property = propertyFromRecord(record);
    if (migrated.length) {
      const valuesById = new Map(updates.map((update) => [update.id, update.v]));
      const beforeById = new Map((migrationRows ?? []).map((row) => [row.id, row.value]));
      await appendLedgerEntries(
        tx,
        locked,
        scope.caller,
        migrated.map((row) => {
          const before = beforeById.get(row.id);
          const after = valuesById.get(row.id);
          return {
            rowId: row.id,
            version: row.version,
            action: "updated",
            changedPropertyIds: [current.id],
            before: before === undefined || before === null ? {} : { [current.id]: before },
            after: after === undefined || after === null ? {} : { [current.id]: after },
            bodyChanged: false,
            lastWriteWins: false,
            viewId: null,
          };
        }),
      );
      await emitBaseRowEvents(tx, {
        base: baseEventInfo(base),
        caller: scope.caller,
        changes: migrated
          .filter((row) => !row.archived)
          .map((row) => ({ rowId: row.id, version: row.version, verb: "updated", changedPropertyCount: 1, changedPropertyIds: [current.id] })),
        occurredAt: migratedAt,
      });
    }
    await auditProperty(tx, scope, property, migrates ? "bases.property.migrated" : "bases.property.updated", {
      schemaVersion: base.schemaVersion,
      changed: Object.keys(input).filter((key) => key !== "expectedSchemaVersion" && key !== "confirm"),
      ...(migrates
        ? {
            fromType: current.type,
            toType: next.type,
            converted: report?.converted ?? 0,
            truncated: report?.truncated ?? 0,
            cleared: report?.cleared ?? 0,
          }
        : {}),
    });
    return { base, property, report };
  });
  return mutationResponse(scope, result.base, result.property, result.report);
}

// ---------------------------------------------------------------------------
// Delete and restore

export async function deleteProperty(scope: BaseScope, propertyRef: string, body: unknown): Promise<BasePropertyMutationResponse> {
  requireManage(scope);
  assertProjectWritable(scope);
  const input = parseBasesBody(baseDeletePropertySchema, body);
  const result = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
    const { locked, properties } = await lockSchema(tx, scope, input.expectedSchemaVersion);
    const current = findPropertyByRef(properties, propertyRef, "active");
    if (!current) notFound();
    if (current.deletedAt) return { base: locked, property: current, report: null };
    const activeRows = await countActiveRows(tx, locked.id);
    const report: BasePropertyMigrationReport = {
      ...emptyReport(input.confirm !== true, activeRows),
      dependents: await propertyDependents(tx, locked.id, current.id),
    };
    if (report.dryRun) return { base: locked, property: current, report };
    const now = new Date();
    const [record] = await tx
      .update(schema.baseProperties)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.baseProperties.id, current.id))
      .returning();
    if (!record) notFound();
    const base = await bumpSchemaVersion(tx, scope, locked);
    await auditProperty(tx, scope, current, "bases.property.deleted", {
      schemaVersion: base.schemaVersion,
      dependentViews: report.dependents.views.length,
      dependentCharts: report.dependents.charts.length,
    });
    return { base, property: propertyFromRecord(record), report };
  });
  return mutationResponse(scope, result.base, result.property, result.report);
}

export async function restoreProperty(scope: BaseScope, propertyRef: string, body: unknown): Promise<BasePropertyMutationResponse> {
  requireManage(scope);
  assertProjectWritable(scope);
  const input = parseBasesBody(baseRestorePropertySchema, body);
  const result = await db.transaction(async (tx) => {
    await assertCurrentBasesManagement(tx, scope);
    const { locked, properties } = await lockSchema(tx, scope, input.expectedSchemaVersion);
    const current = findPropertyByRef(properties, propertyRef, "deleted");
    if (!current) notFound();
    if (!current.deletedAt) return { base: locked, property: current };
    const active = properties.filter((property) => !property.deletedAt);
    if (active.some((property) => property.key === current.key)) keyTaken("key", current.key);
    if (active.length >= BASES_LIMITS.propertiesPerBase) {
      limitExceeded(`A base has at most ${BASES_LIMITS.propertiesPerBase} properties.`);
    }
    const [record] = await tx
      .update(schema.baseProperties)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(schema.baseProperties.id, current.id))
      .returning();
    if (!record) notFound();
    const base = await bumpSchemaVersion(tx, scope, locked);
    await auditProperty(tx, scope, current, "bases.property.restored", { schemaVersion: base.schemaVersion });
    return { base, property: propertyFromRecord(record) };
  });
  return mutationResponse(scope, result.base, result.property, null);
}
