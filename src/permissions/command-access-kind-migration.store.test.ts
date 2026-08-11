import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  closeRouterDb,
  dbCreateAgent,
  dbCreateContext,
  dbGetAgent,
  dbGetContext,
  dbUpdateAgent,
  dbUpdateContextCapabilities,
  getDb,
} from "../router/router-db.js";
import { getOrCreateSession } from "../router/index.js";
import {
  dbGetObserverRule,
  dbListObserverBindings,
  dbUpsertObserverRule,
  ensureObserverBindingsForSession,
  ensureObservationCommandAccessGrantMigration,
} from "../runtime/observation-plane.js";
import {
  dbGetTagDefinition,
  dbUpdateTagDefinition,
  ensurePermissionTagCommandAccessGrantMigration,
  ensureTagSchema,
} from "../tags/tag-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { CLI_COMMAND_ACCESS_KIND_MIGRATION_KEYS } from "./command-access-kind-migration.js";

let stateDir: string | null = null;

describe("CLI command access durable grant migration", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-command-access-grant-migration-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("migrates agent defaults and active context snapshots on reopen", () => {
    dbCreateAgent({ id: "least-privilege", cwd: "/tmp/least-privilege" });
    dbUpdateAgent("least-privilege", {
      defaults: {
        runtimePermissions: {
          capabilities: ["read:agents:debounce", "read:agents:*"],
        },
      },
    });
    dbCreateContext({
      contextId: "ctx_legacy_read",
      contextKey: "rctx_legacy_read",
      kind: "turn-runtime",
      agentId: "least-privilege",
      capabilities: [
        { permission: "read", objectType: "agents", objectId: "debounce" },
        { permission: "read", objectType: "agents", objectId: "*" },
      ],
    });
    dbCreateContext({
      contextId: "ctx_expired_legacy_read",
      contextKey: "rctx_expired_legacy_read",
      kind: "turn-runtime",
      agentId: "least-privilege",
      capabilities: [{ permission: "read", objectType: "agents", objectId: "*" }],
      expiresAt: 1,
    });
    const contextBefore = dbGetContext("ctx_legacy_read")!;
    const expiredContextBefore = dbGetContext("ctx_expired_legacy_read");

    getDb().prepare("DELETE FROM router_meta WHERE key = ?").run(CLI_COMMAND_ACCESS_KIND_MIGRATION_KEYS.router);

    closeRouterDb();
    const migrated = dbGetAgent("least-privilege");
    const updatedAtAfterMigration = (
      getDb().prepare("SELECT updated_at FROM agents WHERE id = ?").get("least-privilege") as { updated_at: number }
    ).updated_at;

    expect(migrated?.defaults).toEqual({
      runtimePermissions: {
        capabilities: ["read:agents:debounce", "read:agents:*", "mutate:agents:debounce", "mutate:agents:spec-mode"],
      },
    });
    expect(dbGetContext("ctx_legacy_read")).toEqual({
      ...contextBefore,
      capabilities: [
        { permission: "read", objectType: "agents", objectId: "debounce" },
        { permission: "read", objectType: "agents", objectId: "*" },
        { permission: "mutate", objectType: "agents", objectId: "debounce" },
        { permission: "mutate", objectType: "agents", objectId: "spec-mode" },
      ],
    });
    expect(dbGetContext("ctx_expired_legacy_read")).toEqual(expiredContextBefore);

    const contextAfterMigration = dbGetContext("ctx_legacy_read");

    closeRouterDb();
    dbGetAgent("least-privilege");
    const updatedAtAfterSecondOpen = (
      getDb().prepare("SELECT updated_at FROM agents WHERE id = ?").get("least-privilege") as { updated_at: number }
    ).updated_at;
    expect(updatedAtAfterSecondOpen).toBe(updatedAtAfterMigration);
    expect(dbGetContext("ctx_legacy_read")).toEqual(contextAfterMigration);

    dbUpdateAgent("least-privilege", {
      defaults: { runtimePermissions: { capabilities: ["read:agents:debounce", "read:agents:*"] } },
    });
    dbUpdateContextCapabilities("ctx_legacy_read", [
      { permission: "read", objectType: "agents", objectId: "debounce" },
      { permission: "read", objectType: "agents", objectId: "*" },
    ]);

    closeRouterDb();
    expect(dbGetAgent("least-privilege")?.defaults).toEqual({
      runtimePermissions: { capabilities: ["read:agents:debounce", "read:agents:*"] },
    });
    expect(dbGetContext("ctx_legacy_read")?.capabilities).toEqual([
      { permission: "read", objectType: "agents", objectId: "debounce" },
      { permission: "read", objectType: "agents", objectId: "*" },
    ]);
  });

  it("migrates provider-owned permission tags and audits only changed definitions", () => {
    const db = getDb();
    db.exec(`
      CREATE TABLE tag_definitions (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        description TEXT,
        kind TEXT NOT NULL DEFAULT 'user',
        source TEXT NOT NULL DEFAULT 'ravi',
        metadata_json TEXT,
        created_by TEXT,
        updated_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const insert = db.prepare(`
      INSERT INTO tag_definitions (
        id, slug, label, kind, source, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "tag-permissions",
      "permissions-legacy",
      "Legacy permissions",
      "system",
      "permissions",
      JSON.stringify({
        color: "blue",
        permissions: { capabilities: ["read:sdk.openapi:emit", "read:sdk.openapi:*"] },
      }),
      1,
      1,
    );
    insert.run(
      "tag-user",
      "user-legacy",
      "User tag",
      "user",
      "permissions",
      JSON.stringify({ permissions: { capabilities: ["read:sdk.openapi:emit"] } }),
      1,
      1,
    );

    ensureTagSchema();

    expect(dbGetTagDefinition("permissions-legacy")?.metadata).toEqual({
      color: "blue",
      permissions: {
        capabilities: ["read:sdk.openapi:emit", "read:sdk.openapi:*", "mutate:sdk.openapi:emit"],
      },
    });
    expect(dbGetTagDefinition("user-legacy")?.metadata).toEqual({
      permissions: { capabilities: ["read:sdk.openapi:emit"] },
    });
    expect(db.prepare("SELECT event_type, actor FROM tag_events WHERE tag_slug = ?").all("permissions-legacy")).toEqual(
      [{ event_type: "tag.definition.updated", actor: "migration:command-access-kind-v1" }],
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM tag_events WHERE tag_slug = ?").get("user-legacy")).toEqual({
      count: 0,
    });

    dbUpdateTagDefinition({
      slug: "permissions-legacy",
      metadata: {
        color: "blue",
        permissions: { capabilities: ["read:sdk.openapi:emit", "read:sdk.openapi:*"] },
      },
      updatedBy: "operator:revoke",
    });
    ensurePermissionTagCommandAccessGrantMigration();
    expect(dbGetTagDefinition("permissions-legacy")?.metadata).toEqual({
      color: "blue",
      permissions: { capabilities: ["read:sdk.openapi:emit", "read:sdk.openapi:*"] },
    });
  });

  it("migrates observer rules and durable binding snapshots without rewriting timestamps", () => {
    dbCreateAgent({ id: "worker", cwd: "/tmp/worker" });
    dbCreateAgent({ id: "observer", cwd: "/tmp/observer" });
    const session = getOrCreateSession("grant-source", "worker", "/tmp/worker", { name: "grant-source" });
    dbUpsertObserverRule({
      id: "legacy-grants",
      scope: "agent",
      sourceAgentId: "worker",
      observerAgentId: "observer",
      observerRole: "legacy-grants",
      observerMode: "report",
      permissionGrants: ["read:agents:debounce", "read:agents:*"],
    });
    const attached = ensureObserverBindingsForSession({ sessionName: "grant-source", session });
    expect(attached.bindings).toHaveLength(1);

    const db = getDb();
    const before = {
      rule: db
        .prepare("SELECT permission_grants_json, updated_at FROM observer_rules WHERE id = ?")
        .get("legacy-grants"),
      binding: db
        .prepare("SELECT permission_grants_json, updated_at FROM observer_bindings WHERE id = ?")
        .get(attached.bindings[0]!.id),
    };

    db.prepare("DELETE FROM router_meta WHERE key = ?").run(CLI_COMMAND_ACCESS_KIND_MIGRATION_KEYS.observation);

    expect(ensureObservationCommandAccessGrantMigration()).toEqual({
      changedRules: 1,
      changedBindings: 1,
      addedGrants: 4,
      ambiguousGrants: 0,
    });
    expect(dbGetObserverRule("legacy-grants")?.permissionGrants).toEqual([
      "read:agents:*",
      "read:agents:debounce",
      "mutate:agents:debounce",
      "mutate:agents:spec-mode",
    ]);
    expect(dbListObserverBindings({ sourceSessionKey: "grant-source" })[0]?.permissionGrants).toEqual([
      "read:agents:*",
      "read:agents:debounce",
      "mutate:agents:debounce",
      "mutate:agents:spec-mode",
    ]);

    const after = {
      rule: db
        .prepare("SELECT permission_grants_json, updated_at FROM observer_rules WHERE id = ?")
        .get("legacy-grants"),
      binding: db
        .prepare("SELECT permission_grants_json, updated_at FROM observer_bindings WHERE id = ?")
        .get(attached.bindings[0]!.id),
    };
    expect(after.rule).not.toEqual(before.rule);
    expect(after.binding).not.toEqual(before.binding);
    expect((after.rule as { updated_at: number }).updated_at).toBe((before.rule as { updated_at: number }).updated_at);
    expect((after.binding as { updated_at: number }).updated_at).toBe(
      (before.binding as { updated_at: number }).updated_at,
    );

    expect(ensureObservationCommandAccessGrantMigration()).toEqual({
      changedRules: 0,
      changedBindings: 0,
      addedGrants: 0,
      ambiguousGrants: 0,
    });

    db.prepare("UPDATE observer_rules SET permission_grants_json = ? WHERE id = ?").run(
      JSON.stringify(["read:agents:*", "read:agents:debounce"]),
      "legacy-grants",
    );
    db.prepare("UPDATE observer_bindings SET permission_grants_json = ? WHERE id = ?").run(
      JSON.stringify(["read:agents:*", "read:agents:debounce"]),
      attached.bindings[0]!.id,
    );
    ensureObservationCommandAccessGrantMigration();
    expect(dbGetObserverRule("legacy-grants")?.permissionGrants).toEqual(["read:agents:*", "read:agents:debounce"]);
    expect(dbListObserverBindings({ sourceSessionKey: "grant-source" })[0]?.permissionGrants).toEqual([
      "read:agents:*",
      "read:agents:debounce",
    ]);
  });
});
