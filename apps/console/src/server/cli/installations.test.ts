import { describe, expect, test } from "bun:test";

import {
  BOOTSTRAP_TOKEN_TTL_MS,
  canonicalDesiredJson,
  generateBootstrapToken,
  hashDesiredInstallation,
  parseBootstrapMetadata,
  reportedInstallationStateSchema,
} from "./installations";

describe("installation bootstrap tokens", () => {
  test("generates prefixed, high-entropy, unique tokens", () => {
    const first = generateBootstrapToken();
    const second = generateBootstrapToken();

    expect(first.startsWith("ravi_bst_")).toBe(true);
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan("ravi_bst_".length + 32);
  });

  test("expires bootstrap tokens after fifteen minutes", () => {
    expect(BOOTSTRAP_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
  });

  test("accepts only bounded installation metadata", () => {
    expect(
      parseBootstrapMetadata({
        name: "cliente-acme",
        hostname: "acme-vm",
        platform: "linux-x64",
        raviVersion: "3.270101.1",
        machineFingerprint: "machine-key",
      }),
    ).toEqual({
      name: "cliente-acme",
      hostname: "acme-vm",
      platform: "linux-x64",
      raviVersion: "3.270101.1",
      machineFingerprint: "machine-key",
    });

    expect(() => parseBootstrapMetadata({ token: "ravi_bst_leak" })).toThrow();
    expect(() => parseBootstrapMetadata({ name: "x".repeat(121) })).toThrow();
  });
});

describe("desired installation hashing", () => {
  test("is stable across object key order", () => {
    const a = { runtime: { provider: "claude", model: "sonnet" }, channels: {} };
    const b = { channels: {}, runtime: { model: "sonnet", provider: "claude" } };

    expect(hashDesiredInstallation(a)).toBe(hashDesiredInstallation(b));
    expect(hashDesiredInstallation(a).startsWith("sha256:")).toBe(true);
  });

  // Contract vector: the OSS reconciler must reproduce this exact digest.
  // Keys are ordered by Unicode code point (`A` < `_` < `a`), not by locale,
  // so the same manifest hashes the same in every environment.
  test("matches the pinned canonical vector", () => {
    const manifest = {
      channels: { slack: { enabled: true }, "Slack-Alerts": { enabled: false } },
      runtime: { provider: "claude", model: "sonnet" },
      version: 1,
      _notes: ["b", "a"],
      a: 1,
      A: 2,
    };

    expect(hashDesiredInstallation(manifest)).toBe(
      "sha256:5c39eb28ed0460c3ae11fa469219febf785bc0e61b211f92b2587ce0dde21ed2",
    );
  });

  test("orders keys by code point instead of locale collation", () => {
    const reversed = { "-y": 4, a: 3, _x: 2, A: 1 };

    expect(canonicalDesiredJson(reversed)).toBe('{"-y":4,"A":1,"_x":2,"a":3}');
  });

  test("preserves array order and detects value changes", () => {
    expect(hashDesiredInstallation({ routes: ["a", "b"] })).not.toBe(
      hashDesiredInstallation({ routes: ["b", "a"] }),
    );
    expect(hashDesiredInstallation({ version: 1 })).not.toBe(
      hashDesiredInstallation({ version: 2 }),
    );
  });
});

describe("reported installation state", () => {
  test("accepts a derived summary without content", () => {
    const parsed = reportedInstallationStateSchema.safeParse({
      state: "healthy",
      raviVersion: "3.270101.1",
      appliedHash: "sha256:abc",
      desiredVersion: 2,
      drift: [{ resource: "config", key: "channels.slack", field: "enabled" }],
      doctor: { checks: [{ id: "nats_reachable", ok: true }] },
      gates: [{ id: "slack_installed", state: "blocked", requires: "human" }],
      instances: 1,
      channels: 1,
    });

    expect(parsed.success).toBe(true);
  });

  test("rejects Console-owned states", () => {
    for (const state of ["requested", "live", "revoked", "decommissioned"]) {
      expect(reportedInstallationStateSchema.safeParse({ state }).success).toBe(false);
    }
  });

  test("rejects message content, logs, secrets, and unknown fields", () => {
    expect(
      reportedInstallationStateSchema.safeParse({
        state: "healthy",
        message: "customer asked to reset the password",
      }).success,
    ).toBe(false);
    expect(
      reportedInstallationStateSchema.safeParse({
        state: "healthy",
        logs: ["provider token sk-ant-…"],
      }).success,
    ).toBe(false);
    expect(
      reportedInstallationStateSchema.safeParse({
        state: "healthy",
        doctor: { checks: [{ id: "x", ok: true }], raw: "…" },
      }).success,
    ).toBe(false);
  });

  test("rejects out-of-bounds summaries", () => {
    expect(
      reportedInstallationStateSchema.safeParse({
        state: "healthy",
        drift: Array.from({ length: 201 }, (_, index) => ({
          resource: "config",
          key: `key-${index}`,
          field: "enabled",
        })),
      }).success,
    ).toBe(false);
    expect(reportedInstallationStateSchema.safeParse({ state: "healthy", instances: -1 }).success).toBe(
      false,
    );
  });
});
