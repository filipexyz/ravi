import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { closeRouterDb, getDb } from "./router-db.js";

let stateDir: string | null = null;

function instanceColumn(name: string): { name: string; notnull: number; dflt_value: string | null } | undefined {
  return (
    getDb().prepare("PRAGMA table_info(instances)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>
  ).find((c) => c.name === name);
}

describe("instances CRM business-unit pointer migration", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-crm-bu-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("adds a nullable crm_business_unit_id column to instances", () => {
    const col = instanceColumn("crm_business_unit_id");

    expect(col, "instances.crm_business_unit_id should exist").toBeDefined();
    // Nullable + no default: unmapped instances stay NULL and resolve to the
    // default business unit at the Phase 2 resolver, not via a column default.
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });

  it("carries no foreign key — it is a cross-DB pointer, not a SQLite FK", () => {
    // crm_business_units lives in chat.db (contacts) and instances in ravi.db
    // (router); SQLite FKs cannot cross files. An inline REFERENCES would crash
    // every prepared INSERT/UPDATE on instances under foreign_keys=ON. Assert
    // the column exists but instances carries no FK to crm_business_units.
    const fks = getDb().prepare("PRAGMA foreign_key_list(instances)").all() as Array<{ table: string; from: string }>;
    expect(fks.some((fk) => fk.from === "crm_business_unit_id")).toBe(false);
    expect(fks.some((fk) => fk.table === "crm_business_units")).toBe(false);

    // And the router can prepare writes to instances even though
    // crm_business_units does not exist in ravi.db.
    expect(() =>
      getDb().prepare(
        "INSERT OR IGNORE INTO instances (name, channel, enabled, created_at, updated_at) VALUES ('probe', 'whatsapp', 1, 0, 0)",
      ),
    ).not.toThrow();
  });

  it("is idempotent across re-open", () => {
    expect(instanceColumn("crm_business_unit_id")).toBeDefined();
    closeRouterDb();
    // Re-open re-runs the guarded migration; must not throw and must not duplicate.
    expect(() => getDb()).not.toThrow();
    expect(instanceColumn("crm_business_unit_id")).toBeDefined();
  });
});
