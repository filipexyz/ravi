import { describe, expect, it } from "bun:test";
import { LEGACY_DYNAMIC_TABLES, LEGACY_TABLE_INVENTORY } from "./fence-adoption-inventory.js";
import {
  LEGACY_BRIDGE_RESIDUE_RULES,
  LEGACY_RESIDUE_EXCLUSIONS,
  LEGACY_ROUTER_RESIDUE_RULES,
  LEGACY_UNVERIFIED_RESIDUE_RULES,
} from "./fence-adoption-residue.js";

const RULES = [...LEGACY_ROUTER_RESIDUE_RULES, ...LEGACY_BRIDGE_RESIDUE_RULES, ...LEGACY_UNVERIFIED_RESIDUE_RULES];

/** CREATE TABLE statements of the tag whose name is computed; each resolved by reading the source. */
const DYNAMIC_RESOLUTION: Record<string, string[]> = {
  "src/channels/outbound-publish-outbox.ts": ["channel_outbound_publish_jobs"],
  "src/router/router-db.ts": ["channel_outbound_receipts"],
  "src/sdk/return-schemas/workflow.ts": ["cli_return_schema_commands"],
};

describe("legacy residue inventory of v3.261113.2", () => {
  it("every table with a status, state, claim or lease column has a rule or an exclusion with a reason", () => {
    const ruled = new Set(RULES.map((rule) => rule.table));
    const excluded = new Map(LEGACY_RESIDUE_EXCLUSIONS.map((entry) => [entry.table, entry.reason]));
    const uncovered = LEGACY_TABLE_INVENTORY.filter(
      (entry) => entry.statusColumns.length > 0 && !ruled.has(entry.table) && !excluded.get(entry.table)?.trim(),
    ).map((entry) => `${entry.table} (${entry.file})`);
    expect(uncovered).toEqual([]);
  });

  it("every rule reads a column the legacy table declares", () => {
    const byTable = new Map(LEGACY_TABLE_INVENTORY.map((entry) => [entry.table, entry]));
    const wrong = RULES.filter((rule) => {
      const entry = byTable.get(rule.table);
      // channel_outbound_publish_jobs and channel_outbound_receipts come from computed names.
      if (!entry) return !Object.values(DYNAMIC_RESOLUTION).flat().includes(rule.table);
      return !entry.columns.includes(rule.column);
    }).map((rule) => `${rule.table}.${rule.column}`);
    expect(wrong).toEqual([]);
  });

  it("a status listed by a CHECK constraint is always classified by its rule", () => {
    const byTable = new Map(LEGACY_TABLE_INVENTORY.map((entry) => [entry.table, entry]));
    const unclassified: string[] = [];
    for (const rule of RULES) {
      if (rule.terminalComplement || rule.unverified) continue;
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

  it("every computed table name of the tag is resolved", () => {
    expect(LEGACY_DYNAMIC_TABLES.map((entry) => entry.file).sort()).toEqual(Object.keys(DYNAMIC_RESOLUTION).sort());
  });

  it("the inventory is the whole tag, not a sample", () => {
    expect(LEGACY_TABLE_INVENTORY.length).toBeGreaterThan(200);
    expect(new Set(LEGACY_TABLE_INVENTORY.map((entry) => entry.table)).size).toBe(LEGACY_TABLE_INVENTORY.length);
  });
});
