import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateTriggerSessionCheck } from "./router-db.js";

describe("migrateTriggerSessionCheck", () => {
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

  it("leaves a table without the legacy CHECK untouched", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE triggers (id TEXT PRIMARY KEY, session TEXT DEFAULT 'isolated')");
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'triggers'").get();
    migrateTriggerSessionCheck(db);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'triggers'").get()).toEqual(before);
    db.close();
  });
});
