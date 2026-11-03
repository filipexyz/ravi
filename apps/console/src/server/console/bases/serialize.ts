// Record -> DTO mapping for Bases. API objects use property keys; stored
// values and specs use property ids.

import { BASE_SYSTEM_COLUMNS } from "@/shared/bases/types";
import type {
  BaseCapabilities,
  BaseCellValue,
  BaseProperty,
  BasePropertyConfig,
  BasePropertyType,
  BaseRow,
  BaseStatus,
  BaseSummary,
  BaseSystemColumn,
  BaseUserRef,
  BaseViewColumn,
} from "@/shared/bases/types";
import { isBaseSystemColumn } from "@/shared/bases/operators";
import { baseValueToApi } from "@/shared/bases/values";

import type { BaseRowsQueryRow } from "./compiler";
import type { BasePropertyRecord, BaseRecord, BaseRowRecord } from "./repository";

export const BASE_BODY_REF = "body";

export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNow(value: Date | string) {
  return toIso(value) ?? new Date().toISOString();
}

export function propertyFromRecord(record: BasePropertyRecord): BaseProperty {
  return {
    id: record.id,
    key: record.key,
    name: record.name,
    description: record.description,
    type: record.type as BasePropertyType,
    config: (record.configJson ?? {}) as BasePropertyConfig,
    position: record.position,
    required: record.required,
    deletedAt: toIso(record.deletedAt),
  };
}

/**
 * Property config as the API returns it: `resetOn` and `inputs` name
 * properties by key (stored as ids; an id without a property stays as is).
 */
export function propertyConfigToApi(config: BasePropertyConfig, propertiesById: ReadonlyMap<string, BaseProperty>): BasePropertyConfig {
  if (!config.resetOn && !config.inputs) return config;
  const toKey = (id: string) => propertiesById.get(id)?.key ?? id;
  return {
    ...config,
    ...(config.resetOn ? { resetOn: config.resetOn.map(toKey) } : {}),
    ...(config.inputs ? { inputs: config.inputs.map(toKey) } : {}),
  };
}

/** A property as the API returns it (managers): config references by key. */
export function propertyToApi(property: BaseProperty, propertiesById: ReadonlyMap<string, BaseProperty>): BaseProperty {
  return { ...property, config: propertyConfigToApi(property.config, propertiesById) };
}

/**
 * Config in public column descriptors: approval columns show nothing of who
 * approves or what resets them (`capabilities.approve` says what the caller
 * may decide); agent columns show the output type, options, and agent label,
 * not their instructions or inputs (which may name non-projected columns).
 */
export function publicPropertyConfig(property: Pick<BaseProperty, "type" | "config">): BasePropertyConfig {
  if (property.type === "approval") return {};
  if (property.type === "agent") {
    const { output, options, agent } = property.config;
    return { ...(output ? { output } : {}), ...(options ? { options } : {}), ...(agent ? { agent } : {}) };
  }
  return property.config;
}

