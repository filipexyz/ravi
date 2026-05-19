/**
 * Local SQLite operations for the Console agent-inbox mirror.
 */

import { randomUUID } from "node:crypto";
import { getDb, getDbChanges } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import type { InboxItemRow, InboxSubscriptionRow, InboxSubscriptionStatus } from "./types.js";

const log = logger.child("inbox:db");

interface SubscriptionRowRaw {
  id: string;
  console_url: string;
  organization_id: string;
  subscription_id: string | null;
  installation_id: string;
  status: string;
  enabled: number;
  last_generation: number | null;
  last_sequence: number | null;
  last_poll_at: number | null;
  last_success_at: number | null;
  last_error_code: string | null;
  last_error_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ItemRowRaw {
  id: number;
  console_url: string;
  organization_id: string;
  subscription_id: string;
  item_id: string;
  sequence: number;
  event_type: string;
  category: string;
  severity: string;
  dedupe_key: string;
  nats_subject: string;
  nats_payload_json: string;
  delivered_at: number | null;
  acked_at: number | null;
  replay_count: number;
  created_at: number;
  updated_at: number;
}

function rowToSubscription(row: SubscriptionRowRaw): InboxSubscriptionRow {
  return {
    id: row.id,
    consoleUrl: row.console_url,
    organizationId: row.organization_id,
    subscriptionId: row.subscription_id,
    installationId: row.installation_id,
    status: row.status as InboxSubscriptionStatus,
    enabled: row.enabled === 1,
    lastGeneration: row.last_generation,
    lastSequence: row.last_sequence,
    lastPollAt: row.last_poll_at,
    lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToItem(row: ItemRowRaw): InboxItemRow {
  return {
    id: row.id,
    consoleUrl: row.console_url,
    organizationId: row.organization_id,
    subscriptionId: row.subscription_id,
    itemId: row.item_id,
    sequence: row.sequence,
    eventType: row.event_type,
    category: row.category,
    severity: row.severity,
    dedupeKey: row.dedupe_key,
    natsSubject: row.nats_subject,
    natsPayloadJson: row.nats_payload_json,
    deliveredAt: row.delivered_at,
    ackedAt: row.acked_at,
    replayCount: row.replay_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Get a subscription row for a given (consoleUrl, organizationId), creating it
 * if missing. Returns the existing row when present so the enabled flag and
 * cursor survive across daemon restarts.
 */
export function ensureSubscriptionRow(input: {
  consoleUrl: string;
  organizationId: string;
  installationId: string;
}): InboxSubscriptionRow {
  const existing = getSubscriptionByOrg(input.consoleUrl, input.organizationId);
  if (existing) {
    if (existing.installationId !== input.installationId) {
      // CLI re-login rotated the installation. The remote subscription is
      // pinned to the old installation_id on the server, so we must drop
      // our local pointer and let the next tick upsert a fresh global
      // subscription against the new installation. Also reset the cursor
      // because the new subscription starts at sequence 0.
      resetSubscriptionForInstallationRotation(existing.id, input.installationId);
      log.info("Inbox subscription installation rotated", {
        consoleUrl: input.consoleUrl,
        organizationId: input.organizationId,
        previousInstallationId: existing.installationId,
        nextInstallationId: input.installationId,
      });
      const refreshed = getSubscriptionByOrg(input.consoleUrl, input.organizationId);
      if (!refreshed) throw new Error("Failed to refresh inbox subscription row after rotation.");
      return refreshed;
    }
    return existing;
  }

  const now = Date.now();
  const id = randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO console_inbox_subscriptions (
       id, console_url, organization_id, subscription_id, installation_id,
       status, enabled, last_generation, last_sequence, last_poll_at,
       last_success_at, last_error_code, last_error_at, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, ?, 'active', 1, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(id, input.consoleUrl, input.organizationId, input.installationId, now, now);

  const row = getSubscriptionByOrg(input.consoleUrl, input.organizationId);
  if (!row) throw new Error("Failed to create inbox subscription row.");
  log.info("Created inbox subscription row", {
    consoleUrl: input.consoleUrl,
    organizationId: input.organizationId,
  });
  return row;
}

export function getSubscriptionByOrg(consoleUrl: string, organizationId: string): InboxSubscriptionRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM console_inbox_subscriptions
       WHERE console_url = ? AND organization_id = ?`,
    )
    .get(consoleUrl, organizationId) as SubscriptionRowRaw | undefined;
  return row ? rowToSubscription(row) : null;
}

export function listSubscriptions(opts?: { enabledOnly?: boolean }): InboxSubscriptionRow[] {
  const sql = opts?.enabledOnly
    ? `SELECT * FROM console_inbox_subscriptions WHERE enabled = 1 ORDER BY created_at ASC`
    : `SELECT * FROM console_inbox_subscriptions ORDER BY created_at ASC`;
  const rows = getDb().prepare(sql).all() as SubscriptionRowRaw[];
  return rows.map(rowToSubscription);
}

export function setSubscriptionEnabled(id: string, enabled: boolean): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE console_inbox_subscriptions
       SET enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(enabled ? 1 : 0, now, id);
}

export function updateSubscriptionRemoteId(id: string, subscriptionId: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE console_inbox_subscriptions
       SET subscription_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(subscriptionId, now, id);
}

function resetSubscriptionForInstallationRotation(id: string, installationId: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE console_inbox_subscriptions
       SET installation_id = ?,
           subscription_id = NULL,
           last_generation = NULL,
           last_sequence = NULL,
           last_error_code = NULL,
           last_error_at = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(installationId, now, id);
}

export function markSubscriptionPolled(
  id: string,
  update: {
    generation?: number | null;
    latestSequence?: number | null;
    lastSequence?: number | null;
    status?: InboxSubscriptionStatus;
    success?: boolean;
    errorCode?: string | null;
  },
): void {
  const now = Date.now();
  const sets: string[] = ["last_poll_at = ?", "updated_at = ?"];
  const values: Array<string | number | null> = [now, now];

  if (update.generation !== undefined) {
    sets.push("last_generation = ?");
    values.push(update.generation);
  }
  if (update.latestSequence !== undefined && update.latestSequence !== null) {
    // latestSequence on the watermark — track it so pulse handlers can compare.
    // We do not have a dedicated column; reuse last_generation? No, we have last_generation.
    // Sequence is tracked via lastSequence (the local cursor).
  }
  if (update.lastSequence !== undefined && update.lastSequence !== null) {
    sets.push("last_sequence = ?");
    values.push(update.lastSequence);
  }
  if (update.status !== undefined) {
    sets.push("status = ?");
    values.push(update.status);
  }
  if (update.success) {
    sets.push("last_success_at = ?");
    values.push(now);
    sets.push("last_error_code = ?");
    values.push(null);
    sets.push("last_error_at = ?");
    values.push(null);
  } else if (update.errorCode !== undefined) {
    sets.push("last_error_code = ?");
    values.push(update.errorCode);
    sets.push("last_error_at = ?");
    values.push(now);
  }

  values.push(id);
  const sql = `UPDATE console_inbox_subscriptions SET ${sets.join(", ")} WHERE id = ?`;
  getDb()
    .prepare(sql)
    .run(...values);
}

/**
 * Insert a delivered item, or update an existing one if the (consoleUrl,
 * organizationId, itemId) already exists. Returns whether a new row was created.
 */
export function upsertDeliveredItem(input: {
  consoleUrl: string;
  organizationId: string;
  subscriptionId: string;
  itemId: string;
  sequence: number;
  eventType: string;
  category: string;
  severity: string;
  dedupeKey: string;
  natsSubject: string;
  natsPayloadJson: string;
  deliveredAt: number | null;
}): { created: boolean; row: InboxItemRow } {
  const now = Date.now();
  const existing = getDb()
    .prepare(
      `SELECT * FROM console_inbox_items
       WHERE console_url = ? AND organization_id = ? AND item_id = ?`,
    )
    .get(input.consoleUrl, input.organizationId, input.itemId) as ItemRowRaw | undefined;

  if (existing) {
    getDb()
      .prepare(
        `UPDATE console_inbox_items SET
           sequence = ?,
           event_type = ?,
           category = ?,
           severity = ?,
           dedupe_key = ?,
           nats_subject = ?,
           nats_payload_json = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.sequence,
        input.eventType,
        input.category,
        input.severity,
        input.dedupeKey,
        input.natsSubject,
        input.natsPayloadJson,
        now,
        existing.id,
      );
    const refreshed = getDb().prepare(`SELECT * FROM console_inbox_items WHERE id = ?`).get(existing.id) as ItemRowRaw;
    return { created: false, row: rowToItem(refreshed) };
  }

  getDb()
    .prepare(
      `INSERT INTO console_inbox_items (
         console_url, organization_id, subscription_id, item_id, sequence,
         event_type, category, severity, dedupe_key, nats_subject,
         nats_payload_json, delivered_at, acked_at, replay_count,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
    )
    .run(
      input.consoleUrl,
      input.organizationId,
      input.subscriptionId,
      input.itemId,
      input.sequence,
      input.eventType,
      input.category,
      input.severity,
      input.dedupeKey,
      input.natsSubject,
      input.natsPayloadJson,
      input.deliveredAt,
      now,
      now,
    );
  const created = getDb()
    .prepare(
      `SELECT * FROM console_inbox_items
       WHERE console_url = ? AND organization_id = ? AND item_id = ?`,
    )
    .get(input.consoleUrl, input.organizationId, input.itemId) as ItemRowRaw;
  return { created: true, row: rowToItem(created) };
}

export function markItemDelivered(id: number, at: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE console_inbox_items
       SET delivered_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(at, now, id);
}

export function markItemAcked(id: number, at: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE console_inbox_items
       SET acked_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(at, now, id);
}

export function incrementItemReplayCount(id: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE console_inbox_items
       SET replay_count = replay_count + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(now, id);
}

export function getItemById(id: number): InboxItemRow | null {
  const row = getDb().prepare(`SELECT * FROM console_inbox_items WHERE id = ?`).get(id) as ItemRowRaw | undefined;
  return row ? rowToItem(row) : null;
}

export function getItemByItemId(consoleUrl: string, organizationId: string, itemId: string): InboxItemRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM console_inbox_items
       WHERE console_url = ? AND organization_id = ? AND item_id = ?`,
    )
    .get(consoleUrl, organizationId, itemId) as ItemRowRaw | undefined;
  return row ? rowToItem(row) : null;
}

export function listRecentItems(opts: {
  consoleUrl?: string;
  organizationId?: string;
  limit?: number;
}): InboxItemRow[] {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (opts.consoleUrl) {
    where.push("console_url = ?");
    values.push(opts.consoleUrl);
  }
  if (opts.organizationId) {
    where.push("organization_id = ?");
    values.push(opts.organizationId);
  }
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 500);
  values.push(limit);
  const sql = `SELECT * FROM console_inbox_items ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY sequence DESC LIMIT ?`;
  const rows = getDb()
    .prepare(sql)
    .all(...values) as ItemRowRaw[];
  return rows.map(rowToItem);
}

/** Count items pending delivery or ack (used by `ravi inbox status`). */
export function countPendingItems(subscriptionId: string): { undelivered: number; unacked: number } {
  const row = getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN delivered_at IS NULL THEN 1 ELSE 0 END) AS undelivered,
         SUM(CASE WHEN acked_at IS NULL THEN 1 ELSE 0 END) AS unacked
       FROM console_inbox_items
       WHERE subscription_id = ?`,
    )
    .get(subscriptionId) as { undelivered: number | null; unacked: number | null };
  return {
    undelivered: row.undelivered ?? 0,
    unacked: row.unacked ?? 0,
  };
}

export function deleteSubscription(id: string): boolean {
  getDb().prepare(`DELETE FROM console_inbox_items WHERE subscription_id = ?`).run(id);
  getDb().prepare(`DELETE FROM console_inbox_subscriptions WHERE id = ?`).run(id);
  return getDbChanges() > 0;
}
