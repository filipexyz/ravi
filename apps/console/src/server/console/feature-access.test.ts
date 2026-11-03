import { describe, expect, test } from "bun:test";

import { resolveConsoleFeatureAccess } from "./feature-access";

const NOW = new Date("2026-06-08T12:00:00.000Z");

function resolve(input: Partial<Parameters<typeof resolveConsoleFeatureAccess>[0]> = {}) {
  return resolveConsoleFeatureAccess({
    organizationId: "org_feature_test",
    plan: "free",
    role: "owner",
    now: NOW,
    ...input,
  });
}

describe("Console feature access", () => {
  test("keeps internal control disabled by default even for owners", () => {
    const access = resolve();
    const feature = access.byKey["console.internal_control"];

    expect(feature.available).toBe(false);
    expect(feature.authorized).toBe(true);
    expect(feature.enabled).toBe(false);
    expect(feature.reason).toBe("entitlement_required");
  });

  test("does not expose console.bugs_ops as an organization feature", () => {
    const access = resolve();
    expect(access.byKey["console.bugs_ops" as keyof typeof access.byKey]).toBeUndefined();
    expect(access.features.some((feature) => feature.key === ("console.bugs_ops" as typeof feature.key))).toBe(false);
    expect(access.byKey["console.bugs"]).toMatchObject({
      available: true,
      authorized: true,
      enabled: true,
      reason: "allowed",
    });
  });

  test("makes Bases available to every plan and lets an entitlement turn it off", () => {
    for (const plan of ["free", "internal", "enterprise"]) {
      expect(resolve({ plan }).byKey["console.bases"]).toMatchObject({
        available: true,
        enabled: true,
        source: "default",
        reason: "allowed",
        requestable: false,
      });
    }
    expect(resolve({ role: "viewer" }).byKey["console.bases"].enabled).toBe(true);

    const disabled = resolve({
      entitlements: [{ key: "console.bases", startsAt: null, endsAt: null, valueJson: { enabled: false } }],
    });
    expect(disabled.byKey["console.bases"]).toMatchObject({
      available: false,
      enabled: false,
      source: "entitlement",
      reason: "entitlement_disabled",
    });
  });

  test("keeps Page Chat off until the organization holds its entitlement", () => {
    expect(resolve({ plan: "enterprise" }).byKey["console.pages.chat"]).toMatchObject({
      available: false,
      enabled: false,
      reason: "entitlement_required",
      requestable: true,
    });

    const enabled = resolve({
      role: "viewer",
      entitlements: [{ key: "console.pages.chat", startsAt: null, endsAt: null, valueJson: { enabled: true } }],
    });
    expect(enabled.byKey["console.pages.chat"]).toMatchObject({
      available: true,
      enabled: true,
      source: "entitlement",
    });
  });

  test("enables entitlement-required features with an active entitlement", () => {
    const access = resolve({
      entitlements: [
        {
          key: "console.internal_control",
          startsAt: new Date("2026-06-01T00:00:00.000Z"),
          endsAt: null,
          valueJson: {},
        },
      ],
    });

    expect(access.byKey["console.internal_control"]).toMatchObject({
      available: true,
      authorized: true,
      enabled: true,
      source: "entitlement",
      reason: "allowed",
    });
  });

  test("lets active disabled entitlements override default availability", () => {
    const access = resolve({
      entitlements: [
        {
          key: "console.pages",
          startsAt: null,
          endsAt: null,
          valueJson: { enabled: false },
        },
      ],
    });

    expect(access.byKey["console.pages"]).toMatchObject({
      available: false,
      authorized: true,
      enabled: false,
      source: "entitlement",
      reason: "entitlement_disabled",
    });
  });

  test("marks role-denied features unavailable to the current actor without removing organization availability", () => {
    const access = resolve({ role: "viewer" });

    expect(access.byKey["console.bugs"]).toMatchObject({
      available: true,
      authorized: true,
      enabled: true,
      reason: "allowed",
    });
    expect(access.byKey["console.library"]).toMatchObject({
      available: true,
      authorized: true,
      enabled: true,
      reason: "allowed",
    });
    expect(access.byKey["console.channels"]).toMatchObject({
      available: true,
      authorized: false,
      enabled: false,
      reason: "role_denied",
    });
  });

  test("requires an entitlement for Knowledge, on every plan, and lets an admin grant turn it on", () => {
    for (const plan of ["free", "internal", "enterprise"]) {
      expect(resolve({ plan }).byKey["console.knowledge"]).toMatchObject({
        available: false,
        authorized: true,
        enabled: false,
        reason: "entitlement_required",
        requestable: true,
      });
    }

    const granted = resolve({
      role: "viewer",
      entitlements: [{ key: "console.knowledge", startsAt: null, endsAt: null, valueJson: { enabled: true } }],
    });
    expect(granted.byKey["console.knowledge"]).toMatchObject({
      available: true,
      authorized: true,
      enabled: true,
      source: "entitlement",
    });
    expect(resolve({ role: "billing", entitlements: [{ key: "console.knowledge", startsAt: null, endsAt: null, valueJson: {} }] }).byKey["console.knowledge"].authorized).toBe(false);
  });

  test("ignores future and expired entitlements", () => {
    const future = resolve({
      entitlements: [
        {
          key: "console.internal_control",
          startsAt: new Date("2026-06-09T00:00:00.000Z"),
          endsAt: null,
          valueJson: {},
        },
      ],
    });
    const expired = resolve({
      entitlements: [
        {
          key: "console.internal_control",
          startsAt: null,
          endsAt: new Date("2026-06-07T00:00:00.000Z"),
          valueJson: {},
        },
      ],
    });

    expect(future.byKey["console.internal_control"].enabled).toBe(false);
    expect(expired.byKey["console.internal_control"].enabled).toBe(false);
  });
});
