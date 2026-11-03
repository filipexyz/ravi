import { eq } from "drizzle-orm";

import type {
  ConsoleFeatureAccessData,
  ConsoleFeatureAccessItem,
  ConsoleFeatureAccessReason,
  ConsoleFeatureAccessSource,
  ConsoleFeatureCategory,
  ConsoleFeatureKey,
} from "@/features/console/types";
import type { ConsoleRole } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { pageChatEngineEnabled } from "./pages/chat/engine";
import { db, schema } from "@/server/db";
import { parseConsoleRole, type ConsoleWorkspace } from "./workspace";

type FeatureEntitlementRecord = {
  key: string;
  source?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  valueJson: Record<string, unknown>;
};

type ConsoleFeatureDefinition = {
  key: ConsoleFeatureKey;
  label: string;
  category: ConsoleFeatureCategory;
  description: string;
  roles: readonly ConsoleRole[];
  defaultAvailable?: boolean;
  entitlementRequired?: boolean;
  entitlementKey?: string;
  availablePlans?: readonly string[];
  requestable?: boolean;
  visible?: boolean;
};

export const CONSOLE_FEATURE_CATALOG = [
  {
    key: "console.projects",
    label: "Projects",
    category: "core",
    description: "Project inventory, membership context, and project creation.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.artifacts",
    label: "Artifacts",
    category: "core",
    description: "Artifact inventory, versions, and hosted content metadata.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.knowledge",
    label: "Knowledge",
    category: "core",
    description: "Governed sources, ingestion, retrieval, citations, and retrieval audit.",
    roles: ["owner", "admin", "developer", "viewer"],
    entitlementRequired: true,
    requestable: true,
  },
  {
    key: "console.library",
    label: "Library",
    category: "core",
    description: "Skills shared with the organization's agents, per organization or per project, versioned and searchable.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.pages",
    label: "Pages",
    category: "pages",
    description: "Ravi Pages sites, routes, releases, and publishing surfaces.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.pages.custom_domains",
    label: "Pages custom domains",
    category: "pages",
    description: "Customer hostnames bound to Ravi Pages sites.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.pages.chat",
    label: "Page Chat",
    category: "pages",
    description: "Voice agent in every Ravi Page that operates the site for the signed-in viewer, metered per organization.",
    roles: ["owner", "admin", "developer", "viewer"],
    entitlementRequired: true,
    requestable: true,
  },
  {
    key: "console.domains",
    label: "Domains",
    category: "pages",
    description: "Organization domain ownership claims and product bindings.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.mail",
    label: "Mail",
    category: "communication",
    description: "Ravi Mail domains, mailboxes, messages, and routing overview.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.meetings",
    label: "Meetings",
    category: "communication",
    description: "Cloud bot that joins Google Meet calls to record them for a local Ravi, metered per organization.",
    roles: ["owner", "admin", "developer"],
    entitlementRequired: true,
    requestable: true,
  },
  {
    key: "console.channels",
    label: "Channels",
    category: "communication",
    description: "Managed channel instances and connection health.",
    roles: ["owner", "admin"],
    defaultAvailable: true,
  },
  {
    key: "console.runtime_runs",
    label: "Runs",
    category: "operations",
    description: "Runtime traces, sessions, turns, events, and tool-call observability.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.github",
    label: "GitHub",
    category: "integrations",
    description: "Project GitHub App installation and repository selection.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.connectors",
    label: "Connectors",
    category: "integrations",
    description: "Project connector and MCP bridge surfaces.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.audit",
    label: "Audit",
    category: "operations",
    description: "Organization and project audit event visibility.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.feedback",
    label: "Feedback",
    category: "operations",
    description: "Structured product and operational feedback from Console, agents, and local CLI workflows.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.bugs",
    label: "Bug reports",
    category: "operations",
    description: "User-global defect reports with status tracking from Console and local CLI workflows.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.bases",
    label: "Bases",
    category: "core",
    description: "Typed project databases: a read-only inspector in the Console, API and CLI, and views as access contracts for agent-built Ravi Pages.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.billing",
    label: "Billing",
    category: "admin",
    description: "Billing account, usage, quotas, and commercial readiness.",
    roles: ["owner", "admin", "billing"],
    defaultAvailable: true,
  },
  {
    key: "console.settings",
    label: "Settings",
    category: "admin",
    description: "Organization and project settings surfaces.",
    roles: ["owner", "admin"],
    defaultAvailable: true,
  },
  {
    key: "console.event_plane",
    label: "Event Plane",
    category: "operations",
    description: "Provider-neutral Event Plane desired-state control records and reconciliation status.",
    roles: ["owner", "admin"],
    availablePlans: ["internal", "enterprise"],
    requestable: true,
  },
  {
    key: "console.cloud_agents",
    label: "Cloud agents",
    category: "operations",
    description: "Library agents run on Claude Managed Agents with the organization's own Anthropic key.",
    roles: ["owner", "admin", "developer", "viewer"],
    defaultAvailable: true,
  },
  {
    key: "console.managed_runtime",
    label: "Managed runtime",
    category: "operations",
    description: "Cloud-managed runtime placement and hosted execution controls.",
    roles: ["owner", "admin", "developer"],
    availablePlans: ["internal", "enterprise"],
    requestable: true,
  },
  {
    key: "console.internal_control",
    label: "Internal control",
    category: "internal",
    description: "Closed operator controls for Console support and platform operations.",
    roles: ["owner", "admin"],
    entitlementRequired: true,
    requestable: false,
    visible: false,
  },
] as const satisfies readonly ConsoleFeatureDefinition[];

type ResolveConsoleFeatureAccessInput = {
  organizationId: string;
  plan: string;
  role: string;
  entitlements?: readonly FeatureEntitlementRecord[];
  now?: Date;
};

