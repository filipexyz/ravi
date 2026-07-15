import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getDb } from "./router-db.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-router-rolling-upgrade-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("router database rolling upgrades", () => {
  it("preserves retired permission tables while another process may still use them", () => {
    const legacyDb = new Database(join(stateDir!, "ravi.db"));
    legacyDb.exec(`
      CREATE TABLE relations (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);
      CREATE TABLE permission_policy_rules (id TEXT PRIMARY KEY, marker TEXT NOT NULL);
      CREATE TABLE permission_policy_materializations (id TEXT PRIMARY KEY, marker TEXT NOT NULL);
      INSERT INTO relations (id, marker) VALUES (1, 'relation');
      INSERT INTO permission_policy_rules (id, marker) VALUES ('rule-1', 'rule');
      INSERT INTO permission_policy_materializations (id, marker) VALUES ('materialization-1', 'materialization');
    `);
    legacyDb.close();

    const db = getDb();
    const tables = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('relations', 'permission_policy_rules', 'permission_policy_materializations')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual([
      "permission_policy_materializations",
      "permission_policy_rules",
      "relations",
    ]);
    expect(db.prepare("SELECT marker FROM relations WHERE id = 1").get()).toEqual({ marker: "relation" });
    expect(db.prepare("SELECT marker FROM permission_policy_rules WHERE id = 'rule-1'").get()).toEqual({
      marker: "rule",
    });
    expect(
      db.prepare("SELECT marker FROM permission_policy_materializations WHERE id = 'materialization-1'").get(),
    ).toEqual({ marker: "materialization" });
  });
});
