/**
 * The owner's view and settings of one connection (Console drawer):
 * account, tools with their policies, who used it, recent activity, the
 * agents allowed to use it; and the owner's tool policy choice, never
 * looser than the organization's ceiling. An organization account is
 * viewed and set by its manager or an organization owner or admin.
 */

import { getCapability, listProviderCapabilities, type CapabilityDefinition } from "./capabilities/registry";
import { requireManagedConnection } from "./connection-lifecycle";
import {
  toActivityRow,
  toAgentGrantRow,
  toConnectionSummary,
  toToolRows,
  toUsageRow,
  type ConnectionDetail,
} from "./connection-views";
import {
  findDefaultOrNewestUserConnection,
  findOrgConnectorPolicy,
  findUserEmail,
  insertAuditEvent,
  listAgentGrants,
  listConnectionActivity,
  listConnectorToolPolicies,
  listUsageForConnections,
  upsertConnectorToolPolicy,
  type AgentGrantViewRecord,
  type ConnectorsDb,
  type ProviderConnectionRecord,
} from "./db";
import { ConnectorHttpError } from "./errors";
import { isLooserThan, isToolPolicy, toolPolicyCeiling } from "./tool-policy";

const ACTIVITY_LIMIT = 20;
const GRANTS_LIMIT = 100;

export interface ConnectionSettingsDeps {
  db: ConnectorsDb;
  writeScopesFor(provider: string): readonly string[];
}

export async function getConnectionDetail(
  deps: ConnectionSettingsDeps,
  input: { organizationId: string; userId: string; providerConnectionId: string },
): Promise<ConnectionDetail> {
  const { connection } = await requireManagedConnection(deps.db, input);
  const organizationAccount = connection.scopeKind === "organization";
  const [usage, userPolicies, orgPolicy, activity, grants, managerEmail] = await Promise.all([
    listUsageForConnections(deps.db, [connection.id]),
    listConnectorToolPolicies(deps.db, connection.id),
    findOrgConnectorPolicy(deps.db, { organizationId: connection.organizationId, provider: connection.provider }),
    listConnectionActivity(deps.db, {
      organizationId: connection.organizationId,
      providerConnectionId: connection.id,
      ownerUserId: organizationAccount ? null : input.userId,
      limit: ACTIVITY_LIMIT,
    }),
    listConnectionGrants(deps.db, connection),
    organizationAccount && connection.managedByUserId
      ? findUserEmail(deps.db, connection.managedByUserId)
      : Promise.resolve(null),
  ]);
  return {
    ...toConnectionSummary(connection, deps.writeScopesFor(connection.provider), usage),
    ...(organizationAccount
      ? { managedBy: connection.managedByUserId ? { userId: connection.managedByUserId, email: managerEmail } : null }
      : {}),
    tools: toToolRows(connection, {
      capabilities: listProviderCapabilities(connection.provider),
      orgPolicy,
      userPolicies,
    }),
    usage: usage.map(toUsageRow),
    activity: activity.map(toActivityRow),
    grants: grants.map(toAgentGrantRow),
  };
}

/**
 * The agents that use a connection: for a personal one, the grants its
 * owner gave that point at it, plus those that point at no account when
 * this is the one they use (the default, else the newest); for an
 * organization account, its shared grants.
 */
async function listConnectionGrants(
  db: ConnectorsDb,
  connection: ProviderConnectionRecord,
): Promise<AgentGrantViewRecord[]> {
  if (connection.scopeKind === "organization") {
    return listAgentGrants(db, {
      organizationId: connection.organizationId,
      mode: "shared",
      connectionIds: [connection.id],
      limit: GRANTS_LIMIT,
    });
  }
  if (!connection.userId) return [];
  const resolved = await findDefaultOrNewestUserConnection(db, {
    organizationId: connection.organizationId,
    userId: connection.userId,
    provider: connection.provider,
  });
  return listAgentGrants(db, {
    organizationId: connection.organizationId,
    mode: "person_asking",
    grantedByUserId: connection.userId,
    connectionIds: [connection.id],
    includeUnpinnedOf: resolved?.id === connection.id
      ? { userId: connection.userId, provider: connection.provider }
      : null,
    limit: GRANTS_LIMIT,
  });
}

/**
 * The owner's policy for one tool of their connection. A policy looser
 * than the organization allows (its ceiling, or writes not allowed) is
 * refused with `connector_policy_above_ceiling`.
 */
export async function setConnectionToolPolicy(
  deps: Pick<ConnectionSettingsDeps, "db">,
  input: {
    organizationId: string;
    userId: string;
    providerConnectionId: string;
    capability: unknown;
    policy: unknown;
    requestId: string;
  },
): Promise<void> {
  const { connection } = await requireManagedConnection(deps.db, input);
  const capability = providerCapability(connection.provider, input.capability);
  if (!isToolPolicy(input.policy)) {
    throw new ConnectorHttpError(400, "payload_invalid", "policy must be always_allow, needs_approval or blocked");
  }
  const policy = input.policy;
  const orgPolicy = await findOrgConnectorPolicy(deps.db, {
    organizationId: connection.organizationId,
    provider: connection.provider,
  });
  const ceiling = toolPolicyCeiling({
    capabilityClass: capability.class,
    ceiling: orgPolicy.toolCeilingsJson?.[capability.id],
    writesAllowed: orgPolicy.writesAllowed,
  });
  if (isLooserThan(policy, ceiling)) {
    throw new ConnectorHttpError(409, "connector_policy_above_ceiling", "The organization does not allow this", {
      ceiling,
    });
  }
  await upsertConnectorToolPolicy(deps.db, {
    providerConnectionId: connection.id,
    organizationId: connection.organizationId,
    capability: capability.id,
    policy,
    updatedByUserId: input.userId,
  });
  await insertAuditEvent(deps.db, {
    organizationId: connection.organizationId,
    actorType: "user",
    actorId: input.userId,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "connector.tool_policy.set",
    requestId: input.requestId,
    metadata: { provider: connection.provider, capability: capability.id, policy },
  });
}

/** A capability of `provider`, or `payload_invalid`. */
export function providerCapability(provider: string, value: unknown): CapabilityDefinition {
  let capability: CapabilityDefinition | null = null;
  if (typeof value === "string") {
    try {
      capability = getCapability(value);
    } catch {
      capability = null;
    }
  }
  if (!capability || capability.providerId !== provider) {
    throw new ConnectorHttpError(400, "payload_invalid", "Unknown capability for this provider");
  }
  return capability;
}
