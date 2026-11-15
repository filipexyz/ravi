import type { Database } from "bun:sqlite";
import {
  makeOccurrenceKey,
  parseOccurrenceIdentity,
  type OccurrenceIdentityV1,
  type OccurrenceKey,
} from "./identity.js";

/** Return the existing canonical key without resetting factual state on replay. */
export function getOrCreateOccurrence(db: Database, input: OccurrenceIdentityV1): OccurrenceKey {
  const identity = parseOccurrenceIdentity(input);
  const key = makeOccurrenceKey(identity);
  return db
    .transaction(() => {
      const row =
        identity.kind === "requirement"
          ? db
              .query<{ occurrence_key: string }, [string, string, string, string, string, string]>(`
          INSERT INTO chat_attention_occurrences
            (occurrence_key,kind,chat_id,commitment_key,task_id,requirement_kind,subject_id)
          VALUES (?,'requirement',?,?,?,?,?)
          ON CONFLICT(kind,chat_id,commitment_key,task_id,requirement_kind,subject_id) WHERE kind='requirement'
          DO UPDATE SET occurrence_key=chat_attention_occurrences.occurrence_key
          RETURNING occurrence_key
        `)
              .get(
                key,
                identity.chatId,
                identity.commitmentKey,
                identity.taskId,
                identity.requirementKind,
                identity.subjectId,
              )
          : db
              .query<{ occurrence_key: string }, [string, string, string, string, number]>(`
          INSERT INTO chat_attention_occurrences
            (occurrence_key,kind,chat_id,task_id,outcome_kind,outcome_version)
          VALUES (?,'task_result',?,?,?,?)
          ON CONFLICT(kind,chat_id,task_id,outcome_kind,outcome_version) WHERE kind='task_result'
          DO UPDATE SET occurrence_key=chat_attention_occurrences.occurrence_key
          RETURNING occurrence_key
        `)
              .get(key, identity.chatId, identity.taskId, identity.outcomeKind, identity.outcomeVersion);
      if (row?.occurrence_key !== key) throw new Error("Occurrence identity integrity mismatch");
      return key;
    })
    .immediate();
}
