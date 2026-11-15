import type { Database, SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDatabase } from "../db/state-boundary.js";
import {
  makeOccurrenceKey,
  type OccurrenceIdentityV1,
  type RequirementOccurrence,
  type TaskResultOccurrence,
} from "./identity.js";
import { getOrCreateOccurrence } from "./occurrence-store.js";
import { migrateAttentionOccurrences } from "./schema.js";

const databases = new Set<Database>();
const directories = new Set<string>();
function open(path = ":memory:"): Database {
  const db = openStateDatabase(path, { create: true });
  databases.add(db);
  return db;
}
function close(db: Database): void {
  db.close();
  databases.delete(db);
}
function freshDb(): Database {
  const db = open();
  migrateAttentionOccurrences(db);
  return db;
}
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

const result: TaskResultOccurrence = {
  schemaVersion: 1,
  kind: "task_result",
  chatId: "chat:storage-test",
  taskId: "task:independent",
  outcomeKind: "completed",
  outcomeVersion: 1,
};
const requirement: RequirementOccurrence = {
  schemaVersion: 1,
  kind: "requirement",
  chatId: result.chatId,
  taskId: result.taskId,
  commitmentKey: "agreement:delivery",
  requirementKind: "dependency_complete",
  subjectId: "task:upstream",
};
const count = (db: Database) =>
  db.query<{ count: number }, []>("SELECT count(*) AS count FROM chat_attention_occurrences").get()!.count;
