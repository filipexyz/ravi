import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { closeContacts, upsertContact } from "./contacts.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

let stateDir: string | null = null;

setDefaultTimeout(20_000);

const SCOPED_TABLES = ["crm_pipelines", "crm_opportunities", "crm_tasks", "crm_accounts", "crm_activities"] as const;

// Faithful pre-migration crm_pipelines schema: identical to the CREATE in
// src/contacts.ts but WITHOUT business_unit_id, which initializeCrmSchema adds
// later via ensureTableColumn. Lets us prove the migration backfills a row that
// existed before the column did.
const LEGACY_CRM_PIPELINES = `
  CREATE TABLE crm_pipelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'opportunity',
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function openChatDb(): Database {
  return new Database(join(stateDir as string, "chat.db"));
}

/** Touches the cached contacts DB getter, which runs initializeCrmSchema. */
function triggerCrmSchemaInit(): void {
  upsertContact("5511999999999", "Schema Trigger");
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-crm-bu-test-");
});

afterEach(async () => {
  closeContacts();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("CRM business-unit Phase 1 migration", () => {
  it("creates crm_business_units and seeds exactly one default business unit", () => {
    triggerCrmSchemaInit();
    closeContacts();

    const db = openChatDb();
    const rows = db.prepare("SELECT id, slug, name, is_default FROM crm_business_units").all() as Array<{
      id: string;
      slug: string;
      name: string;
      is_default: number;
    }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "default", slug: "default", is_default: 1 });
  });

  it("adds a NOT NULL business_unit_id defaulting to 'default' on all five commercial tables", () => {
    triggerCrmSchemaInit();
    closeContacts();

    const db = openChatDb();
    for (const table of SCOPED_TABLES) {
      const col = (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).find((c) => c.name === "business_unit_id");
      expect(col, `${table}.business_unit_id should exist`).toBeDefined();
      expect(col!.notnull, `${table}.business_unit_id should be NOT NULL`).toBe(1);
      expect(col!.dflt_value, `${table}.business_unit_id default`).toBe("'default'");
    }
    db.close();
  });

  it("backfills pre-existing rows to the default business unit", () => {
    // Manufacture a legacy DB: crm_pipelines with a row but no business_unit_id.
    const legacy = openChatDb();
    legacy.exec(LEGACY_CRM_PIPELINES);
    legacy.exec("INSERT INTO crm_pipelines (id, name) VALUES ('legacy-pipe', 'Legacy Pipeline')");
    legacy.close();

    triggerCrmSchemaInit();
    closeContacts();

    const db = openChatDb();
    const row = db.prepare("SELECT business_unit_id FROM crm_pipelines WHERE id = ?").get("legacy-pipe") as {
      business_unit_id: string;
    } | null;
    db.close();

    expect(row?.business_unit_id).toBe("default");
  });

  it("enforces a single default business unit via the partial unique index", () => {
    triggerCrmSchemaInit();
    closeContacts();

    const db = openChatDb();
    expect(() =>
      db
        .prepare("INSERT INTO crm_business_units (id, slug, name, is_default) VALUES (?, ?, ?, 1)")
        .run("second", "second", "Second"),
    ).toThrow();
    db.close();
  });

  it("creates the per-business-unit contact overlay keyed by (contact_id, business_unit_id)", () => {
    triggerCrmSchemaInit();
    closeContacts();

    const db = openChatDb();
    const cols = db.prepare("PRAGMA table_info(crm_contact_business_unit_profiles)").all() as Array<{
      name: string;
      pk: number;
    }>;
    db.close();

    expect(cols.length, "overlay table should exist").toBeGreaterThan(0);
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual(["contact_id", "business_unit_id"]);
  });

  it("is idempotent across re-open", () => {
    triggerCrmSchemaInit();
    closeContacts();
    // Second open re-runs initializeCrmSchema; the guarded ALTERs must not throw.
    expect(() => triggerCrmSchemaInit()).not.toThrow();
    closeContacts();

    const db = openChatDb();
    const defaults = (
      db.prepare("SELECT COUNT(*) AS n FROM crm_business_units WHERE is_default = 1").get() as { n: number }
    ).n;
    const hasColumn = (db.prepare("PRAGMA table_info(crm_pipelines)").all() as Array<{ name: string }>).some(
      (c) => c.name === "business_unit_id",
    );
    db.close();

    expect(defaults).toBe(1);
    expect(hasColumn).toBe(true);
  });
});