export function baseSummaryFromRecord(
  record: BaseRecord,
  capabilities: BaseCapabilities,
  rowCount: number | null,
): BaseSummary {
  return {
    id: record.id,
    organizationId: record.organizationId,
    projectId: record.projectId,
    slug: record.slug,
    name: record.name,
    description: record.description,
    icon: record.icon,
    timezone: record.timezone,
    schemaVersion: record.schemaVersion,
    version: record.version,
    status: (record.status === "archived" ? "archived" : "active") as BaseStatus,
    rowCount: capabilities.manage ? rowCount : null,
    createdAt: isoOrNow(record.createdAt),
    updatedAt: isoOrNow(record.updatedAt),
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Rows

/** Row data independent of how it was read (query builder or compiled SQL). */
export type BaseRowData = {
  id: string;
  version: number;
  values: Record<string, unknown>;
  body: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

export function rowDataFromRecord(record: BaseRowRecord): BaseRowData {
  return {
    id: record.id,
    version: record.version,
    values: (record.valuesJson ?? {}) as Record<string, unknown>,
    body: record.body ?? null,
    archivedAt: toIso(record.archivedAt),
    createdAt: isoOrNow(record.createdAt),
    updatedAt: isoOrNow(record.updatedAt),
    createdBy: record.createdByActorId,
    updatedBy: record.updatedByActorId,
  };
}

export function rowDataFromQueryRow(row: BaseRowsQueryRow): BaseRowData {
  return {
    id: row.id,
    version: Number(row.version),
    values: (row.values_json ?? {}) as Record<string, unknown>,
    body: row.body ?? null,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by_actor_id,
    updatedBy: row.updated_by_actor_id,
  };
}

/** A projected column: a property (by id), a system column, or the body. */
export type BaseProjectedColumn =
  | { ref: string; key: string; kind: "property"; property: BaseProperty }
  | { ref: BaseSystemColumn; key: BaseSystemColumn; kind: "system" }
  | { ref: "body"; key: "body"; kind: "body" };

/** Resolves stored column refs against the base properties; deleted or unknown refs are dropped. */
export function projectedColumns(refs: readonly string[], propertiesById: ReadonlyMap<string, BaseProperty>): BaseProjectedColumn[] {
  const columns: BaseProjectedColumn[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (ref === BASE_BODY_REF) columns.push({ ref: "body", key: "body", kind: "body" });
    else if (isBaseSystemColumn(ref)) columns.push({ ref, key: ref, kind: "system" });
    else {
      const property = propertiesById.get(ref);
      if (property && !property.deletedAt) columns.push({ ref, key: property.key, kind: "property", property });
    }
  }
  return columns;
}

/** Direct-read columns: every active property in position order, then the system columns. */
export function directColumns(properties: readonly BaseProperty[]): BaseProjectedColumn[] {
  const columns: BaseProjectedColumn[] = properties
    .filter((property) => !property.deletedAt)
    .map((property) => ({ ref: property.id, key: property.key, kind: "property" as const, property }));
  for (const name of BASE_SYSTEM_COLUMNS) columns.push({ ref: name, key: name, kind: "system" });
  return columns;
}

/** Projects a row to `columns` plus `rowId` and `version`. */
export function projectRow(
  row: BaseRowData,
  columns: readonly BaseProjectedColumn[],
  options: { includeBody: boolean; includeArchivedAt?: boolean },
): BaseRow {
  const values: Record<string, BaseCellValue> = {};
  let bodyProjected = false;
  for (const column of columns) {
    if (column.kind === "body") {
      bodyProjected = true;
      continue;
    }
    if (column.kind === "system") {
      values[column.key] = systemValue(row, column.key);
      continue;
    }
    const value = baseValueToApi(column.property, row.values[column.property.id]);
    if (value !== undefined) values[column.key] = value;
  }
  const projected: BaseRow = { rowId: row.id, version: row.version, values };
  if (options.includeBody && bodyProjected) projected.body = row.body;
  if (options.includeArchivedAt) projected.archivedAt = row.archivedAt;
  return projected;
}

function systemValue(row: BaseRowData, column: BaseSystemColumn): BaseCellValue {
  switch (column) {
    case "created_time":
      return row.createdAt;
    case "updated_time":
      return row.updatedAt;
    case "created_by":
      return row.createdBy;
    case "updated_by":
      return row.updatedBy;
  }
}

/** User ids an approval value names (who asked, who decided). */
export function approvalUserIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return [record.requestedBy, record.decidedBy].filter((id): id is string => typeof id === "string");
}

/** User ids referenced by projected person, approval, created_by, and updated_by values. */
export function referencedUserIds(rows: readonly BaseRow[], columns: readonly BaseProjectedColumn[]): Set<string> {
  const ids = new Set<string>();
  for (const column of columns) {
    const isPerson = column.kind === "property" && column.property.type === "person";
    const isApproval = column.kind === "property" && column.property.type === "approval";
    const isActor = column.kind === "system" && (column.key === "created_by" || column.key === "updated_by");
    if (!isPerson && !isActor && !isApproval) continue;
    for (const row of rows) {
      const value = row.values[column.key];
      if (isApproval) for (const id of approvalUserIds(value)) ids.add(id);
      else if (typeof value === "string") ids.add(value);
      else if (Array.isArray(value)) for (const item of value) if (typeof item === "string") ids.add(item);
    }
  }
  return ids;
}

const SYSTEM_COLUMN_NAMES: Record<BaseSystemColumn, string> = {
  created_time: "Created time",
  created_by: "Created by",
  updated_time: "Updated time",
  updated_by: "Updated by",
};

/** Public column descriptor: key, name, type, config (options), required. */
export function viewColumnDescriptor(column: BaseProjectedColumn): BaseViewColumn {
  if (column.kind === "body") return { key: "body", name: "Body", type: "body", config: {}, required: false };
  if (column.kind === "system") {
    return { key: column.key, name: SYSTEM_COLUMN_NAMES[column.key], type: column.key, config: {}, required: false };
  }
  return {
    key: column.property.key,
    name: column.property.name,
    type: column.property.type,
    config: publicPropertyConfig(column.property),
    required: column.property.required,
  };
}

export function emptyUsers(): Record<string, BaseUserRef> {
  return {};
}