function rawInsert(db: Database, patch: Record<string, SQLQueryBindings>): void {
  const row: Record<string, SQLQueryBindings> = {
    occurrence_key: "raw-key",
    kind: "task_result",
    chat_id: result.chatId,
    task_id: result.taskId,
    commitment_key: null,
    requirement_kind: null,
    subject_id: null,
    outcome_kind: "completed",
    outcome_version: 1,
    ...patch,
  };
  const fields = Object.keys(row);
  db.query(
    `INSERT INTO chat_attention_occurrences (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
  ).run(...Object.values(row));
}

describe("occurrence storage", () => {
  test("task_result_without_requirement_is_persisted_idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "ravi-attention-storage-"));
    directories.add(directory);
    const path = join(directory, "occurrences.sqlite");
    const first = open(path);
    migrateAttentionOccurrences(first);
    const key = getOrCreateOccurrence(first, result);
    expect(getOrCreateOccurrence(first, result)).toBe(key);
    expect(
      first.query("SELECT commitment_key,requirement_kind,subject_id FROM chat_attention_occurrences").get(),
    ).toEqual({
      commitment_key: null,
      requirement_kind: null,
      subject_id: null,
    });
    expect(count(first)).toBe(1);
    close(first);
    const reopened = open(path);
    migrateAttentionOccurrences(reopened);
    expect(getOrCreateOccurrence(reopened, result)).toBe(key);
    expect(count(reopened)).toBe(1);
    expect(getOrCreateOccurrence(reopened, { ...result, outcomeVersion: 2 })).not.toBe(key);
    expect(getOrCreateOccurrence(reopened, { ...result, outcomeKind: "failed" })).not.toBe(key);
    expect(count(reopened)).toBe(3);
    expect(reopened.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
      { name: "chat_attention_occurrences" },
    ]);
  });

  test("requirement_tuple_is_disjoint_from_task_result", () => {
    const db = freshDb();
    const blockerKey = getOrCreateOccurrence(db, requirement);
    expect(getOrCreateOccurrence(db, { ...requirement })).toBe(blockerKey);
    expect(getOrCreateOccurrence(db, result)).not.toBe(blockerKey);
    expect(getOrCreateOccurrence(db, { ...requirement, subjectId: "task:another-upstream" })).not.toBe(blockerKey);
    expect(getOrCreateOccurrence(db, { ...requirement, requirementKind: "decision_answered" })).not.toBe(blockerKey);
    expect(count(db)).toBe(4);
  });

  test("migration_and_replay_preserve_facts_and_partial_indexes", () => {
    const db = freshDb();
    const key = getOrCreateOccurrence(db, requirement);
    db.query(
      "UPDATE chat_attention_occurrences SET fact_state='satisfied',fact_revision=7,resolution_proof_ref='event:7',row_version=9 WHERE occurrence_key=?",
    ).run(key);
    for (let i = 0; i < 3; i++) migrateAttentionOccurrences(db);
    expect(getOrCreateOccurrence(db, requirement)).toBe(key);
    expect(
      db
        .query("SELECT fact_state,fact_revision,resolution_proof_ref,row_version FROM chat_attention_occurrences")
        .get(),
    ).toEqual({
      fact_state: "satisfied",
      fact_revision: 7,
      resolution_proof_ref: "event:7",
      row_version: 9,
    });
    const indexes = db
      .query<{ name: string; unique: number; partial: number }, []>(
        "SELECT name,\"unique\",partial FROM pragma_index_list('chat_attention_occurrences') WHERE origin='c' ORDER BY name",
      )
      .all();
    expect(indexes).toEqual([
      { name: "uq_attention_requirement", unique: 1, partial: 1 },
      { name: "uq_attention_task_result", unique: 1, partial: 1 },
    ]);
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(chat_attention_occurrences)")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("thread_id");
    expect(columns).not.toContain("decision_ref");
  });

  test("partial_unique_indexes_reject_another_key_for_the_same_tuple", () => {
    const db = freshDb();
    getOrCreateOccurrence(db, result);
    getOrCreateOccurrence(db, requirement);
    expect(() => rawInsert(db, { occurrence_key: "second-result-key" })).toThrow("UNIQUE constraint failed");
    expect(() =>
      rawInsert(db, {
        occurrence_key: "second-requirement-key",
        kind: "requirement",
        commitment_key: requirement.commitmentKey,
        requirement_kind: requirement.requirementKind,
        subject_id: requirement.subjectId,
        outcome_kind: null,
        outcome_version: null,
      }),
    ).toThrow("UNIQUE constraint failed");
    expect(count(db)).toBe(2);
  });

  test("sqlite_check_rejects_mixed_missing_and_deferred_variants", () => {
    const db = freshDb();
    const invalidRows: Record<string, SQLQueryBindings>[] = [
      { kind: "thread_decision" },
      { kind: "unknown" },
      { task_id: null },
      { task_id: "" },
      { chat_id: "" },
      { requirement_kind: "none" },
      { requirement_kind: "dependency_complete", subject_id: "upstream" },
      { commitment_key: "agreement" },
      { outcome_kind: null },
      { outcome_kind: "done" },
      { outcome_version: null },
      { outcome_version: 0 },
      { outcome_version: -1 },
      { outcome_version: 1.5 },
      { outcome_version: Number.MAX_SAFE_INTEGER + 1 },
      { outcome_version: "not-an-integer" },
      { kind: "requirement", outcome_kind: null, outcome_version: null },
      {
        kind: "requirement",
        commitment_key: "agreement",
        requirement_kind: "none",
        subject_id: "upstream",
        outcome_kind: null,
        outcome_version: null,
      },
      {
        kind: "requirement",
        commitment_key: "agreement",
        requirement_kind: "dependency_complete",
        subject_id: "upstream",
      },
    ];
    for (const patch of invalidRows) {
      expect(() => rawInsert(db, patch)).toThrow();
      expect(count(db)).toBe(0);
    }
    rawInsert(db, { outcome_version: Number.MAX_SAFE_INTEGER });
    expect(count(db)).toBe(1);
  });

  test("store_refuses_divergent_canonical_keys_without_mutating_state", () => {
    const db = freshDb();
    rawInsert(db, { occurrence_key: "noncanonical-key" });
    const before = db.query("SELECT * FROM chat_attention_occurrences").all();
    expect(() => getOrCreateOccurrence(db, result)).toThrow("Occurrence identity integrity mismatch");
    expect(db.query("SELECT * FROM chat_attention_occurrences").all()).toEqual(before);
    expect(db.inTransaction).toBe(false);
    expect(getOrCreateOccurrence(db, requirement)).toBe(makeOccurrenceKey(requirement));
  });

  test("primary_key_collision_with_another_tuple_is_an_error", () => {
    const db = freshDb();
    rawInsert(db, { occurrence_key: makeOccurrenceKey(result), task_id: "another-task" });
    expect(() => getOrCreateOccurrence(db, result)).toThrow("UNIQUE constraint failed");
    expect(count(db)).toBe(1);
  });

  test("store_validates_before_persisting_or_starting_a_transaction", () => {
    const db = freshDb();
    const bad = {
      schemaVersion: 1,
      kind: "thread_decision",
      chatId: result.chatId,
      threadId: "thread",
      decisionRef: "decision",
    };
    expect(() => getOrCreateOccurrence(db, bad as unknown as OccurrenceIdentityV1)).toThrow(TypeError);
    expect(count(db)).toBe(0);
    expect(db.inTransaction).toBe(false);
  });
});
