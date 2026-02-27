/**
 * Tests for the resolvePolicy logic in consumer.ts.
 *
 * Since resolvePolicy is a private inline function inside handleMessage,
 * we replicate its exact logic here and test the priority hierarchy:
 *
 *   1. routePolicy (explicit override on the matched route)
 *   2. instance config (from RouterConfig.instances[accountId])
 *   3. legacy settings: account.<id>.policyName / whatsapp.policyName
 *   4. defaultValue
 *
 * Uses mock.module to stub dbGetSetting so no real DB is needed.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { RouterConfig } from "../router/types.js";
import type { InstanceConfig } from "../router/router-db.js";

// ============================================================================
// Local settings store (no DB needed — resolvePolicy accepts getSetting as param)
// ============================================================================

let settingsStore: Record<string, string> = {};

// ============================================================================
// resolvePolicy — extracted and tested in isolation
// ============================================================================

/**
 * Mirrors consumer.ts resolvePolicy exactly.
 */
function resolvePolicy(
  policyName: "groupPolicy" | "dmPolicy",
  routePolicy: string | undefined,
  defaultValue: string,
  routerConfig: Pick<RouterConfig, "instances">,
  effectiveAccountId: string,
  getSetting: (key: string) => string | null
): string {
  // 1. Explicit route override
  if (routePolicy) return routePolicy;

  // 2. Instance config
  const instance = routerConfig.instances?.[effectiveAccountId] as InstanceConfig | undefined;
  if (instance) {
    const val = policyName === "groupPolicy" ? instance.groupPolicy : instance.dmPolicy;
    if (val) return val;
  }

  // 3. Legacy settings fallback
  return (
    getSetting(`account.${effectiveAccountId}.${policyName}`) ??
    getSetting(`whatsapp.${policyName}`) ??
    defaultValue
  );
}

// ============================================================================
// Helpers
// ============================================================================

function makeInstance(partial: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    name: "main",
    channel: "whatsapp",
    dmPolicy: "open",
    groupPolicy: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  };
}

function makeConfig(instances: Record<string, InstanceConfig> = {}): Pick<RouterConfig, "instances"> {
  return { instances };
}

describe("resolvePolicy — priority hierarchy", () => {
  beforeEach(() => {
    settingsStore = {};
  });

  // ============================================================================
  // Tier 1: route.policy takes absolute priority
  // ============================================================================

  it("route.policy overrides everything else", () => {
    const config = makeConfig({
      "acc-1": makeInstance({ dmPolicy: "pairing", groupPolicy: "allowlist" }),
    });
    settingsStore["account.acc-1.dmPolicy"] = "closed";
    settingsStore["whatsapp.dmPolicy"] = "closed";

    const result = resolvePolicy("dmPolicy", "closed-by-route", "open", config, "acc-1", (k) => settingsStore[k] ?? null);
    expect(result).toBe("closed-by-route");
  });

  it("route.policy works for groupPolicy too", () => {
    const config = makeConfig({
      "acc-1": makeInstance({ groupPolicy: "open" }),
    });

    const result = resolvePolicy("groupPolicy", "allowlist", "open", config, "acc-1", (k) => settingsStore[k] ?? null);
    expect(result).toBe("allowlist");
  });

  // ============================================================================
  // Tier 2: instance config (RouterConfig.instances)
  // ============================================================================

  it("instance dmPolicy is used when no route policy", () => {
    const config = makeConfig({
      "acc-1": makeInstance({ dmPolicy: "pairing" }),
    });

    const result = resolvePolicy("dmPolicy", undefined, "open", config, "acc-1", (k) => settingsStore[k] ?? null);
    expect(result).toBe("pairing");
  });

  it("instance groupPolicy is used when no route policy", () => {
    const config = makeConfig({
      "acc-1": makeInstance({ groupPolicy: "allowlist" }),
    });

    const result = resolvePolicy("groupPolicy", undefined, "open", config, "acc-1", (k) => settingsStore[k] ?? null);
    expect(result).toBe("allowlist");
  });

  it("instance config overrides legacy settings", () => {
    const config = makeConfig({
      "acc-1": makeInstance({ dmPolicy: "pairing" }),
    });
    settingsStore["account.acc-1.dmPolicy"] = "closed";

    const result = resolvePolicy("dmPolicy", undefined, "open", config, "acc-1", (k) => settingsStore[k] ?? null);
    expect(result).toBe("pairing");
  });

  it("instance dmPolicy=open is still returned (truthy check)", () => {
    const config = makeConfig({
      "acc-1": makeInstance({ dmPolicy: "open" }),
    });
    settingsStore["account.acc-1.dmPolicy"] = "closed";

    const result = resolvePolicy("dmPolicy", undefined, "open", config, "acc-1", (k) => settingsStore[k] ?? null);
    // "open" is truthy, so instance config wins
    expect(result).toBe("open");
  });

  // ============================================================================
  // Tier 3: legacy settings
  // ============================================================================

  it("falls back to account.<id>.policyName when no instance config", () => {
    const config = makeConfig({}); // no instances
    settingsStore["account.acc-1.dmPolicy"] = "pairing";

    const result = resolvePolicy("dmPolicy", undefined, "open", config, "acc-1", (k) => settingsStore[k] ?? null);
    expect(result).toBe("pairing");
  });

  it("falls back to whatsapp.policyName when no account setting", () => {
    const config = makeConfig({});
    settingsStore["whatsapp.dmPolicy"] = "closed";

    const result = resolvePolicy("dmPolicy", undefined, "open", config, "acc-1", (k) => settingsStore[k] ?? null);
    expect(result).toBe("closed");
  });

  it("account setting takes priority over whatsapp global setting", () => {
    const config = makeConfig({});
    settingsStore["account.acc-1.dmPolicy"] = "pairing";
    settingsStore["whatsapp.dmPolicy"] = "closed";

    const result = resolvePolicy("dmPolicy", undefined, "open", config, "acc-1", (k) => settingsStore[k] ?? null);
    expect(result).toBe("pairing");
  });

  // ============================================================================
  // Tier 4: default value
  // ============================================================================

  it("returns defaultValue when nothing else matches", () => {
    const config = makeConfig({});

    const result = resolvePolicy("dmPolicy", undefined, "open", config, "acc-1", (k) => settingsStore[k] ?? null);
    expect(result).toBe("open");
  });

  it("returns custom defaultValue", () => {
    const config = makeConfig({});

    const result = resolvePolicy("groupPolicy", undefined, "closed", config, "acc-1", (k) => settingsStore[k] ?? null);
    expect(result).toBe("closed");
  });

  // ============================================================================
  // Account isolation: different accounts have different policies
  // ============================================================================

  it("policies are isolated per account", () => {
    const config = makeConfig({
      "acc-A": makeInstance({ dmPolicy: "closed" }),
      "acc-B": makeInstance({ dmPolicy: "pairing" }),
    });

    const resultA = resolvePolicy("dmPolicy", undefined, "open", config, "acc-A", (k) => settingsStore[k] ?? null);
    const resultB = resolvePolicy("dmPolicy", undefined, "open", config, "acc-B", (k) => settingsStore[k] ?? null);

    expect(resultA).toBe("closed");
    expect(resultB).toBe("pairing");
  });

  it("unknown account falls through to default", () => {
    const config = makeConfig({
      "acc-known": makeInstance({ dmPolicy: "closed" }),
    });

    const result = resolvePolicy("dmPolicy", undefined, "open", config, "acc-unknown", (k) => settingsStore[k] ?? null);
    expect(result).toBe("open");
  });
});
