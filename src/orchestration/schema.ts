import type { Database } from "bun:sqlite";

// Initial schema only; no runtime/bootstrap registration or legacy schema conversion.
export function migrateAttentionOccurrences(db: Database): void {
  db.transaction(() => {
    db.exec(`
CREATE TABLE IF NOT EXISTS chat_attention_occurrences (
  occurrence_key TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('requirement','task_result','thread_decision')),
  chat_id TEXT NOT NULL CHECK(length(chat_id)>0),
  commitment_key TEXT,
  task_id TEXT,
  requirement_kind TEXT,
  subject_id TEXT,
  outcome_kind TEXT,
  outcome_version INTEGER,
  thread_id TEXT,
  decision_ref TEXT,
  fact_state TEXT NOT NULL DEFAULT 'unknown' CHECK(fact_state IN ('unknown','unsatisfied','satisfied')),
  fact_revision INTEGER NOT NULL DEFAULT 0 CHECK(fact_revision >= 0),
  resolution_proof_ref TEXT,
  row_version INTEGER NOT NULL DEFAULT 0 CHECK(row_version >= 0),
  CHECK (
    (kind='requirement'
      AND commitment_key IS NOT NULL AND length(commitment_key)>0
      AND task_id IS NOT NULL AND length(task_id)>0
      AND requirement_kind IS NOT NULL AND requirement_kind IN ('dependency_complete','decision_answered')
      AND subject_id IS NOT NULL AND length(subject_id)>0
      AND outcome_kind IS NULL AND outcome_version IS NULL
      AND thread_id IS NULL AND decision_ref IS NULL)
    OR
    (kind='task_result'
      AND task_id IS NOT NULL AND length(task_id)>0
      AND outcome_kind IS NOT NULL AND outcome_kind IN ('completed','failed')
      AND outcome_version IS NOT NULL AND typeof(outcome_version)='integer'
      AND outcome_version BETWEEN 1 AND 9007199254740991
      AND requirement_kind IS NULL AND subject_id IS NULL
      AND commitment_key IS NULL AND thread_id IS NULL AND decision_ref IS NULL)
    OR
    (kind='thread_decision'
      AND thread_id IS NOT NULL AND length(thread_id)>0
      AND decision_ref IS NOT NULL AND length(decision_ref)>0
      AND task_id IS NULL AND requirement_kind IS NULL AND subject_id IS NULL
      AND commitment_key IS NULL AND outcome_kind IS NULL AND outcome_version IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attention_requirement
  ON chat_attention_occurrences(kind,chat_id,commitment_key,task_id,requirement_kind,subject_id)
  WHERE kind='requirement';
CREATE UNIQUE INDEX IF NOT EXISTS uq_attention_task_result
  ON chat_attention_occurrences(kind,chat_id,task_id,outcome_kind,outcome_version)
  WHERE kind='task_result';
CREATE UNIQUE INDEX IF NOT EXISTS uq_attention_thread_decision
  ON chat_attention_occurrences(kind,chat_id,thread_id,decision_ref)
  WHERE kind='thread_decision';
`);
  }).immediate();
}
