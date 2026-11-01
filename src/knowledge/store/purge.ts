// Daily local retention (contract §14, daemon rows). Runs in the index
// runner on the leader; returns how many rows each rule touched.

import type { Database } from "bun:sqlite";
import { executeWrite } from "../../db/write-retry.js";
import { getKnowledgeDb, knowledgeFts5Available } from "./db.js";

const DAY_MS = 24 * 60 * 60_000;
const SUBJECT_IDLE_MS = 180 * DAY_MS;
const ARCHIVED_ITEM_GRACE_MS = 30 * DAY_MS;
const THIRTY_DAYS_MS = 30 * DAY_MS;

export function purgeKnowledgeLocal(now: number = Date.now()): Record<string, number> {
  const db = getKnowledgeDb();
  const fts = knowledgeFts5Available();
  return executeWrite(
    db,
    (tx) => {
      const result: Record<string, number> = {};
      result.itemsArchivedIdle = archiveIdleSubjectItems(tx, now);
      result.itemsDraftsExpired = tx
        .prepare(
          "UPDATE knowledge_items SET status = 'archived', updated_at = ? WHERE status = 'draft' AND expires_at IS NOT NULL AND expires_at < ?",
        )
        .run(now, now).changes;
      result.itemsDeleted = deleteOldArchivedItems(tx, now);
      result.markedPagesDeleted = deleteExpiredMarkedPages(tx, fts, now);
      result.briefsDeleted = tx
        .prepare("DELETE FROM knowledge_briefs WHERE created_at < ?")
        .run(now - THIRTY_DAYS_MS).changes;
      result.localRunsDeleted = tx
        .prepare("DELETE FROM knowledge_local_runs WHERE created_at < ?")
        .run(now - THIRTY_DAYS_MS).changes;
      result.turnReadsDeleted = tx
        .prepare("DELETE FROM knowledge_turn_reads WHERE last_read_at < ?")
        .run(now - DAY_MS).changes;
      result.writeApprovalsDeleted = tx
        .prepare("DELETE FROM knowledge_write_approvals WHERE requested_at < ?")
        .run(now - DAY_MS).changes;
      result.gapsDeleted = tx
        .prepare("DELETE FROM knowledge_gaps WHERE status IN ('notified','dropped') AND created_at < ?")
        .run(now - THIRTY_DAYS_MS).changes;
      result.gapsDropped = tx
        .prepare("UPDATE knowledge_gaps SET status = 'dropped' WHERE status = 'pending' AND created_at < ?")
        .run(now - THIRTY_DAYS_MS).changes;
      result.guardedSessionsDeleted = tx
        .prepare("DELETE FROM knowledge_guarded_sessions WHERE guarded_until < ?")
        .run(now).changes;
      return result;
    },
    { label: "knowledge_purge" },
  );
}

/**
 * The newest local DM activity of a subject: its newest indexed chat row
 * (by contact for contact subjects, by chat id for chat subjects).
 */
const SUBJECT_ACTIVITY_SQL = `
  CASE i.scope
    WHEN 'contact' THEN (SELECT MAX(d.recorded_at) FROM knowledge_local_docs d WHERE d.kind = 'chat' AND d.contact_id = i.subject_id)
    ELSE (SELECT MAX(d.recorded_at) FROM knowledge_local_docs d WHERE d.kind = 'chat' AND d.chat_id = i.subject_id)
  END`;

/** Items of subjects whose newest DM message is older than 180 days are archived. */
function archiveIdleSubjectItems(db: Database, now: number): number {
  return db
    .prepare(
      `UPDATE knowledge_items SET status = 'archived', updated_at = ?
       WHERE id IN (
         SELECT i.id FROM knowledge_items i
         WHERE i.status IN ('active','draft')
           AND COALESCE(${SUBJECT_ACTIVITY_SQL}, i.recorded_at) < ?
       )`,
    )
    .run(now, now - SUBJECT_IDLE_MS).changes;
}

/** Archived items of idle subjects are deleted 30 days after archiving; redacted tombstones stay. */
function deleteOldArchivedItems(db: Database, now: number): number {
  const ids = (
    db
      .prepare(
        `SELECT i.id FROM knowledge_items i
         WHERE i.status = 'archived' AND i.updated_at < ?
           AND COALESCE(${SUBJECT_ACTIVITY_SQL}, i.recorded_at) < ?`,
      )
      .all(now - ARCHIVED_ITEM_GRACE_MS, now - SUBJECT_IDLE_MS) as Array<{ id: string }>
  ).map((row) => row.id);
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    db.prepare(`DELETE FROM knowledge_item_sources WHERE item_id IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM knowledge_items WHERE id IN (${placeholders})`).run(...chunk);
  }
  return ids.length;
}

function deleteExpiredMarkedPages(db: Database, fts: boolean, now: number): number {
  const routes = (
    db.prepare("SELECT route_id FROM knowledge_marked_pages WHERE expires_at < ?").all(now) as Array<{
      route_id: string;
    }>
  ).map((row) => row.route_id);
  for (let offset = 0; offset < routes.length; offset += 500) {
    const chunk = routes.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    if (fts) {
      db.prepare(
        `DELETE FROM knowledge_marked_fts WHERE rowid IN (SELECT id FROM knowledge_marked_sections WHERE route_id IN (${placeholders}))`,
      ).run(...chunk);
    }
    db.prepare(`DELETE FROM knowledge_marked_sections WHERE route_id IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM knowledge_marked_pages WHERE route_id IN (${placeholders})`).run(...chunk);
  }
  return routes.length;
}
