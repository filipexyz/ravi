import { describe, expect, it } from "bun:test";

import {
  CLI_READ_TO_MUTATE_MIGRATIONS,
  migrateAgentDefaultsRecord,
  migrateLegacyReadCapabilityInputs,
  migratePermissionTagMetadata,
  migrateSerializedCapabilityArray,
} from "./command-access-kind-migration.js";

describe("CLI command access kind migration", () => {
  it("has one unique entry for every reclassified operation", () => {
    const keys = CLI_READ_TO_MUTATE_MIGRATIONS.map(({ resource, action }) => `${resource}:${action}`);
    expect(keys).toHaveLength(69);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("adds exact mutate grants for canonical strings, aliases, and objects", () => {
    const result = migrateLegacyReadCapabilityInputs([
      "read:agents:debounce",
      "read:chats.lists.delta:*",
      { permission: "read", objectType: "costs", objectId: "pricing", source: "fixture" },
    ]);

    expect(result).toMatchObject({ changed: true, added: 3, ambiguous: 0 });
    expect(result.capabilities).toEqual([
      "read:agents:debounce",
      "read:chats.lists.delta:*",
      { permission: "read", objectType: "costs", objectId: "pricing", source: "fixture" },
      "mutate:agents:debounce",
      "mutate:chats.lists.delta:*",
      { permission: "mutate", objectType: "costs", objectId: "pricing", source: "fixture" },
    ]);
  });

  it("expands read wildcards only into exact grants for reclassified operations", () => {
    const result = migrateLegacyReadCapabilityInputs(["read:agents:*"]);

    expect(result).toEqual({
      capabilities: ["read:agents:*", "mutate:agents:debounce", "mutate:agents:spec-mode"],
      changed: true,
      added: 2,
      ambiguous: 0,
    });

    expect(migrateLegacyReadCapabilityInputs(["read:agents:spec-*"])).toEqual({
      capabilities: ["read:agents:spec-*", "mutate:agents:spec-mode"],
      changed: true,
      added: 1,
      ambiguous: 0,
    });
  });

  it("preserves object grant metadata while making wildcard counterparts exact", () => {
    const source = {
      permission: "read",
      objectType: "prox.calls.tools",
      objectId: "*",
      source: "fixture",
    };

    const result = migrateLegacyReadCapabilityInputs([source]);

    expect(result).toMatchObject({ changed: true, added: 3, ambiguous: 0 });
    expect(result.capabilities).toEqual([
      source,
      { ...source, permission: "mutate", objectId: "configure" },
      { ...source, permission: "mutate", objectId: "bind" },
      { ...source, permission: "mutate", objectId: "unbind" },
    ]);
  });

  it("preserves unrelated and malformed inputs", () => {
    const inputs = ["read:unrelated:*", "not-a-capability", { permission: "read", objectType: "agents" }];

    const result = migrateLegacyReadCapabilityInputs(inputs);

    expect(result).toEqual({ capabilities: inputs, changed: false, added: 0, ambiguous: 0 });
  });

  it("does not duplicate existing mutate coverage and is idempotent", () => {
    const first = migrateLegacyReadCapabilityInputs([
      "read:agents:debounce",
      "mutate:agents:*",
      { permission: "read", objectType: "sdk.openapi", objectId: "emit" },
    ]);
    expect(first).toMatchObject({ changed: true, added: 1, ambiguous: 0 });
    expect(first.capabilities).toContainEqual({ permission: "mutate", objectType: "sdk.openapi", objectId: "emit" });

    const second = migrateLegacyReadCapabilityInputs(first.capabilities);
    expect(second).toEqual({ capabilities: first.capabilities, changed: false, added: 0, ambiguous: 0 });
  });

  it("migrates agent defaults without changing unrelated defaults", () => {
    const result = migrateAgentDefaultsRecord({
      model: "sonnet",
      runtimePermissions: {
        profile: "bootstrap",
        capabilities: ["read:agents:debounce", "read:agents:*"],
      },
    });

    expect(result).toMatchObject({ changed: true, added: 2, ambiguous: 0 });
    expect(result.defaults).toEqual({
      model: "sonnet",
      runtimePermissions: {
        profile: "bootstrap",
        capabilities: ["read:agents:debounce", "read:agents:*", "mutate:agents:debounce", "mutate:agents:spec-mode"],
      },
    });
  });

  it("migrates only the active permission-tag capability location", () => {
    const nested = migratePermissionTagMetadata({
      color: "blue",
      permissions: { capabilities: ["read:sdk.openapi:emit"] },
      capabilities: ["read:agents:debounce"],
      permissionCapabilities: ["read:costs:pricing"],
    });
    expect(nested).toMatchObject({ changed: true, added: 1, ambiguous: 0 });
    expect(nested.metadata).toEqual({
      color: "blue",
      permissions: { capabilities: ["read:sdk.openapi:emit", "mutate:sdk.openapi:emit"] },
      capabilities: ["read:agents:debounce"],
      permissionCapabilities: ["read:costs:pricing"],
    });

    expect(migratePermissionTagMetadata({ permissionCapabilities: ["read:costs:pricing"] }).metadata).toEqual({
      permissionCapabilities: ["read:costs:pricing", "mutate:costs:pricing"],
    });
  });

  it("migrates serialized capability arrays and preserves malformed JSON byte-for-byte", () => {
    const migrated = migrateSerializedCapabilityArray('["read:agents:debounce"]');
    expect(migrated).toEqual({
      serialized: '["read:agents:debounce","mutate:agents:debounce"]',
      changed: true,
      added: 1,
      ambiguous: 0,
      valid: true,
    });

    const malformed = migrateSerializedCapabilityArray("{not-json");
    expect(malformed).toEqual({
      serialized: "{not-json",
      changed: false,
      added: 0,
      ambiguous: 0,
      valid: false,
    });
  });
});
