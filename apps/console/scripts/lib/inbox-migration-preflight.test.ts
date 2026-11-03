import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  assertInboxMigrationState,
  INBOX_BASELINE_WHEN,
  INBOX_INSTALLATION_REQUIRED_WHEN,
  InboxMigrationDriftError,
  migrationCommandFailure,
  postgresIdentifier,
  type InboxCatalogState,
} from "./inbox-migration-preflight";

const snapshot = JSON.parse(readFileSync(new URL("../../drizzle/meta/0008_snapshot.json", import.meta.url), "utf8"));
const names = ["agent_inbox_items", "agent_inbox_subscriptions", "agent_inbox_receipts", "agent_inbox_watermarks"];
const typeNames: Record<string, string> = {
  bigserial: "int8", bigint: "int8", integer: "int4", "timestamp with time zone": "timestamptz",
};

function empty(): InboxCatalogState {
  return { latestMigration: null, publicTableCount: 0, tables: {}, enums: {} };
}

function valid(latestMigration = INBOX_INSTALLATION_REQUIRED_WHEN): InboxCatalogState {
  const state = empty();
  state.latestMigration = latestMigration;
  state.publicTableCount = 4;
  for (const [name, value] of Object.entries(snapshot.enums) as [string, { values: string[] }][]) {
    if (name.startsWith("public.agent_inbox_")) state.enums[name.slice(7)] = [...value.values];
  }
  for (const name of names) {
    const table = snapshot.tables[`public.${name}`];
    const actual: InboxCatalogState["tables"][string] = { columns: {}, foreignKeys: {}, indexes: {} };
    state.tables[name] = actual;
    for (const c of Object.values(table.columns) as {
      name: string; type: string; typeSchema?: string; notNull: boolean; primaryKey: boolean; default?: string | number;
    }[]) {
      actual.columns[c.name] = {
        type: typeNames[c.type] ?? c.type,
        typeSchema: c.typeSchema ?? "pg_catalog",
        notNull: c.notNull || (name === "agent_inbox_subscriptions" && c.name === "local_installation_id" && latestMigration >= INBOX_INSTALLATION_REQUIRED_WHEN),
        primaryKey: c.primaryKey,
        default: c.type === "bigserial" ? "nextval('agent_inbox_items_sequence_seq'::regclass)" : c.default === undefined ? null : String(c.default),
        ownedSequence: c.type === "bigserial",
      };
    }
    for (const [key, f] of Object.entries(table.foreignKeys) as [string, {
      tableTo: string; columnsFrom: string[]; columnsTo: string[]; onDelete: string; onUpdate: string;
    }][]) {
      actual.foreignKeys[postgresIdentifier(key)] = {
        tableTo: f.tableTo, schemaTo: "public", columnsFrom: [...f.columnsFrom], columnsTo: [...f.columnsTo],
        onDelete: f.onDelete, onUpdate: f.onUpdate, validated: true, deferrable: false, matchType: "s",
      };
    }
    for (const [key, i] of Object.entries(table.indexes) as [string, {
      isUnique: boolean; method: string; columns: { expression: string; asc: boolean; nulls: string }[];
    }][]) {
      actual.indexes[postgresIdentifier(key)] = {
        unique: i.isUnique, method: i.method,
        columns: i.columns.map((c) => ({ name: c.expression, asc: c.asc, nulls: c.nulls })),
        predicate: null, valid: true, ready: true, includeCount: 0,
      };
    }
  }
  return state;
}

function rejects(state: InboxCatalogState, fragment: string, phase: "preflight" | "postflight" = "preflight") {
  expect(() => assertInboxMigrationState(state, phase)).toThrow(InboxMigrationDriftError);
  expect(() => assertInboxMigrationState(state, phase)).toThrow(fragment);
}

