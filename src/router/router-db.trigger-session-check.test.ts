import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateTriggerDebounce, migrateTriggerOwner, migrateTriggerSessionCheck } from "./router-db.js";

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

describe("migrateTriggerDebounce", () => {
  it("adds debounce_ms defaulting to 0 to an existing triggers table, idempotently", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE triggers (id TEXT PRIMARY KEY, cooldown_ms INTEGER DEFAULT 5000)");
    db.exec("INSERT INTO triggers (id) VALUES ('old')");

    migrateTriggerDebounce(db);
    migrateTriggerDebounce(db); // idempotent

    db.exec("INSERT INTO triggers (id, debounce_ms) VALUES ('new', 2000)");
    expect(db.prepare("SELECT id, cooldown_ms, debounce_ms FROM triggers ORDER BY id").all()).toEqual([
      { id: "new", cooldown_ms: 5000, debounce_ms: 2000 },
      { id: "old", cooldown_ms: 5000, debounce_ms: 0 },
    ]);
    db.close();
  });
});

describe("migrateTriggerOwner", () => {
  it("adds owner_principal with no owner for the triggers that already exist, idempotently", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE triggers (id TEXT PRIMARY KEY, message TEXT NOT NULL)");
    db.exec("INSERT INTO triggers (id, message) VALUES ('old', 'written before owners')");

    migrateTriggerOwner(db);
    migrateTriggerOwner(db); // idempotent

    db.exec("INSERT INTO triggers (id, message, owner_principal) VALUES ('new', 'm', 'operator')");
    // No backfill: an older trigger gains no owner, least of all the operator.
    expect(db.prepare("SELECT id, owner_principal FROM triggers ORDER BY id").all()).toEqual([
      { id: "new", owner_principal: "operator" },
      { id: "old", owner_principal: null },
    ]);
    db.close();
  });

  it("keeps the owner through the session CHECK rebuild, whichever runs first", () => {
    const legacy = () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE triggers (
          id TEXT PRIMARY KEY,
          message TEXT NOT NULL,
          session TEXT DEFAULT 'isolated' CHECK(session IN ('main','isolated'))
        );
      `);
      db.exec("INSERT INTO triggers (id, message, session) VALUES ('t1', 'm', 'main')");
      return db;
    };

    // The order the schema init uses: rebuild, then add the column.
    const rebuiltFirst = legacy();
    migrateTriggerSessionCheck(rebuiltFirst);
    migrateTriggerOwner(rebuiltFirst);
    rebuiltFirst.exec("UPDATE triggers SET owner_principal = 'operator' WHERE id = 't1'");
    migrateTriggerSessionCheck(rebuiltFirst);
    expect(rebuiltFirst.prepare("SELECT id, owner_principal FROM triggers").all()).toEqual([
      { id: "t1", owner_principal: "operator" },
    ]);
    rebuiltFirst.close();

    // A database another process already gave the column: the rebuild copies it with the rows.
    const columnFirst = legacy();
    migrateTriggerOwner(columnFirst);
    columnFirst.exec("UPDATE triggers SET owner_principal = 'contact:c_ana' WHERE id = 't1'");
    migrateTriggerSessionCheck(columnFirst);
    columnFirst.exec("INSERT INTO triggers (id, message, session) VALUES ('t2', 'm', 'issue-{{data.id}}')");
    expect(columnFirst.prepare("SELECT id, owner_principal FROM triggers ORDER BY id").all()).toEqual([
      { id: "t1", owner_principal: "contact:c_ana" },
      { id: "t2", owner_principal: null },
    ]);
    columnFirst.close();
  });
});
