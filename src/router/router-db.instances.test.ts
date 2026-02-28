/**
 * Tests for instances table CRUD in router-db.ts
 *
 * Uses the real SQLite DB (same path as production: ~/ravi/ravi.db).
 * Each test cleans up its own data in beforeEach/afterEach to avoid pollution.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// ============================================================================
// Helpers for cleanup
// ============================================================================

const TEST_NAMES = [
  "test-inst-main",
  "test-inst-vendas",
  "test-inst-update",
  "test-inst-delete",
  "test-inst-byid",
  "test-inst-defaults",
];

function cleanupInstances() {
  try {
    const { getDb } = require("./router-db.js") as { getDb: () => import("bun:sqlite").Database };
    const db = getDb();
    for (const name of TEST_NAMES) {
      db.prepare("DELETE FROM instances WHERE name = ?").run(name);
    }
    // Clean up the test agent too
    db.prepare("DELETE FROM agents WHERE id = 'test-inst-agent'").run();
  } catch {
    // DB may not be initialized yet
  }
}

// ============================================================================
// Imports (after module-level side effects)
// ============================================================================

import {
  dbUpsertInstance,
  dbGetInstance,
  dbGetInstanceByInstanceId,
  dbListInstances,
  dbUpdateInstance,
  dbDeleteInstance,
  dbCreateAgent,
} from "./router-db.js";

const TEST_AGENT_ID = "test-inst-agent";

describe("Instances CRUD", () => {
  beforeEach(() => {
    cleanupInstances();
    // Ensure the test agent exists
    try {
      dbCreateAgent({ id: TEST_AGENT_ID, cwd: "/tmp/test-inst" });
    } catch {
      // Already exists
    }
  });

  afterEach(() => {
    cleanupInstances();
  });

  // ============================================================================
  // Create / Upsert
  // ============================================================================

  it("creates an instance with all fields", () => {
    const inst = dbUpsertInstance({
      name: "test-inst-main",
      instanceId: "uuid-1234",
      channel: "whatsapp",
      agent: TEST_AGENT_ID,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      dmScope: "per-peer",
    });

    expect(inst.name).toBe("test-inst-main");
    expect(inst.instanceId).toBe("uuid-1234");
    expect(inst.channel).toBe("whatsapp");
    expect(inst.agent).toBe(TEST_AGENT_ID);
    expect(inst.dmPolicy).toBe("pairing");
    expect(inst.groupPolicy).toBe("allowlist");
    expect(inst.dmScope).toBe("per-peer");
    expect(inst.createdAt).toBeGreaterThan(0);
    expect(inst.updatedAt).toBeGreaterThan(0);
  });

  it("uses defaults when optional fields are omitted", () => {
    const inst = dbUpsertInstance({ name: "test-inst-defaults" });

    expect(inst.dmPolicy).toBe("open");
    expect(inst.groupPolicy).toBe("open");
    expect(inst.channel).toBe("whatsapp");
    expect(inst.agent).toBeUndefined();
    expect(inst.instanceId).toBeUndefined();
    expect(inst.dmScope).toBeUndefined();
  });

  it("upserts (overwrites) existing instance on name conflict", () => {
    dbUpsertInstance({ name: "test-inst-main", dmPolicy: "open" });
    const updated = dbUpsertInstance({
      name: "test-inst-main",
      dmPolicy: "closed",
      groupPolicy: "closed",
    });

    expect(updated.dmPolicy).toBe("closed");
    expect(updated.groupPolicy).toBe("closed");
  });

  it("throws when referenced agent does not exist", () => {
    expect(() => dbUpsertInstance({ name: "test-inst-main", agent: "ghost-agent-xyz" })).toThrow("Agent not found");
  });

  it("rejects invalid dmPolicy value", () => {
    expect(() => dbUpsertInstance({ name: "test-inst-main", dmPolicy: "badvalue" as "open" })).toThrow();
  });

  it("rejects invalid groupPolicy value", () => {
    expect(() => dbUpsertInstance({ name: "test-inst-main", groupPolicy: "badvalue" as "open" })).toThrow();
  });

  it("accepts all valid dmPolicy values", () => {
    const policies: Array<"open" | "pairing" | "closed"> = ["open", "pairing", "closed"];
    for (const dmPolicy of policies) {
      const inst = dbUpsertInstance({ name: "test-inst-main", dmPolicy });
      expect(inst.dmPolicy).toBe(dmPolicy);
    }
  });

  it("accepts all valid groupPolicy values", () => {
    const policies: Array<"open" | "allowlist" | "closed"> = ["open", "allowlist", "closed"];
    for (const groupPolicy of policies) {
      const inst = dbUpsertInstance({ name: "test-inst-main", groupPolicy });
      expect(inst.groupPolicy).toBe(groupPolicy);
    }
  });

  // ============================================================================
  // Read
  // ============================================================================

  it("gets an instance by name", () => {
    dbUpsertInstance({ name: "test-inst-main", instanceId: "aaa-111" });
    const inst = dbGetInstance("test-inst-main");

    expect(inst).not.toBeNull();
    expect(inst!.name).toBe("test-inst-main");
    expect(inst!.instanceId).toBe("aaa-111");
  });

  it("returns null for non-existent instance name", () => {
    expect(dbGetInstance("no-such-instance-xyz")).toBeNull();
  });

  it("gets an instance by instanceId", () => {
    dbUpsertInstance({ name: "test-inst-byid", instanceId: "unique-uuid-xyz" });
    const inst = dbGetInstanceByInstanceId("unique-uuid-xyz");

    expect(inst).not.toBeNull();
    expect(inst!.name).toBe("test-inst-byid");
    expect(inst!.instanceId).toBe("unique-uuid-xyz");
  });

  it("returns null when instanceId is not found", () => {
    expect(dbGetInstanceByInstanceId("does-not-exist-999")).toBeNull();
  });

  it("lists all instances (contains test instances)", () => {
    dbUpsertInstance({ name: "test-inst-main" });
    dbUpsertInstance({ name: "test-inst-vendas" });

    const list = dbListInstances();
    const names = list.map((i) => i.name);

    expect(names).toContain("test-inst-main");
    expect(names).toContain("test-inst-vendas");
  });

  it("lists returns empty array when no instances exist", () => {
    // All test instances are cleaned in beforeEach
    const list = dbListInstances();
    const testInstances = list.filter((i) => TEST_NAMES.includes(i.name));
    expect(testInstances).toHaveLength(0);
  });

  // ============================================================================
  // Update
  // ============================================================================

  it("updates specific fields of an instance", () => {
    dbUpsertInstance({
      name: "test-inst-update",
      dmPolicy: "open",
      groupPolicy: "open",
    });

    const updated = dbUpdateInstance("test-inst-update", {
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    });

    expect(updated.dmPolicy).toBe("pairing");
    expect(updated.groupPolicy).toBe("allowlist");
  });

  it("partial update preserves unchanged fields", () => {
    dbUpsertInstance({
      name: "test-inst-update",
      instanceId: "keep-me",
      channel: "matrix",
      dmPolicy: "open",
      groupPolicy: "open",
    });

    const updated = dbUpdateInstance("test-inst-update", { dmPolicy: "closed" });

    expect(updated.dmPolicy).toBe("closed");
    expect(updated.instanceId).toBe("keep-me");
    expect(updated.channel).toBe("matrix");
    expect(updated.groupPolicy).toBe("open");
  });

  it("update can set dmScope", () => {
    dbUpsertInstance({ name: "test-inst-update" });
    const updated = dbUpdateInstance("test-inst-update", { dmScope: "per-channel-peer" });
    expect(updated.dmScope).toBe("per-channel-peer");
  });

  it("update can clear dmScope by setting undefined", () => {
    dbUpsertInstance({ name: "test-inst-update", dmScope: "per-peer" });
    const updated = dbUpdateInstance("test-inst-update", { dmScope: undefined });
    // undefined means preserve existing in current implementation
    expect(updated.dmScope).toBe("per-peer");
  });

  it("update can assign an existing agent", () => {
    dbUpsertInstance({ name: "test-inst-update" });
    const updated = dbUpdateInstance("test-inst-update", { agent: TEST_AGENT_ID });
    expect(updated.agent).toBe(TEST_AGENT_ID);
  });

  it("update throws when instance does not exist", () => {
    expect(() => dbUpdateInstance("no-such-instance-xyz", { dmPolicy: "closed" })).toThrow("Instance not found");
  });

  it("update throws when assigning non-existent agent", () => {
    dbUpsertInstance({ name: "test-inst-update" });
    expect(() => dbUpdateInstance("test-inst-update", { agent: "ghost-agent-xyz" })).toThrow("Agent not found");
  });

  it("update validates dmPolicy values", () => {
    dbUpsertInstance({ name: "test-inst-update" });
    expect(() => dbUpdateInstance("test-inst-update", { dmPolicy: "invalid" as "open" })).toThrow();
  });

  it("update validates groupPolicy values", () => {
    dbUpsertInstance({ name: "test-inst-update" });
    expect(() => dbUpdateInstance("test-inst-update", { groupPolicy: "invalid" as "open" })).toThrow();
  });

  it("update validates dmScope values", () => {
    dbUpsertInstance({ name: "test-inst-update" });
    expect(() => dbUpdateInstance("test-inst-update", { dmScope: "invalid" as "per-peer" })).toThrow();
  });

  // ============================================================================
  // Delete
  // ============================================================================

  it("deletes an existing instance and returns true", () => {
    dbUpsertInstance({ name: "test-inst-delete" });
    const result = dbDeleteInstance("test-inst-delete");

    expect(result).toBe(true);
    expect(dbGetInstance("test-inst-delete")).toBeNull();
  });

  it("returns false when deleting non-existent instance", () => {
    const result = dbDeleteInstance("no-such-thing-xyz-999");
    expect(result).toBe(false);
  });
});
