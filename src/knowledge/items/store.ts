// The local contact-memory item store (contract §13.2), in knowledge.db.
// Items stay on this machine (D4). An item's ref is `ki:<id>`.
//
// Supersession: a new active item with the same (scope, subject, agent, kind,
// key) archives the old one and points it at the new one, except that an
// item never supersedes one of a higher trust tier (a `said` item never
// supersedes an `approved` one): it is kept as a draft instead.

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { executeWrite } from "../../db/write-retry.js";
import { getKnowledgeDb } from "../store/db.js";
import { TRUST_ORDER, type KnowledgeTrustTier } from "../types.js";

export type KnowledgeItem = {
  id: string;
  scope: "contact" | "chat";
  subjectId: string;
  agentId: string | null;
  kind: "fact" | "preference" | "open_loop" | "commitment";
  key: string;
  body: string;
  status: "draft" | "active" | "archived" | "redacted";
  trust: KnowledgeTrustTier;
  speaker: "operator" | "contact" | "agent" | null;
  recordedAt: number;
  expiresAt: number | null;
  supersededBy: string | null;
  createdBy: "operator" | "curator" | "marker";
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeItemSourceInput = {
  kind: "message" | "operator" | "meeting";
  ref: string;
  textHash: string;
  span?: string;
};

export const KNOWLEDGE_ITEM_KINDS: readonly KnowledgeItem["kind"][] = ["fact", "preference", "open_loop", "commitment"];
export const KNOWLEDGE_DRAFT_TTL_MS = 7 * 24 * 60 * 60_000;
export const REDACTED_BODY = "[redacted]";

interface ItemRow {
  id: string;
  scope: KnowledgeItem["scope"];
  subject_id: string;
  agent_id: string | null;
  kind: KnowledgeItem["kind"];
  key: string;
  body: string;
  status: KnowledgeItem["status"];
  trust: KnowledgeTrustTier;
  speaker: KnowledgeItem["speaker"];
  recorded_at: number;
  expires_at: number | null;
  superseded_by: string | null;
  created_by: KnowledgeItem["createdBy"];
  created_at: number;
  updated_at: number;
}

export function insertKnowledgeItem(
  input: Omit<KnowledgeItem, "id" | "createdAt" | "updatedAt"> & { sources: KnowledgeItemSourceInput[] },
): KnowledgeItem {
  const id = randomUUID();
  const now = Date.now();
  const subjectId = input.subjectId.trim();
  if (!subjectId) throw new Error("A knowledge item needs a subject id");
  const key = input.key.trim();
  if (!key) throw new Error("A knowledge item needs a key");
  return executeWrite(
    getKnowledgeDb(),
    (db) => {
      let status = input.status;
      let expiresAt = input.expiresAt;
      if (status === "active") {
        const current = findActiveSameKey(db, { ...input, subjectId, key });
        if (current && outranks(current.trust, input.trust)) {
          // Kept for the operator to confirm; never replaces higher-trust memory.
          status = "draft";
          expiresAt = expiresAt ?? now + KNOWLEDGE_DRAFT_TTL_MS;
        } else if (current) {
          archiveSuperseded(db, current.id, id, now);
        }
      }
      db.prepare(
        `INSERT INTO knowledge_items (id, scope, subject_id, agent_id, kind, key, body, status, trust, speaker,
           recorded_at, expires_at, superseded_by, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.scope,
        subjectId,
        input.agentId ?? null,
        input.kind,
        key,
        input.body,
        status,
        input.trust,
        input.speaker ?? null,
        input.recordedAt,
        expiresAt ?? null,
        input.supersededBy ?? null,
        input.createdBy,
        now,
        now,
      );
      const insertSource = db.prepare(
        `INSERT OR IGNORE INTO knowledge_item_sources (item_id, source_kind, source_ref, text_hash, span)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const source of input.sources) {
        insertSource.run(id, source.kind, source.ref, source.textHash, source.span ?? null);
      }
      return readItem(db, id) as KnowledgeItem;
    },
    { label: "knowledge_item_insert" },
  );
}

/** Active, unexpired items for the subject where `agent_id = agentId OR agent_id IS NULL`, newest first. */
export function listActiveItemsForSubject(input: {
  scope: "contact" | "chat";
  subjectId: string;
  agentId: string;
  limit: number;
  now?: number;
}): KnowledgeItem[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
  const rows = getKnowledgeDb()
    .prepare(
      `SELECT * FROM knowledge_items
       WHERE scope = ? AND subject_id = ? AND status = 'active' AND (agent_id = ? OR agent_id IS NULL)
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY recorded_at DESC, created_at DESC LIMIT ?`,
    )
    .all(input.scope, input.subjectId.trim(), input.agentId, input.now ?? Date.now(), limit) as ItemRow[];
  return rows.map(toItem);
}

/** Accepts the bare id or the `ki:` ref. */
export function getKnowledgeItem(id: string): KnowledgeItem | null {
  return readItem(getKnowledgeDb(), stripItemRef(id));
}

export function archiveItemsForSubject(input: { scope: "contact" | "chat"; subjectId: string }): number {
  const now = Date.now();
  return executeWrite(
    getKnowledgeDb(),
    (db) =>
      db
        .prepare(
          "UPDATE knowledge_items SET status = 'archived', updated_at = ? WHERE scope = ? AND subject_id = ? AND status IN ('active','draft')",
        )
        .run(now, input.scope, input.subjectId.trim()).changes,
    { label: "knowledge_items_archive_subject" },
  );
}

/** body = "[redacted]", status redacted, sources span = null. */
export function redactItemsForSubject(input: { scope: "contact" | "chat"; subjectId: string }): number {
  const ids = (
    getKnowledgeDb()
      .prepare("SELECT id FROM knowledge_items WHERE scope = ? AND subject_id = ? AND status != 'redacted'")
      .all(input.scope, input.subjectId.trim()) as Array<{ id: string }>
  ).map((row) => row.id);
  return redactKnowledgeItems(ids);
}

/** Archives one active or draft item. Returns whether it changed. */
export function archiveKnowledgeItem(id: string): boolean {
  const now = Date.now();
  return executeWrite(
    getKnowledgeDb(),
    (db) =>
      db
        .prepare(
          "UPDATE knowledge_items SET status = 'archived', updated_at = ? WHERE id = ? AND status IN ('active','draft')",
        )
        .run(now, stripItemRef(id)).changes > 0,
    { label: "knowledge_item_archive" },
  );
}

/**
 * Overwrites the text of these items and leaves tombstones: body and key
 * become "[redacted]", spans are cleared. Returns how many changed.
 */
export function redactKnowledgeItems(ids: readonly string[]): number {
  const unique = [...new Set(ids.map(stripItemRef).filter(Boolean))];
  if (unique.length === 0) return 0;
  const now = Date.now();
  return executeWrite(
    getKnowledgeDb(),
    (db) => {
      let changed = 0;
      for (let offset = 0; offset < unique.length; offset += 500) {
        const chunk = unique.slice(offset, offset + 500);
        const placeholders = chunk.map(() => "?").join(", ");
        changed += db
          .prepare(
            `UPDATE knowledge_items SET body = ?, key = ?, status = 'redacted', expires_at = NULL, updated_at = ?
             WHERE id IN (${placeholders}) AND status != 'redacted'`,
          )
          .run(REDACTED_BODY, REDACTED_BODY, now, ...chunk).changes;
        db.prepare(`UPDATE knowledge_item_sources SET span = NULL WHERE item_id IN (${placeholders})`).run(...chunk);
      }
      return changed;
    },
    { label: "knowledge_items_redact" },
  );
}

/**
 * Makes a draft active (the operator confirmed it): it supersedes the active
 * item with the same key whatever that item's tier, because the operator
 * decided. An already active item is returned unchanged.
 */
export function activateKnowledgeDraft(id: string, now: number = Date.now()): KnowledgeItem | null {
  const itemId = stripItemRef(id);
  return executeWrite(
    getKnowledgeDb(),
    (db) => {
      const item = readItem(db, itemId);
      if (!item || item.status !== "draft") return item;
      const current = findActiveSameKey(db, item);
      if (current && current.id !== item.id) archiveSuperseded(db, current.id, item.id, now);
      db.prepare("UPDATE knowledge_items SET status = 'active', expires_at = NULL, updated_at = ? WHERE id = ?").run(
        now,
        item.id,
      );
      return readItem(db, item.id);
    },
    { label: "knowledge_item_activate" },
  );
}

/** Items created since `since` (epoch ms) and their distinct subjects, for the morning DM. */
export function countItemsCreatedSince(since: number): { items: number; subjects: number } {
  const row = getKnowledgeDb()
    .prepare(
      `SELECT COUNT(*) AS items, COUNT(DISTINCT scope || ':' || subject_id) AS subjects
       FROM knowledge_items WHERE created_at >= ? AND status IN ('active','draft')`,
    )
    .get(since) as { items: number; subjects: number } | null;
  return { items: row?.items ?? 0, subjects: row?.subjects ?? 0 };
}

/** Item ids of these subjects (any status), for forget. */
export function listItemIdsForSubjects(scope: "contact" | "chat", subjectIds: readonly string[]): string[] {
  const ids = [...new Set(subjectIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const found: string[] = [];
  const db = getKnowledgeDb();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const rows = db
      .prepare(`SELECT id FROM knowledge_items WHERE scope = ? AND subject_id IN (${chunk.map(() => "?").join(", ")})`)
      .all(scope, ...chunk) as Array<{ id: string }>;
    for (const row of rows) found.push(row.id);
  }
  return found;
}

export function stripItemRef(id: string): string {
  const trimmed = (id ?? "").trim();
  return trimmed.startsWith("ki:") ? trimmed.slice(3) : trimmed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether `a` is a strictly higher tier than `b`. */
function outranks(a: KnowledgeTrustTier, b: KnowledgeTrustTier): boolean {
  return TRUST_ORDER.indexOf(a) < TRUST_ORDER.indexOf(b);
}

function findActiveSameKey(
  db: Database,
  item: Pick<KnowledgeItem, "scope" | "subjectId" | "agentId" | "kind" | "key">,
): KnowledgeItem | null {
  const row = db
    .prepare(
      `SELECT * FROM knowledge_items
       WHERE scope = ? AND subject_id = ? AND ifnull(agent_id, '') = ? AND kind = ? AND key = ? AND status = 'active'`,
    )
    .get(item.scope, item.subjectId, item.agentId ?? "", item.kind, item.key) as ItemRow | null;
  return row ? toItem(row) : null;
}

function archiveSuperseded(db: Database, oldId: string, newId: string, now: number): void {
  db.prepare("UPDATE knowledge_items SET status = 'archived', superseded_by = ?, updated_at = ? WHERE id = ?").run(
    newId,
    now,
    oldId,
  );
}

function readItem(db: Database, id: string): KnowledgeItem | null {
  if (!id) return null;
  const row = db.prepare("SELECT * FROM knowledge_items WHERE id = ?").get(id) as ItemRow | null;
  return row ? toItem(row) : null;
}

function toItem(row: ItemRow): KnowledgeItem {
  return {
    id: row.id,
    scope: row.scope,
    subjectId: row.subject_id,
    agentId: row.agent_id ?? null,
    kind: row.kind,
    key: row.key,
    body: row.body,
    status: row.status,
    trust: row.trust,
    speaker: row.speaker ?? null,
    recordedAt: row.recorded_at,
    expiresAt: row.expires_at ?? null,
    supersededBy: row.superseded_by ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
