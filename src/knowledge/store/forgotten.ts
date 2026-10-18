// Forgotten subjects (contract §13.2): a contact or chat that asked to be
// forgotten. The indexer, the curator and the packet never learn it again.

import { executeWrite } from "../../db/write-retry.js";
import { getKnowledgeDb } from "./db.js";

export type ForgottenScope = "contact" | "chat";

export function markSubjectForgotten(input: { scope: ForgottenScope; subjectId: string; now?: number }): void {
  const subjectId = input.subjectId.trim();
  if (!subjectId) return;
  executeWrite(
    getKnowledgeDb(),
    (db) => {
      db.prepare(
        `INSERT INTO knowledge_forgotten_subjects (subject_id, scope, forgotten_at) VALUES (?, ?, ?)
         ON CONFLICT(subject_id) DO UPDATE SET scope = excluded.scope, forgotten_at = excluded.forgotten_at`,
      ).run(subjectId, input.scope, input.now ?? Date.now());
    },
    { label: "knowledge_forget_subject" },
  );
}

export function isSubjectForgotten(subjectId: string | null | undefined): boolean {
  const id = subjectId?.trim();
  if (!id) return false;
  const row = getKnowledgeDb()
    .prepare("SELECT 1 AS found FROM knowledge_forgotten_subjects WHERE subject_id = ?")
    .get(id);
  return Boolean(row);
}

/** Every forgotten subject id (contact and chat ids). */
export function listForgottenSubjectIds(): Set<string> {
  const rows = getKnowledgeDb().prepare("SELECT subject_id FROM knowledge_forgotten_subjects").all() as Array<{
    subject_id: string;
  }>;
  return new Set(rows.map((row) => row.subject_id));
}