describe("historical inbox migration gate", () => {
  test("permits genuinely fresh zero-table, zero-history installs without mutating state", () => {
    const state = empty();
    assertInboxMigrationState(state, "preflight");
    expect(state).toEqual(empty());
  });

  test("permits migration history before the pending baseline with no inbox objects", () => {
    const state = empty();
    state.latestMigration = INBOX_BASELINE_WHEN - 1;
    state.publicTableCount = 32;
    expect(() => assertInboxMigrationState(state, "preflight")).not.toThrow();
  });

  test("rejects untracked tables and orphan inbox enums on an apparent fresh database", () => {
    const state = empty();
    state.publicTableCount = 1;
    rejects(state, "without migration history");
    state.publicTableCount = 0;
    state.enums.agent_inbox_delivery_mode = ["poll"];
    rejects(state, "before their pending baseline");
  });

  test("rejects objects that a pending baseline would attempt to recreate", () => {
    const state = valid();
    state.latestMigration = INBOX_BASELINE_WHEN - 1;
    rejects(state, "before their pending baseline");
  });

  test("requires the baseline at its exact high-water mark, not only newer history", () => {
    const state = empty();
    state.latestMigration = INBOX_BASELINE_WHEN;
    rejects(state, "agent_inbox_items missing");
    expect(() => assertInboxMigrationState(valid(INBOX_BASELINE_WHEN), "preflight")).not.toThrow();
  });

  test("permits nullable installation only while its NOT NULL repair is still pending", () => {
    const state = valid(INBOX_INSTALLATION_REQUIRED_WHEN - 1);
    expect(() => assertInboxMigrationState(state, "preflight")).not.toThrow();
    state.latestMigration = INBOX_INSTALLATION_REQUIRED_WHEN;
    rejects(state, "local_installation_id nullability");
    rejects(valid(INBOX_INSTALLATION_REQUIRED_WHEN - 1), "local_installation_id nullability", "postflight");
  });

  test("accepts an already-tightened installation column before its repair", () => {
    const state = valid();
    state.latestMigration = INBOX_BASELINE_WHEN;
    expect(() => assertInboxMigrationState(state, "preflight")).not.toThrow();
  });

  test("postflight requires successful history and full current shape", () => {
    rejects(empty(), "history did not reach", "postflight");
    expect(() => assertInboxMigrationState(valid(1_792_731_601_000), "postflight")).not.toThrow();
    const state = valid();
    state.latestMigration = INBOX_BASELINE_WHEN;
    rejects(state, "history did not reach", "postflight");
  });

  test.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid history %s", (when) => {
    const state = empty();
    state.latestMigration = when;
    rejects(state, "invalid migration high-water mark");
  });

  test("the snapshot covers exactly four tables, five enums, eight FKs and nineteen indexes", () => {
    const state = valid();
    expect(Object.keys(state.tables)).toHaveLength(4);
    expect(Object.keys(state.enums)).toHaveLength(5);
    expect(Object.values(state.tables).flatMap((table) => Object.keys(table.foreignKeys))).toHaveLength(8);
    expect(Object.values(state.tables).flatMap((table) => Object.keys(table.indexes))).toHaveLength(19);
  });

  test("compares PostgreSQL-truncated constraint identifiers, preserving full UTF-8 characters", () => {
    const long = "agent_inbox_subscriptions_local_installation_id_local_installations_id_fk";
    expect(long.length).toBeGreaterThan(63);
    expect(postgresIdentifier(long)).toBe(long.slice(0, 63));
    expect(postgresIdentifier("a".repeat(62) + "é")).toBe("a".repeat(62));
    expect(postgresIdentifier("a".repeat(61) + "é" + "x")).toBe("a".repeat(61) + "é");
    const state = valid();
    expect(state.tables.agent_inbox_subscriptions!.foreignKeys[long]).toBeUndefined();
    expect(state.tables.agent_inbox_subscriptions!.foreignKeys[postgresIdentifier(long)]).toBeDefined();
    expect(() => assertInboxMigrationState(state, "postflight")).not.toThrow();
  });

  for (const name of names) {
    test(`requires table ${name} even when historical outbox FK applied`, () => {
      const state = valid();
      delete state.tables[name];
      rejects(state, `${name} missing`);
    });
  }
  for (const name of Object.keys(valid().enums)) {
    test(`requires exact enum labels/order for ${name}`, () => {
      const state = valid();
      delete state.enums[name];
      rejects(state, name);
      state.enums[name] = [...valid().enums[name]!, "unexpected"];
      rejects(state, name);
    });
  }
  for (const [name, table] of Object.entries(valid().tables)) {
    for (const key of Object.keys(table.foreignKeys)) {
      test(`requires validated FK ${key}`, () => {
        const state = valid();
        state.tables[name]!.foreignKeys[key]!.validated = false;
        rejects(state, key);
        delete state.tables[name]!.foreignKeys[key];
        rejects(state, key);
      });
    }
    for (const key of Object.keys(table.indexes)) {
      test(`requires working index ${key}`, () => {
        const state = valid();
        state.tables[name]!.indexes[key]!.valid = false;
        rejects(state, key);
        delete state.tables[name]!.indexes[key];
        rejects(state, key);
      });
    }
  }

  test("checks column types, ownership, defaults, primary keys and nullability without logging values", () => {
    const state = valid();
    const columns = state.tables.agent_inbox_items!.columns;
    columns.id!.type = "text";
    columns.sequence!.ownedSequence = false;
    columns.created_at!.default = "private value must not be in diagnostic";
    columns.title!.notNull = false;
    columns.id!.primaryKey = false;
    delete columns.summary;
    rejects(state, "id type differs");
    rejects(state, "sequence serial sequence missing");
    rejects(state, "created_at default differs");
    rejects(state, "title nullability differs");
    rejects(state, "id primary key differs");
    rejects(state, "summary missing");
    try { assertInboxMigrationState(state, "preflight"); } catch (error) {
      expect(String(error)).not.toContain("private value");
    }
  });

  test("accepts PostgreSQL canonical casts for expected defaults", () => {
    const state = valid();
    state.tables.agent_inbox_items!.columns.severity!.default = "'info'::agent_inbox_severity";
    state.tables.agent_inbox_items!.columns.sensitivity!.default = "'metadata'::public.agent_inbox_sensitivity";
    state.tables.agent_inbox_watermarks!.columns.cache_key!.default = "'0'::text";
    expect(() => assertInboxMigrationState(state, "preflight")).not.toThrow();
  });

  test("checks FK target schema, column order, actions and deferral", () => {
    const key = "agent_inbox_receipts_item_id_agent_inbox_items_id_fk";
    for (const mutation of [
      { schemaTo: "another_schema" }, { tableTo: "another_table" }, { columnsFrom: ["id"] },
      { columnsTo: ["sequence"] }, { onDelete: "no action" }, { onUpdate: "cascade" },
      { deferrable: true }, { matchType: "f" },
    ]) {
      const state = valid();
      Object.assign(state.tables.agent_inbox_receipts!.foreignKeys[key]!, mutation);
      rejects(state, key);
    }
  });

  test("checks index uniqueness, ordering, predicate, readiness and access method", () => {
    const key = "agent_inbox_items_org_dedupe_unique";
    for (const mutation of [
      { unique: false }, { method: "hash" }, { predicate: "false" }, { ready: false }, { includeCount: 1 },
      { columns: [{ name: "dedupe_key", asc: true, nulls: "last" }, { name: "organization_id", asc: true, nulls: "last" }] },
      { columns: [{ name: "organization_id", asc: false, nulls: "last" }, { name: "dedupe_key", asc: true, nulls: "last" }] },
    ]) {
      const state = valid();
      Object.assign(state.tables.agent_inbox_items!.indexes[key]!, mutation);
      rejects(state, key);
    }
  });
});

describe("migration child process results", () => {
  test("only explicit exit zero succeeds", () => {
    expect(migrationCommandFailure(0, null)).toBeNull();
    expect(migrationCommandFailure(null, null)?.exitCode).toBe(1);
  });
  test.each([1, 2, 42, 137])("preserves nonzero exit %s", (code) => {
    expect(migrationCommandFailure(code, null)?.exitCode).toBe(code);
  });
  test("SIGKILL and SIGTERM cannot be confused with null exit success", () => {
    expect(migrationCommandFailure(null, "SIGKILL")?.exitCode).toBe(137);
    expect(migrationCommandFailure(null, "SIGKILL")?.message).toContain("SIGKILL");
    expect(migrationCommandFailure(null, "SIGTERM")?.exitCode).toBe(143);
    expect(migrationCommandFailure(0, "SIGTERM")?.exitCode).toBe(143);
  });
});
