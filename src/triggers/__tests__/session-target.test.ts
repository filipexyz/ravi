import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateTriggerSessionCheck } from "../../router/router-db.js";
import { resolveKeyedSessionKey } from "../runner.js";
import { sessionTargetError } from "../types.js";

describe("trigger session targets", () => {
  it("accepts main, isolated and key:<template>, rejects anything else", () => {
    expect(sessionTargetError("main")).toBeNull();
    expect(sessionTargetError("isolated")).toBeNull();
    expect(sessionTargetError("key:issue-{{data.payload.rowId}}")).toBeNull();
    expect(sessionTargetError("shared")).toContain("Valid: main, isolated, key:<template>");
    expect(sessionTargetError("key:  ")).toContain("needs a template");
  });

  it("resolves a key from event data without truncating long values", () => {
    const longId = "x".repeat(400);
    const event = { topic: "t", data: { payload: { row: { values: { topic_id: [longId] } } } } };
    expect(resolveKeyedSessionKey("key:issue-{{data.payload.row.values.topic_id.0}}", event)).toBe(`issue-${longId}`);
    expect(resolveKeyedSessionKey("key:issue-{{data.payload.missing}}", event)).toBeNull();
    expect(
      resolveKeyedSessionKey("key:{{data.payload.empty}}", { topic: "t", data: { payload: { empty: "" } } }),
    ).toBeNull();
  });

  it("migrates the legacy main|isolated CHECK and keeps existing rows", () => {
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
      db.exec("INSERT INTO triggers VALUES ('t2', 'new', 'a.b', 'msg', 'key:issue-{{data.id}}', 1, 2, NULL)"),
    ).toThrow();

    migrateTriggerSessionCheck(db);
    migrateTriggerSessionCheck(db); // idempotent

    db.exec("INSERT INTO triggers VALUES ('t2', 'new', 'a.b', 'msg', 'key:issue-{{data.id}}', 1, 2, NULL)");
    expect(() => db.exec("INSERT INTO triggers VALUES ('t3', 'bad', 'a.b', 'msg', 'shared', 1, 2, NULL)")).toThrow();
    expect(db.prepare("SELECT id, session, filter FROM triggers ORDER BY id").all()).toEqual([
      { id: "t1", session: "main", filter: "f" },
      { id: "t2", session: "key:issue-{{data.id}}", filter: null },
    ]);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'triggers'").all();
    expect(indexes).toContainEqual({ name: "idx_triggers_topic" });
    db.close();
  });
});
