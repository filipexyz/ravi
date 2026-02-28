/**
 * Triggers Database Operations
 *
 * CRUD operations for event triggers stored in SQLite.
 */

import { randomUUID } from "node:crypto";
import { getDb, getDbChanges } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import type { Trigger, TriggerInput, SessionTarget } from "./types.js";

const log = logger.child("triggers:db");

// ============================================================================
// Row Types
// ============================================================================

interface TriggerRow {
  id: string;
  name: string;
  agent_id: string | null;
  account_id: string | null;
  topic: string;
  message: string;
  session: string;
  reply_session: string | null;
  enabled: number;
  cooldown_ms: number;
  filter: string | null;
  last_fired_at: number | null;
  fire_count: number;
  created_at: number;
  updated_at: number;
}

// ============================================================================
// Row Mapping
// ============================================================================

function rowToTrigger(row: TriggerRow): Trigger {
  const trigger: Trigger = {
    id: row.id,
    name: row.name,
    topic: row.topic,
    message: row.message,
    session: row.session as SessionTarget,
    enabled: row.enabled === 1,
    cooldownMs: row.cooldown_ms,
    fireCount: row.fire_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.agent_id !== null) trigger.agentId = row.agent_id;
  if (row.account_id !== null) trigger.accountId = row.account_id;
  if (row.reply_session !== null) trigger.replySession = row.reply_session;
  if (row.filter !== null) trigger.filter = row.filter;
  if (row.last_fired_at !== null) trigger.lastFiredAt = row.last_fired_at;

  return trigger;
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Create a new trigger.
 */
export function dbCreateTrigger(input: TriggerInput): Trigger {
  const db = getDb();
  const id = randomUUID().slice(0, 8);
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO triggers (
      id, name, agent_id, account_id, topic, message, session, reply_session, enabled, cooldown_ms,
      filter, fire_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    input.name,
    input.agentId ?? null,
    input.accountId ?? null,
    input.topic,
    input.message,
    input.session ?? "isolated",
    input.replySession ?? null,
    input.enabled !== false ? 1 : 0,
    input.cooldownMs ?? 5000,
    input.filter ?? null,
    0,
    now,
    now,
  );

  log.info("Created trigger", { id, name: input.name, topic: input.topic });
  return dbGetTrigger(id)!;
}

/**
 * Get a trigger by ID.
 */
export function dbGetTrigger(id: string): Trigger | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM triggers WHERE id = ?");
  const row = stmt.get(id) as TriggerRow | undefined;
  return row ? rowToTrigger(row) : null;
}

/**
 * List all triggers.
 */
export function dbListTriggers(opts?: { enabledOnly?: boolean }): Trigger[] {
  const db = getDb();
  const sql = opts?.enabledOnly
    ? "SELECT * FROM triggers WHERE enabled = 1 ORDER BY created_at DESC"
    : "SELECT * FROM triggers ORDER BY created_at DESC";
  const stmt = db.prepare(sql);
  const rows = stmt.all() as TriggerRow[];
  return rows.map(rowToTrigger);
}

/**
 * Update a trigger.
 */
export function dbUpdateTrigger(id: string, updates: Partial<Trigger>): Trigger {
  const db = getDb();
  const existing = dbGetTrigger(id);

  if (!existing) {
    throw new Error(`Trigger not found: ${id}`);
  }

  const now = Date.now();

  type SQLValue = string | number | null;
  const fields: string[] = [];
  const values: SQLValue[] = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.agentId !== undefined) {
    fields.push("agent_id = ?");
    values.push(updates.agentId ?? null);
  }
  if (updates.accountId !== undefined) {
    fields.push("account_id = ?");
    values.push(updates.accountId ?? null);
  }
  if (updates.topic !== undefined) {
    fields.push("topic = ?");
    values.push(updates.topic);
  }
  if (updates.message !== undefined) {
    fields.push("message = ?");
    values.push(updates.message);
  }
  if (updates.session !== undefined) {
    fields.push("session = ?");
    values.push(updates.session);
  }
  if (updates.replySession !== undefined) {
    fields.push("reply_session = ?");
    values.push(updates.replySession ?? null);
  }
  if (updates.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.cooldownMs !== undefined) {
    fields.push("cooldown_ms = ?");
    values.push(updates.cooldownMs);
  }
  if (updates.filter !== undefined) {
    fields.push("filter = ?");
    values.push(updates.filter ?? null);
  }

  if (fields.length === 0) {
    return existing;
  }

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  const sql = `UPDATE triggers SET ${fields.join(", ")} WHERE id = ?`;
  db.prepare(sql).run(...values);

  log.info("Updated trigger", { id });
  return dbGetTrigger(id)!;
}

/**
 * Delete a trigger.
 */
export function dbDeleteTrigger(id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
  const deleted = getDbChanges() > 0;
  if (deleted) {
    log.info("Deleted trigger", { id });
  }
  return deleted;
}

/**
 * Update trigger state after firing.
 */
export function dbUpdateTriggerState(id: string, state: { lastFiredAt: number; incrementFire: boolean }): void {
  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    UPDATE triggers SET
      last_fired_at = ?,
      fire_count = fire_count + ?,
      updated_at = ?
    WHERE id = ?
  `);

  stmt.run(state.lastFiredAt, state.incrementFire ? 1 : 0, now, id);

  log.debug("Updated trigger state", { id });
}
