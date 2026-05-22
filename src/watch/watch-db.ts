import { randomUUID } from "node:crypto";
import { getDb, getDbChanges } from "../router/router-db.js";
import type { EffectiveWatchPlacement, WatchListPage, WatchRecord, WatchStatus } from "./types.js";

interface WatchRow {
  id: string;
  name: string | null;
  provider: string;
  placement: string;
  status: string;
  resource_ref: string;
  provider_installation_id: string | null;
  provider_resource_id: string | null;
  event_types_json: string;
  filters_json: string;
  delivery_json: string | null;
  event_subjects_json: string;
  remote_watch_json: string | null;
  last_event_at: string | null;
  last_delivery_at: string | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  disabled_at: number | null;
  deleted_at: number | null;
}

export interface WatchUpsertInput {
  id?: string;
  name?: string | null;
  provider: string;
  placement: EffectiveWatchPlacement;
  status?: WatchStatus;
  resourceRef: string;
  providerInstallationId?: string | null;
  providerResourceId?: string | null;
  eventTypes: string[];
  filters?: Record<string, unknown>;
  delivery?: Record<string, unknown> | null;
  eventSubjects: string[];
  remoteWatch?: Record<string, unknown> | null;
  lastEventAt?: string | null;
  lastDeliveryAt?: string | null;
  lastErrorCode?: string | null;
}

export function upsertWatch(input: WatchUpsertInput): WatchRecord {
  ensureWatchSchema();
  const now = Date.now();
  const id = input.id ?? randomUUID();
  const existing = getWatch(id);
  const status = input.status ?? existing?.status ?? "active";

  if (existing) {
    getDb()
      .prepare(
        `UPDATE watches SET
          name = ?,
          provider = ?,
          placement = ?,
          status = ?,
          resource_ref = ?,
          provider_installation_id = ?,
          provider_resource_id = ?,
          event_types_json = ?,
          filters_json = ?,
          delivery_json = ?,
          event_subjects_json = ?,
          remote_watch_json = ?,
          last_event_at = ?,
          last_delivery_at = ?,
          last_error_code = ?,
          updated_at = ?,
          disabled_at = ?
        WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.provider,
        input.placement,
        status,
        input.resourceRef,
        input.providerInstallationId ?? null,
        input.providerResourceId ?? null,
        JSON.stringify(input.eventTypes),
        JSON.stringify(input.filters ?? {}),
        input.delivery ? JSON.stringify(input.delivery) : null,
        JSON.stringify(input.eventSubjects),
        input.remoteWatch ? JSON.stringify(input.remoteWatch) : null,
        input.lastEventAt ?? existing.lastEventAt,
        input.lastDeliveryAt ?? existing.lastDeliveryAt,
        input.lastErrorCode ?? existing.lastErrorCode,
        now,
        status === "disabled" ? (existing.disabledAt ?? now) : null,
        id,
      );
    return getWatch(id)!;
  }

  getDb()
    .prepare(
      `INSERT INTO watches (
        id, name, provider, placement, status, resource_ref,
        provider_installation_id, provider_resource_id, event_types_json,
        filters_json, delivery_json, event_subjects_json, remote_watch_json,
        last_event_at, last_delivery_at, last_error_code,
        created_at, updated_at, disabled_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      input.name ?? null,
      input.provider,
      input.placement,
      status,
      input.resourceRef,
      input.providerInstallationId ?? null,
      input.providerResourceId ?? null,
      JSON.stringify(input.eventTypes),
      JSON.stringify(input.filters ?? {}),
      input.delivery ? JSON.stringify(input.delivery) : null,
      JSON.stringify(input.eventSubjects),
      input.remoteWatch ? JSON.stringify(input.remoteWatch) : null,
      input.lastEventAt ?? null,
      input.lastDeliveryAt ?? null,
      input.lastErrorCode ?? null,
      now,
      now,
      status === "disabled" ? now : null,
    );

  return getWatch(id)!;
}

export function getWatch(id: string): WatchRecord | null {
  ensureWatchSchema();
  const row = getDb().prepare("SELECT * FROM watches WHERE id = ? AND deleted_at IS NULL").get(id) as
    | WatchRow
    | undefined;
  return row ? rowToWatch(row) : null;
}

export function listWatches(input: {
  provider?: string | null;
  status?: WatchStatus | "all" | null;
  limit?: number;
  offset?: number;
}): WatchListPage {
  ensureWatchSchema();
  const where = ["deleted_at IS NULL"];
  const params: Array<string | number> = [];
  if (input.provider) {
    where.push("provider = ?");
    params.push(input.provider);
  }
  if (input.status && input.status !== "all") {
    where.push("status = ?");
    params.push(input.status);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const totalRow = getDb()
    .prepare(`SELECT COUNT(*) AS total FROM watches ${whereSql}`)
    .get(...params) as { total: number } | undefined;
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  const rows = getDb()
    .prepare(`SELECT * FROM watches ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as WatchRow[];
  return {
    total: totalRow?.total ?? 0,
    items: rows.map(rowToWatch),
    limit,
    offset,
  };
}

export function updateWatchStatus(id: string, status: Exclude<WatchStatus, "deleted">): WatchRecord {
  ensureWatchSchema();
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE watches
       SET status = ?, updated_at = ?, disabled_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(status, now, status === "disabled" ? now : null, id);
  const updated = getWatch(id);
  if (!updated) throw new Error(`Watch not found: ${id}`);
  return updated;
}

export function deleteWatch(id: string): boolean {
  ensureWatchSchema();
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE watches SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    )
    .run(now, now, id);
  return getDbChanges() > 0;
}

function ensureWatchSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY,
      name TEXT,
      provider TEXT NOT NULL,
      placement TEXT NOT NULL CHECK(placement IN ('local','console')),
      status TEXT NOT NULL CHECK(status IN ('active','disabled','error','deleted')),
      resource_ref TEXT NOT NULL,
      provider_installation_id TEXT,
      provider_resource_id TEXT,
      event_types_json TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      delivery_json TEXT,
      event_subjects_json TEXT NOT NULL,
      remote_watch_json TEXT,
      last_event_at TEXT,
      last_delivery_at TEXT,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      disabled_at INTEGER,
      deleted_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_watches_provider ON watches(provider);
    CREATE INDEX IF NOT EXISTS idx_watches_status ON watches(status);
    CREATE INDEX IF NOT EXISTS idx_watches_resource ON watches(provider, resource_ref);
    CREATE INDEX IF NOT EXISTS idx_watches_remote_resource ON watches(provider_installation_id, provider_resource_id);
  `);
}

function rowToWatch(row: WatchRow): WatchRecord {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    placement: row.placement as EffectiveWatchPlacement,
    status: row.status as WatchStatus,
    resourceRef: row.resource_ref,
    providerInstallationId: row.provider_installation_id,
    providerResourceId: row.provider_resource_id,
    eventTypes: parseJsonArray(row.event_types_json),
    filters: parseJsonObject(row.filters_json),
    delivery: row.delivery_json ? parseJsonObject(row.delivery_json) : null,
    eventSubjects: parseJsonArray(row.event_subjects_json),
    remoteWatch: row.remote_watch_json ? parseJsonObject(row.remote_watch_json) : null,
    lastEventAt: row.last_event_at,
    lastDeliveryAt: row.last_delivery_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
    deletedAt: row.deleted_at,
  };
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
