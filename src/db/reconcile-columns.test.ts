import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseSchemaColumns, reconcileColumns } from "./reconcile-columns.js";

let dir: string | null = null;

function openTempDb(): Database {
  const path = join(dir as string, `${randomUUID()}.db`);
  return new Database(path);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravi-reconcile-"));
});

afterEach(() => {
  if (dir !== null) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("parseSchemaColumns", () => {
  it("parses a single CREATE TABLE with simple columns", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        priority INTEGER DEFAULT 0
      );
    `;
    const result = parseSchemaColumns(sql);
    expect(result.size).toBe(1);
    const items = result.get("items");
    expect(items).toBeDefined();
    expect(items!.map((c) => c.name)).toEqual(["id", "name", "priority"]);
    expect(items![0]!.definition).toBe("TEXT PRIMARY KEY");
    expect(items![1]!.definition).toBe("TEXT NOT NULL");
    expect(items![2]!.definition).toBe("INTEGER DEFAULT 0");
  });

  it("skips table-level constraints", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        UNIQUE(user_id, room_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        CHECK (length(id) > 0)
      );
    `;
    const cols = parseSchemaColumns(sql).get("bookings");
    expect(cols!.map((c) => c.name)).toEqual(["id", "user_id", "room_id"]);
  });

  it("parses multiple tables and ignores CREATE INDEX between them", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS a (
        id TEXT PRIMARY KEY,
        x INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_a_x ON a(x);

      CREATE TABLE IF NOT EXISTS b (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref TEXT REFERENCES a(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_b_ref ON b(ref);
    `;
    const result = parseSchemaColumns(sql);
    expect([...result.keys()].sort()).toEqual(["a", "b"]);
    expect(result.get("a")!.map((c) => c.name)).toEqual(["id", "x"]);
    expect(result.get("b")!.map((c) => c.name)).toEqual(["id", "ref"]);
  });

  it("handles CHECK constraints inline on a column without confusing the parser", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        status TEXT CHECK(status IN ('active','archived')) NOT NULL
      );
    `;
    const cols = parseSchemaColumns(sql).get("records");
    expect(cols!.map((c) => c.name)).toEqual(["id", "status"]);
    expect(cols![1]!.definition).toContain("CHECK");
  });

  it("strips line and block comments", () => {
    const sql = `
      -- top comment
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, -- the id
        body TEXT /* the body */
      );
    `;
    const cols = parseSchemaColumns(sql).get("notes");
    expect(cols!.map((c) => c.name)).toEqual(["id", "body"]);
  });

  it("handles quoted identifiers", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS \`weird\` (
        "primary" TEXT NOT NULL,
        \`order\` INTEGER
      );
    `;
    const cols = parseSchemaColumns(sql).get("weird");
    expect(cols!.map((c) => c.name)).toEqual(["primary", "order"]);
  });
});

describe("reconcileColumns", () => {
  it("adds a column that is declared but missing from the live table", () => {
    const db = openTempDb();
    db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT)");
    const schema = `
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        name TEXT,
        priority INTEGER DEFAULT 0,
        notes TEXT
      );
    `;
    const result = reconcileColumns(db, schema, { label: "test" });
    expect(result.alterCount).toBe(2);
    expect(result.added.items).toEqual(["priority", "notes"]);

    const live = db.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>;
    const names = live.map((r) => r.name).sort();
    expect(names).toEqual(["id", "name", "notes", "priority"]);
    db.close();
  });

  it("is idempotent when all columns are already present", () => {
    const db = openTempDb();
    db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, priority INTEGER)");
    const schema = `
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        name TEXT,
        priority INTEGER
      );
    `;
    const first = reconcileColumns(db, schema, { label: "test" });
    expect(first.alterCount).toBe(0);
    const second = reconcileColumns(db, schema, { label: "test" });
    expect(second.alterCount).toBe(0);
    db.close();
  });

  it("reports tables that are declared in schema but missing in the DB", () => {
    const db = openTempDb();
    db.exec("CREATE TABLE existing (id TEXT PRIMARY KEY)");
    const schema = `
      CREATE TABLE IF NOT EXISTS existing (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS not_yet_created (id TEXT PRIMARY KEY, value TEXT);
    `;
    const result = reconcileColumns(db, schema, { label: "test" });
    expect(result.missingTables).toEqual(["not_yet_created"]);
    expect(result.alterCount).toBe(0);
    db.close();
  });

  it("handles multiple tables in one reconcile pass", () => {
    const db = openTempDb();
    db.exec("CREATE TABLE a (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE b (id TEXT PRIMARY KEY)");
    const schema = `
      CREATE TABLE IF NOT EXISTS a (
        id TEXT PRIMARY KEY,
        new_col_a TEXT
      );
      CREATE TABLE IF NOT EXISTS b (
        id TEXT PRIMARY KEY,
        new_col_b INTEGER DEFAULT 0
      );
    `;
    const result = reconcileColumns(db, schema, { label: "test" });
    expect(result.alterCount).toBe(2);
    expect(result.added.a).toEqual(["new_col_a"]);
    expect(result.added.b).toEqual(["new_col_b"]);
    db.close();
  });

  it("rethrows when ALTER TABLE fails (e.g. NOT NULL without default)", () => {
    const db = openTempDb();
    db.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO items (id) VALUES ('a')");
    const schema = `
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        required_col TEXT NOT NULL
      );
    `;
    expect(() => reconcileColumns(db, schema, { label: "test" })).toThrow();
    db.close();
  });
});
