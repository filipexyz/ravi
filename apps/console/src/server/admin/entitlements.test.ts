import { describe, expect, test } from "bun:test";

import {
  ADMIN_GRANTABLE_FEATURE_KEYS,
  parseAdminEntitlementGrantBody,
} from "./entitlements";

describe("admin entitlement grants", () => {
  test("allows only explicitly supported bootstrap feature keys", () => {
    expect(ADMIN_GRANTABLE_FEATURE_KEYS).toEqual([
      "console.internal_control",
      "console.managed_runtime",
      "console.knowledge",
    ]);

    expect(
      parseAdminEntitlementGrantBody({
        featureKey: "console.knowledge",
        organizationRef: "acme",
        reason: "ravi doctor clean on 2026-10-17",
      }),
    ).toEqual({
      enabled: true,
      featureKey: "console.knowledge",
      organizationRef: "acme",
      reason: "ravi doctor clean on 2026-10-17",
    });

    expect(
      parseAdminEntitlementGrantBody({
        enabled: true,
        featureKey: "console.managed_runtime",
        organizationRef: "rbbt",
        reason: "Managed Ravi production readiness canary",
      }),
    ).toEqual({
      enabled: true,
      featureKey: "console.managed_runtime",
      organizationRef: "rbbt",
      reason: "Managed Ravi production readiness canary",
    });

    expect(() =>
      parseAdminEntitlementGrantBody({
        enabled: true,
        featureKey: "console.bugs_ops",
        organizationRef: "rbbt",
        reason: "Platform bug-ops inbox",
      }),
    ).toThrow("invalid_body");

    expect(() =>
      parseAdminEntitlementGrantBody({
        enabled: true,
        featureKey: "console.pages",
        organizationRef: "rbbt",
        reason: "Unsupported bootstrap grant",
      }),
    ).toThrow("invalid_body");

    expect(() =>
      parseAdminEntitlementGrantBody({
        enabled: true,
        featureKey: "console.bugs",
        organizationRef: "rbbt",
        reason: "Reporter feature is not a bootstrap grant",
      }),
    ).toThrow("invalid_body");
  });

  test("defaults enabled while requiring an operator-visible reason", () => {
    expect(
      parseAdminEntitlementGrantBody({
        featureKey: "console.internal_control",
        organizationRef: "rbbt",
        reason: "Internal operator bootstrap",
      }).enabled,
    ).toBe(true);

    expect(() =>
      parseAdminEntitlementGrantBody({
        featureKey: "console.managed_runtime",
        organizationRef: "rbbt",
        reason: "no",
      }),
    ).toThrow("invalid_body");
  });
});
