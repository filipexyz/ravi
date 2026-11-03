import { describe, expect, test } from "bun:test";

import type { CliAuthContext } from "@/server/cli/auth";
import type { ConsoleFeatureAccessData, ConsoleFeatureAccessItem } from "@/features/console/types";

import { buildInternalControlFeatures, buildInternalControlSummary } from "./internal-control";

describe("internal Console control payloads", () => {
  test("builds sanitized summary without token material or raw scopes", () => {
    const payload = buildInternalControlSummary({
      access: featureAccess(),
      auth: authContext(),
    });

    expect(payload).toMatchObject({
      app: { id: "console.internal_control", name: "Console Backoffice" },
      actor: {
        user: { email: "operator@ravi.bot" },
        organization: { slug: "ravi" },
        membership: { role: "owner" },
      },
      access: {
        internalControl: {
          key: "console.internal_control",
          enabled: true,
        },
      },
    });
    expect(payload.operations.implemented).toContain("GET /api/cli/internal/control/summary");

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("jti_123");
    expect(serialized).not.toContain("console.control.read");
  });

  test("builds a feature snapshot for the current organization", () => {
    const payload = buildInternalControlFeatures({
      access: featureAccess(),
      auth: authContext(),
    });

    expect(payload.organization).toEqual({
      id: "org_123",
      slug: "ravi",
      name: "Ravi",
      status: "active",
    });
    expect(payload.features.map((feature) => feature.key)).toEqual([
      "console.projects",
      "console.internal_control",
    ]);
  });
});

function authContext(): CliAuthContext {
  const now = new Date("2026-06-08T12:00:00.000Z");
  return {
    accessTokenJti: "jti_123",
    cliSession: {
      id: "session_123",
      expiresAt: now,
      lastUsedAt: now,
      status: "active",
    },
    localInstallation: {
      id: "installation_123",
      hostname: "dev.local",
      lastSeenAt: now,
      name: "local",
      platform: "darwin",
      raviVersion: "0.0.0-test",
      status: "active",
    },
    membership: {
      id: "membership_123",
      role: "owner",
      status: "active",
    },
    organization: {
      id: "org_123",
      name: "Ravi",
      slug: "ravi",
      status: "active",
    },
    scopes: ["console.me.read", "console.control.read"],
    user: {
      id: "user_123",
      avatarUrl: null,
      displayName: "Operator",
      primaryEmail: "operator@ravi.bot",
      status: "active",
    },
  };
}

function featureAccess(): ConsoleFeatureAccessData {
  const projects = feature({
    category: "core",
    key: "console.projects",
    label: "Projects",
    visible: true,
  });
  const internalControl = feature({
    category: "internal",
    key: "console.internal_control",
    label: "Internal control",
    source: "entitlement",
    visible: false,
  });

  return {
    byKey: {
      "console.projects": projects,
      "console.artifacts": projects,
      "console.knowledge": projects,
      "console.library": projects,
      "console.pages": projects,
      "console.pages.custom_domains": projects,
      "console.pages.chat": projects,
      "console.domains": projects,
      "console.mail": projects,
      "console.meetings": projects,
      "console.channels": projects,
      "console.runtime_runs": projects,
      "console.github": projects,
      "console.connectors": projects,
      "console.audit": projects,
      "console.feedback": projects,
      "console.bugs": projects,
      "console.bases": projects,
      "console.billing": projects,
      "console.settings": projects,
      "console.event_plane": projects,
      "console.managed_runtime": projects,
      "console.cloud_agents": projects,
      "console.internal_control": internalControl,
    },
    features: [projects, internalControl],
    organizationId: "org_123",
    plan: "internal",
    role: "owner",
  };
}

function feature(
  overrides: Pick<ConsoleFeatureAccessItem, "category" | "key" | "label" | "visible"> &
    Partial<ConsoleFeatureAccessItem>,
): ConsoleFeatureAccessItem {
  return {
    available: true,
    authorized: true,
    description: `${overrides.label} feature`,
    enabled: true,
    entitlementKey: overrides.key,
    plan: "internal",
    reason: "allowed",
    requestable: false,
    requiredRoles: ["owner"],
    source: "default",
    ...overrides,
  };
}
