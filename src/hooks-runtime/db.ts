import { randomUUID } from "node:crypto";
import type { Statement } from "bun:sqlite";
import { getDb, getDbChanges } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import type { HookInput, HookRecord, HookStateUpdateInput } from "./types.js";

const log = logger.child("hooks:db");

interface HookRow {
  id: string;
  name: string;
  event_name: string;
  scope_type: string;
  scope_value: string | null;
  matcher: string | null;
  action_type: string;
  action_payload_json: string;
  enabled: number;
  async: number;
  cooldown_ms: number;
  dedupe_key: string | null;
  last_fired_at: number | null;
  last_dedupe_key: string | null;
  fire_count: number;
  created_at: number;
  updated_at: number;
}

interface HookStatements {
  create: Statement;
  getById: Statement;
  listAll: Statement;
  listEnabled: Statement;
  deleteById: Statement;
  updateState: Statement;
}

let ensuredSchema = false;
let statements: HookStatements | null = null;

function ensureHooksSchema(): void {
  if (ensuredSchema) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS hooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      event_name TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('global','agent','session','workspace','task')),
      scope_value TEXT,
      matcher TEXT,
      action_type TEXT NOT NULL CHECK(action_type IN ('inject_context','send_session_event','append_history','comment_task')),
      action_payload_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      async INTEGER NOT NULL DEFAULT 0 CHECK(async IN (0,1)),
      cooldown_ms INTEGER NOT NULL DEFAULT 0,
      dedupe_key TEXT,
      last_fired_at INTEGER,
      last_dedupe_key TEXT,
      fire_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hooks_enabled ON hooks(enabled);
    CREATE INDEX IF NOT EXISTS idx_hooks_event ON hooks(event_name);
    CREATE INDEX IF NOT EXISTS idx_hooks_scope ON hooks(scope_type, scope_value);
  `);
  ensuredSchema = true;
}

function getStatements(): HookStatements {
  ensureHooksSchema();
  if (statements) return statements;

  const db = getDb();
  statements = {
    create: db.prepare(`
      INSERT INTO hooks (
        id, name, event_name, scope_type, scope_value, matcher, action_type, action_payload_json,
        enabled, async, cooldown_ms, dedupe_key, fire_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getById: db.prepare("SELECT * FROM hooks WHERE id = ?"),
    listAll: db.prepare("SELECT * FROM hooks ORDER BY created_at DESC"),
    listEnabled: db.prepare("SELECT * FROM hooks WHERE enabled = 1 ORDER BY created_at DESC"),
    deleteById: db.prepare("DELETE FROM hooks WHERE id = ?"),
    updateState: db.prepare(`
      UPDATE hooks
      SET last_fired_at = ?, last_dedupe_key = ?, fire_count = fire_count + ?, updated_at = ?
      WHERE id = ?
    `),
  };

  return statements;
}

function parsePayload(raw: string): HookRecord["actionPayload"] {
  try {
    return JSON.parse(raw) as HookRecord["actionPayload"];
  } catch {
    return {} as HookRecord["actionPayload"];
  }
}

function rowToHook(row: HookRow): HookRecord {
  return {
    id: row.id,
    name: row.name,
    eventName: row.event_name as HookRecord["eventName"],
    scopeType: row.scope_type as HookRecord["scopeType"],
    ...(row.scope_value ? { scopeValue: row.scope_value } : {}),
    ...(row.matcher ? { matcher: row.matcher } : {}),
    actionType: row.action_type as HookRecord["actionType"],
    actionPayload: parsePayload(row.action_payload_json),
    enabled: row.enabled === 1,
    async: row.async === 1,
    cooldownMs: row.cooldown_ms,
    ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    ...(row.last_fired_at !== null ? { lastFiredAt: row.last_fired_at } : {}),
    ...(row.last_dedupe_key ? { lastDedupeKey: row.last_dedupe_key } : {}),
    fireCount: row.fire_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function dbCreateHook(input: HookInput): HookRecord {
  const s = getStatements();
  const id = randomUUID().slice(0, 8);
  const now = Date.now();
  s.create.run(
    id,
    input.name,
    input.eventName,
    input.scopeType ?? "global",
    input.scopeValue ?? null,
    input.matcher ?? null,
    input.actionType,
    JSON.stringify(input.actionPayload ?? {}),
    input.enabled !== false ? 1 : 0,
    input.async ? 1 : 0,
    input.cooldownMs ?? 0,
    input.dedupeKey ?? null,
    0,
    now,
    now,
  );
  log.info("Created hook", { id, name: input.name, eventName: input.eventName, actionType: input.actionType });
  return dbGetHook(id)!;
}

export function dbGetHook(id: string): HookRecord | null {
  const row = getStatements().getById.get(id) as HookRow | undefined;
  return row ? rowToHook(row) : null;
}

export function dbListHooks(options?: { enabledOnly?: boolean }): HookRecord[] {
  const rows = (options?.enabledOnly ? getStatements().listEnabled.all() : getStatements().listAll.all()) as HookRow[];
  return rows.map(rowToHook);
}

type HookUpdateInput = Partial<
  Pick<
    HookRecord,
    | "name"
    | "eventName"
    | "scopeType"
    | "scopeValue"
    | "matcher"
    | "actionType"
    | "actionPayload"
    | "enabled"
    | "async"
    | "cooldownMs"
    | "dedupeKey"
  >
>;

export function dbUpdateHook(id: string, updates: HookUpdateInput): HookRecord {
  const existing = dbGetHook(id);
  if (!existing) {
    throw new Error(`Hook not found: ${id}`);
  }

  const db = getDb();
  const now = Date.now();
  const fields: string[] = [];
  const values: Array<string | number | null> = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.eventName !== undefined) {
    fields.push("event_name = ?");
    values.push(updates.eventName);
  }
  if (updates.scopeType !== undefined) {
    fields.push("scope_type = ?");
    values.push(updates.scopeType);
  }
  if (updates.scopeValue !== undefined) {
    fields.push("scope_value = ?");
    values.push(updates.scopeValue ?? null);
  }
  if (updates.matcher !== undefined) {
    fields.push("matcher = ?");
    values.push(updates.matcher ?? null);
  }
  if (updates.actionType !== undefined) {
    fields.push("action_type = ?");
    values.push(updates.actionType);
  }
  if (updates.actionPayload !== undefined) {
    fields.push("action_payload_json = ?");
    values.push(JSON.stringify(updates.actionPayload ?? {}));
  }
  if (updates.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.async !== undefined) {
    fields.push("async = ?");
    values.push(updates.async ? 1 : 0);
  }
  if (updates.cooldownMs !== undefined) {
    fields.push("cooldown_ms = ?");
    values.push(updates.cooldownMs);
  }
  if (updates.dedupeKey !== undefined) {
    fields.push("dedupe_key = ?");
    values.push(updates.dedupeKey ?? null);
  }

  if (fields.length === 0) {
    return existing;
  }

  fields.push("updated_at = ?");
  values.push(now, id);

  db.prepare(`UPDATE hooks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  log.info("Updated hook", { id });
  return dbGetHook(id)!;
}

export function dbDeleteHook(id: string): boolean {
  getStatements().deleteById.run(id);
  const deleted = getDbChanges() > 0;
  if (deleted) {
    log.info("Deleted hook", { id });
  }
  return deleted;
}

export function dbUpdateHookState(id: string, input: HookStateUpdateInput): void {
  getStatements().updateState.run(
    input.lastFiredAt,
    input.lastDedupeKey ?? null,
    input.incrementFire === false ? 0 : 1,
    Date.now(),
    id,
  );
}
