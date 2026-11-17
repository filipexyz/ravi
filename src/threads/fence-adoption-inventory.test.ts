import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { LEGACY_DYNAMIC_TABLES, LEGACY_TABLE_INVENTORY } from "./fence-adoption-inventory.js";
import {
  deriveLegacyTableInventory,
  legacySource,
  legacyVocabulary,
  renderLegacyInventory,
} from "./fence-adoption-inventory-derive.js";
import {
  LEGACY_BRIDGE_RESIDUE_RULES,
  LEGACY_RESIDUE_EXCLUSIONS,
  LEGACY_ROUTER_RESIDUE_RULES,
  LEGACY_UNVERIFIED_RESIDUE_RULES,
} from "./fence-adoption-residue.js";

const TAG = "v3.261113.2";
const REPO = join(import.meta.dir, "..", "..");
const RULES = [...LEGACY_ROUTER_RESIDUE_RULES, ...LEGACY_BRIDGE_RESIDUE_RULES, ...LEGACY_UNVERIFIED_RESIDUE_RULES];

/** Columns that express work without a status: they also require a rule or an exclusion. */
const WORK_MARKER =
  /^(expires_at|delivered_at|acked_at|completed_at|processed_at|owner|owner_id|attempts|attempt|attempt_count|next_attempt_at|last_delivered_at|lock_key)$|^pending_|(^|_)(claim|claimed|lease|leased)(_|$)/;

/** CREATE TABLE statements of the tag whose name is computed; each resolved by reading the source. */
const DYNAMIC_RESOLUTION: Record<string, string[]> = {
  "src/channels/outbound-publish-outbox.ts": ["channel_outbound_publish_jobs"],
  "src/router/router-db.ts": ["channel_outbound_receipts"],
  "src/sdk/return-schemas/workflow.ts": ["cli_return_schema_commands"],
};

describe("legacy residue inventory of v3.261113.2", () => {
  it("is exactly what every CREATE TABLE of the tag declares (regenerate: bun scripts/fence-adoption-inventory.ts)", () => {
    const derived = deriveLegacyTableInventory(REPO, TAG);
    expect(derived.entries).toEqual(LEGACY_TABLE_INVENTORY as typeof derived.entries);
    expect(derived.dynamic).toEqual(LEGACY_DYNAMIC_TABLES as typeof derived.dynamic);
    expect(renderLegacyInventory(TAG, derived)).toContain(`${derived.entries.length} tables`);
  });

  it("every table with a status, state, claim, lease or work-marker column has a rule or an exclusion with a reason", () => {
    const ruled = new Set(RULES.map((rule) => rule.table));
    const excluded = new Map(LEGACY_RESIDUE_EXCLUSIONS.map((entry) => [entry.table, entry.reason]));
    const uncovered = LEGACY_TABLE_INVENTORY.filter(
      (entry) =>
        (entry.statusColumns.length > 0 || entry.columns.some((column) => WORK_MARKER.test(column))) &&
        !ruled.has(entry.table) &&
        !excluded.get(entry.table)?.trim(),
    ).map((entry) => `${entry.table} (${entry.file})`);
    expect(uncovered).toEqual([]);
  });

  it("every rule reads a column the legacy table declares", () => {
    const byTable = new Map(LEGACY_TABLE_INVENTORY.map((entry) => [entry.table, entry]));
    const wrong = RULES.filter((rule) => {
      const entry = byTable.get(rule.table);
      if (!entry) return !Object.values(DYNAMIC_RESOLUTION).flat().includes(rule.table);
      return !entry.columns.includes(rule.column);
    }).map((rule) => `${rule.table}.${rule.column}`);
    expect(wrong).toEqual([]);
  });

  it("a status listed by a CHECK constraint is always classified by its rule", () => {
    const byTable = new Map(LEGACY_TABLE_INVENTORY.map((entry) => [entry.table, entry]));
    const unclassified: string[] = [];
    for (const rule of RULES) {
      if (rule.terminalComplement || rule.condition) continue;
      const values = byTable.get(rule.table)?.statusColumns.find((column) => column.name === rule.column)?.values;
      for (const value of values ?? []) {
        const known = [rule.terminal, rule.pending, rule.inFlight, rule.blocking ?? []].some((set) =>
          set.includes(value),
        );
        if (!known) unclassified.push(`${rule.table}.${rule.column}=${value}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("every value the tag's types declare for a classified column has a class", () => {
    const unclassified: string[] = [];
    for (const rule of RULES.filter((entry) => entry.vocabulary)) {
      const values = legacyVocabulary(REPO, TAG, rule.vocabulary!.file, rule.vocabulary!.declaration);
      if (values.length === 0) unclassified.push(`${rule.table}: ${rule.vocabulary!.declaration} not found`);
      for (const value of values) {
        const known = [rule.terminal, rule.pending, rule.inFlight, rule.blocking ?? []].some((set) =>
          set.includes(value),
        );
        if (!known) unclassified.push(`${rule.table}.${rule.column}=${value}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("a value at rest by design in an unverified rule says why", () => {
    const missing = LEGACY_UNVERIFIED_RESIDUE_RULES.flatMap((rule) =>
      rule.pending.filter((value) => !rule.restReasons?.[value]?.trim()).map((value) => `${rule.table}=${value}`),
    );
    expect(missing).toEqual([]);
  });

  it("the bridge's active turn set is the tag's own active_turn index", () => {
    const store = legacySource(REPO, TAG, "src/bridge/store.ts");
    const index = /active_turn ON turns\(conversation_id\) WHERE status IN \(([^)]*)\)/.exec(store);
    expect(index).not.toBeNull();
    const active = index![1]!.split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
    const turns = LEGACY_BRIDGE_RESIDUE_RULES.find((rule) => rule.table === "turns");
    expect([...(turns?.blocking ?? [])].sort()).toEqual(active.sort());
  });

  it("every computed table name of the tag is resolved", () => {
    expect(LEGACY_DYNAMIC_TABLES.map((entry) => entry.file).sort()).toEqual(Object.keys(DYNAMIC_RESOLUTION).sort());
  });

  it("the inventory is the whole tag, not a sample", () => {
    expect(LEGACY_TABLE_INVENTORY.length).toBeGreaterThan(200);
    expect(new Set(LEGACY_TABLE_INVENTORY.map((entry) => entry.table)).size).toBe(LEGACY_TABLE_INVENTORY.length);
  });
});
