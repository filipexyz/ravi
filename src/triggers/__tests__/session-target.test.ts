import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateTriggerSessionCheck } from "../../router/router-db.js";
import { resolveSessionTargetName } from "../runner.js";
import { sessionTargetError } from "../types.js";

describe("trigger session targets", () => {
  it("accepts any non-empty session name or template", () => {
    expect(sessionTargetError("support-desk")).toBeNull();
    expect(sessionTargetError("issue-{{data.payload.rowId}}")).toBeNull();
    expect(sessionTargetError("  ")).toContain("give a session name");
  });

  it("resolves a session name from event data", () => {
    const event = { topic: "t", data: { payload: { row: { values: { topic_id: ["Topic_A.1"] } } } } };
    expect(resolveSessionTargetName("issue-{{data.payload.row.values.topic_id.0}}", event)).toBe("issue-topic-a-1");
    expect(resolveSessionTargetName("issue-{{data.payload.missing}}", event)).toBeNull();
    expect(resolveSessionTargetName("issue-{{data.payload.missing}}", event, { fillUnresolved: "test" })).toBe(
      "issue-test",
    );
    expect(
      resolveSessionTargetName("{{data.payload.empty}}", { topic: "t", data: { payload: { empty: "" } } }),
    ).toBeNull();
  });

  it("caps the session name at 64 characters", () => {
    const longId = "x".repeat(400);
    const event = { topic: "t", data: { id: longId } };
    expect(resolveSessionTargetName("i-{{data.id}}", event)).toBe(`i-${"x".repeat(62)}`);
  });

  it("drops the legacy main|isolated CHECK and keeps existing rows", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE triggers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        topic TEXT NOT NULL,
        message TEXT NOT NULL,
        session TEXT DEFAULT 'isolated' CHECK(session IN ('main','isolated')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_triggers_topic ON triggers(topic);
    `);
    db.exec("ALTER TABLE triggers ADD COLUMN filter TEXT");
    db.exec("INSERT INTO triggers VALUES ('t1', 'old', 'a.b', 'msg', 'main', 1, 2, 'f')");
    expect(() =>
      db.exec("INSERT INTO triggers VALUES ('t2', 'new', 'a.b', 'msg', 'issue-{{data.id}}', 1, 2, NULL)"),
    ).toThrow();

    migrateTriggerSessionCheck(db);
    migrateTriggerSessionCheck(db); // idempotent

    db.exec("INSERT INTO triggers VALUES ('t2', 'new', 'a.b', 'msg', 'issue-{{data.id}}', 1, 2, NULL)");
    expect(db.prepare("SELECT id, session, filter FROM triggers ORDER BY id").all()).toEqual([
      { id: "t1", session: "main", filter: "f" },
      { id: "t2", session: "issue-{{data.id}}", filter: null },
    ]);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'triggers'").all();
    expect(indexes).toContainEqual({ name: "idx_triggers_topic" });
    db.close();
  });
});