export async function getConsoleFeatureAccess(workspace: ConsoleWorkspace): Promise<ConsoleFeatureAccessData> {
  return getConsoleFeatureAccessForOrganizationRole({
    organizationId: workspace.organization.id,
    role: workspace.membership.role,
  });
}

export async function getConsoleFeatureAccessForOrganizationRole(input: {
  organizationId: string;
  role: string;
}): Promise<ConsoleFeatureAccessData> {
  const [billing, entitlements] = await Promise.all([
    db
      .select({ planKey: schema.billingAccounts.planKey })
      .from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.organizationId, input.organizationId))
      .limit(1),
    db
      .select({
        key: schema.entitlements.key,
        source: schema.entitlements.source,
        startsAt: schema.entitlements.startsAt,
        endsAt: schema.entitlements.endsAt,
        valueJson: schema.entitlements.valueJson,
      })
      .from(schema.entitlements)
      .where(eq(schema.entitlements.organizationId, input.organizationId)),
  ]);

  return resolveConsoleFeatureAccess({
    organizationId: input.organizationId,
    plan: billing[0]?.planKey ?? "free",
    role: input.role,
    entitlements,
  });
}

export async function assertConsoleFeatureAccess(
  workspace: ConsoleWorkspace,
  featureKey: ConsoleFeatureKey,
): Promise<ConsoleFeatureAccessItem> {
  const access = await getConsoleFeatureAccess(workspace);
  const feature = access.byKey[featureKey];

  if (!feature.available) {
    throw new ConsoleApiError(403, { error: "feature_unavailable" });
  }

  if (!feature.authorized) {
    throw new ConsoleApiError(403, { error: "feature_forbidden" });
  }

  return feature;
}

/** Availability is not authority. Only migrated, independently policy-gated
 * consumers may use this instead of the legacy role-based feature gate. */
export async function assertConsoleFeatureAvailable(workspace: ConsoleWorkspace,
  featureKey: ConsoleFeatureKey): Promise<ConsoleFeatureAccessItem> {
  const feature = (await getConsoleFeatureAccess(workspace)).byKey[featureKey];
  if (!feature.available) throw new ConsoleApiError(403, { error: "feature_unavailable" });
  return feature;
}

export function resolveConsoleFeatureAccess({
  organizationId,
  plan,
  role,
  entitlements = [],
  now = new Date(),
}: ResolveConsoleFeatureAccessInput): ConsoleFeatureAccessData {
  const normalizedRole = parseConsoleRole(role) ?? "viewer";
  const features = CONSOLE_FEATURE_CATALOG.map((definition) =>
    resolveFeature({ definition, entitlements, now, plan, role: normalizedRole }),
  );

  return {
    organizationId,
    plan,
    role: normalizedRole,
    features,
    byKey: features.reduce(
      (acc, feature) => {
        acc[feature.key] = feature;
        return acc;
      },
      {} as Record<ConsoleFeatureKey, ConsoleFeatureAccessItem>,
    ),
  };
}

function resolveFeature({
  definition,
  entitlements,
  now,
  plan,
  role,
}: {
  definition: ConsoleFeatureDefinition;
  entitlements: readonly FeatureEntitlementRecord[];
  now: Date;
  plan: string;
  role: ConsoleRole;
}): ConsoleFeatureAccessItem {
  const entitlementKey = definition.entitlementKey ?? definition.key;
  const entitlement = activeEntitlement(entitlements, entitlementKey, now);
  const entitlementEnabled = entitlement ? entitlementEnabledValue(entitlement.valueJson) : null;

  let available: boolean;
  let source: ConsoleFeatureAccessSource;
  let availabilityReason: ConsoleFeatureAccessReason;

  if (entitlementEnabled === false) {
    available = false;
    source = "entitlement";
    availabilityReason = "entitlement_disabled";
  } else if (entitlementEnabled === true) {
    available = true;
    source = "entitlement";
    availabilityReason = "allowed";
  } else if (definition.entitlementRequired) {
    available = false;
    source = "disabled";
    availabilityReason = "entitlement_required";
  } else if (definition.availablePlans?.includes(plan)) {
    available = true;
    source = "plan";
    availabilityReason = "allowed";
  } else if (definition.defaultAvailable) {
    available = true;
    source = "default";
    availabilityReason = "allowed";
  } else {
    available = false;
    source = "disabled";
    availabilityReason = "plan_denied";
  }

  const authorized = definition.roles.includes(role);
  const installationDisabled = definition.key === "console.pages.chat" && !pageChatEngineEnabled();
  if (installationDisabled) {
    available = false;
    source = "disabled";
    availabilityReason = "entitlement_disabled";
  }
  const enabled = available && authorized;
  const reason = enabled ? "allowed" : available && !authorized ? "role_denied" : availabilityReason;

  return {
    key: definition.key,
    label: definition.label,
    category: definition.category,
    description: definition.description,
    available,
    authorized,
    enabled,
    visible: !installationDisabled && (definition.visible ?? true),
    source,
    reason,
    requiredRoles: [...definition.roles],
    entitlementKey,
    plan,
    requestable: !installationDisabled && (definition.requestable ?? false),
  };
}

function activeEntitlement(
  entitlements: readonly FeatureEntitlementRecord[],
  key: string,
  now: Date,
): FeatureEntitlementRecord | null {
  return entitlements.find((entitlement) => {
    if (entitlement.key !== key) return false;
    if (entitlement.startsAt && entitlement.startsAt > now) return false;
    if (entitlement.endsAt && entitlement.endsAt <= now) return false;
    return true;
  }) ?? null;
}

function entitlementEnabledValue(value: Record<string, unknown>): boolean {
  return value.enabled !== false;
}
