// Row ledger. Every row create, update, archive, restore, and purge appends
// one entry with the changed property ids and their before/after values.
// Purge deletes the row's prior entries and appends a tombstone.

import { and, desc, eq, lt } from "drizzle-orm";

import { schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import type {
  BaseActorType,
  BaseCellValue,
  BaseLedgerAction,
  BaseLedgerEntry,
  BaseProperty,
  BaseSurface,
} from "@/shared/bases/types";
import { baseValueToApi } from "@/shared/bases/values";

import { basesCallerAgent, type BasesCaller } from "./context";
import { basesServiceIdentity } from "./service-principal";
import type { BaseLedgerRecord, BasesExecutor, BasesTx } from "./repository";
import { toIso } from "./serialize";

export type BaseLedgerWrite = {
  rowId: string;
  version: number;
  action: BaseLedgerAction;
  changedPropertyIds: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  bodyChanged: boolean;
  lastWriteWins: boolean;
  viewId: string | null;
};

export function buildLedgerInsert(
  base: { id: string; organizationId: string; projectId: string },
  caller: BasesCaller,
  entry: BaseLedgerWrite,
): typeof schema.baseRowLedger.$inferInsert {
  return {
    baseId: base.id,
    rowId: entry.rowId,
    organizationId: base.organizationId,
    projectId: base.projectId,
    version: entry.version,
    action: entry.action,
    changedPropertyIds: entry.changedPropertyIds,
    beforeJson: entry.before as JsonRecord,
    afterJson: entry.after as JsonRecord,
    bodyChanged: entry.bodyChanged,
    lastWriteWins: entry.lastWriteWins,
    actorType: caller.actorType,
    actorId: caller.actorId,
    surface: caller.surface,
    viewId: entry.viewId,
    requestId: caller.requestId,
    clientHintJson: (basesServiceIdentity(caller) ? { service: basesServiceIdentity(caller) } : caller.clientHint) as JsonRecord | null,
    agentId: basesCallerAgent(caller)?.id ?? null,
    localInstallationId: basesCallerAgent(caller)?.installationId ?? null,
  };
}

export async function appendLedgerEntries(
  tx: BasesTx,
  base: { id: string; organizationId: string; projectId: string },
  caller: BasesCaller,
  entries: BaseLedgerWrite[],
) {
  if (!entries.length) return;
  for (let index = 0; index < entries.length; index += 200) {
    await tx.insert(schema.baseRowLedger).values(entries.slice(index, index + 200).map((entry) => buildLedgerInsert(base, caller, entry)));
  }
}

/** Ledger entries of a row, newest first, before `beforeSequence` when given. */
export async function loadLedgerPage(
  executor: BasesExecutor,
  input: { baseId: string; rowId: string; beforeSequence: number | null; limit: number },
): Promise<BaseLedgerRecord[]> {
  const conditions = [eq(schema.baseRowLedger.baseId, input.baseId), eq(schema.baseRowLedger.rowId, input.rowId)];
  if (input.beforeSequence !== null) conditions.push(lt(schema.baseRowLedger.sequence, input.beforeSequence));
  return executor
    .select()
    .from(schema.baseRowLedger)
    .where(and(...conditions))
    .orderBy(desc(schema.baseRowLedger.sequence))
    .limit(input.limit);
}

export type LedgerVisibility = {
  /** Property ids whose changes the caller may see; null means every property. */
  propertyIds: ReadonlySet<string> | null;
  bodyVisible: boolean;
  /** Through a view: hide entries that touch only non-projected columns. */
  skipInvisibleUpdates: boolean;
  /** Only this view id is shown; other views become null. Undefined shows every view id. */
  viewId?: string | null;
  /**
   * Which actor and time columns the caller can read. An entry's actor
   * (actor type, id, surface) is shown with `updated_by`, or with `created_by`
   * for `created` entries; its time likewise with `updated_time` or
   * `created_time`. Undefined shows both.
   */
  systemColumns?: ReadonlySet<string>;
};

function systemVisible(visibility: LedgerVisibility, action: string, updated: string, created: string) {
  const columns = visibility.systemColumns;
  return !columns || columns.has(updated) || (action === "created" && columns.has(created));
}

/** Maps a ledger record to the API, limited to visible columns; null when the entry is hidden. */
export function ledgerEntryToApi(
  record: BaseLedgerRecord,
  propertiesById: ReadonlyMap<string, BaseProperty>,
  visibility: LedgerVisibility,
): BaseLedgerEntry | null {
  const changedIds = (Array.isArray(record.changedPropertyIds) ? record.changedPropertyIds : []).filter(
    (id) => typeof id === "string" && (visibility.propertyIds === null || visibility.propertyIds.has(id)),
  );
  const bodyChanged = record.bodyChanged && visibility.bodyVisible;
  if (visibility.skipInvisibleUpdates && record.action === "updated" && !changedIds.length && !bodyChanged) return null;
  const before: Record<string, BaseCellValue> = {};
  const after: Record<string, BaseCellValue> = {};
  const changedKeys: string[] = [];
  const beforeJson = (record.beforeJson ?? {}) as Record<string, unknown>;
  const afterJson = (record.afterJson ?? {}) as Record<string, unknown>;
  for (const id of changedIds) {
    const property = propertiesById.get(id);
    if (!property) continue;
    changedKeys.push(property.key);
    before[property.key] = baseValueToApi(property, beforeJson[id]) ?? null;
    after[property.key] = baseValueToApi(property, afterJson[id]) ?? null;
  }
  const viewId =
    visibility.viewId === undefined ? record.viewId : record.viewId && record.viewId === visibility.viewId ? record.viewId : null;
  const actorVisible = systemVisible(visibility, record.action, "updated_by", "created_by");
  const timeVisible = systemVisible(visibility, record.action, "updated_time", "created_time");
  return {
    id: record.id,
    sequence: Number(record.sequence),
    rowId: record.rowId,
    version: record.version,
    action: record.action as BaseLedgerAction,
    changedKeys,
    before,
    after,
    bodyChanged,
    actorType: actorVisible ? (record.actorType as BaseActorType) : null,
    actorId: actorVisible ? record.actorId : null,
    surface: actorVisible ? (record.surface as BaseSurface) : null,
    viewId,
    lastWriteWins: record.lastWriteWins,
    createdAt: timeVisible ? (toIso(record.createdAt) ?? new Date().toISOString()) : null,
    // The installation is shown only where every system column is (managers and direct readers).
    agent:
      actorVisible && record.agentId
        ? { id: record.agentId, installationId: visibility.systemColumns ? null : (record.localInstallationId ?? null) }
        : null,
  };
}
