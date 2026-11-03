import { describe, expect, test } from "bun:test";

import { resolveConsoleFeatureAccess } from "@/server/console/feature-access";

import { isKnowledgeEnabledForOrganization } from "./enabled";

function featureAccess(entitled: boolean) {
  return async (input: { organizationId: string; role: string }) =>
    resolveConsoleFeatureAccess({
      organizationId: input.organizationId,
      plan: "free",
      role: input.role,
      entitlements: entitled ? [{ key: "console.knowledge", startsAt: null, endsAt: null, valueJson: {} }] : [],
    });
}

describe("isKnowledgeEnabledForOrganization", () => {
  test("is false until the organization holds the console.knowledge entitlement", async () => {
    expect(await isKnowledgeEnabledForOrganization("org-1", { featureAccess: featureAccess(false) })).toBe(false);
    expect(await isKnowledgeEnabledForOrganization("org-1", { featureAccess: featureAccess(true) })).toBe(true);
  });

  test("checks at the org level (owner role)", async () => {
    let role = "";
    await isKnowledgeEnabledForOrganization("org-1", {
      featureAccess: async (input) => {
        role = input.role;
        return featureAccess(false)(input);
      },
    });
    expect(role).toBe("owner");
  });
});
