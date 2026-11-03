/**
 * Organization owners and admins: the connector policy of the
 * organization (enabled, writes allowed, tool ceilings) and every member's
 * connections, which they may disconnect.
 *
 * The Console sends the member's role with the signed identity; the
 * Worker requires `owner` or `admin` there and in the membership row.
 */

import { listProviderCapabilities } from "./capabilities/registry";
import { providerCapability } from "./connection-settings";
import { toAdminConnectionRow, toOrgPolicyView, type AdminConnectionRow, type OrgPolicyView } from "./connection-views";
import {
  findActiveMemberRole,
  findOrgConnectorPolicy,
  insertAuditEvent,
  listOrganizationConnections,
  upsertOrgConnectorPolicy,
  type ConnectorsDb,
} from "./db";
import { ConnectorHttpError } from "./errors";
import { isToolPolicy, type ToolPolicy } from "./tool-policy";

const ADMIN_ROLES = new Set(["owner", "admin"]);
const ADMIN_CONNECTIONS_LIMIT = 500;

/** An owner or admin: in the role the Console sent and in the membership row. */
export async function isOrganizationAdmin(
  db: ConnectorsDb,
  actor: { organizationId: string; userId: string },
  claimedRole: unknown,
): Promise<boolean> {
  if (typeof claimedRole !== "string" || !ADMIN_ROLES.has(claimedRole)) return false;
  const role = await findActiveMemberRole(db, actor);
  return Boolean(role && ADMIN_ROLES.has(role));
}

export async function requireOrganizationAdmin(
  db: ConnectorsDb,
  actor: { organizationId: string; userId: string },
  claimedRole: unknown,
): Promise<void> {
  if (!(await isOrganizationAdmin(db, actor, claimedRole))) {
    throw new ConnectorHttpError(403, "connector_forbidden", "Organization owners and admins only");
  }
}

export async function getOrgPolicy(
  db: ConnectorsDb,
  input: { organizationId: string; provider: unknown },
): Promise<OrgPolicyView> {
  const provider = requireConnectorProvider(input.provider);
  const policy = await findOrgConnectorPolicy(db, { organizationId: input.organizationId, provider });
  return toOrgPolicyView(policy, listProviderCapabilities(provider));
}

export async function setOrgPolicy(
  db: ConnectorsDb,
  input: {
    organizationId: string;
    userId: string;
    body: Record<string, unknown>;
    requestId: string;
  },
): Promise<OrgPolicyView> {
  const { body } = input;
  const provider = requireConnectorProvider(body.provider);
  const enabled = optionalBoolean(body.enabled, "enabled");
  const writesAllowed = optionalBoolean(body.writesAllowed, "writesAllowed");
  const sharedAllowed = optionalBoolean(body.sharedAllowed, "sharedAllowed");
  const toolCeilings = body.toolCeilings === undefined ? undefined : parseToolCeilings(provider, body.toolCeilings);

  const policy = await upsertOrgConnectorPolicy(db, {
    organizationId: input.organizationId,
    provider,
    enabled,
    writesAllowed,
    sharedAllowed,
    toolCeilings,
    updatedByUserId: input.userId,
  });
  await insertAuditEvent(db, {
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.userId,
    targetType: "connector_org_policy",
    targetId: provider,
    action: "connector.org_policy.updated",
    requestId: input.requestId,
    metadata: {
      provider,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(writesAllowed !== undefined ? { writesAllowed } : {}),
      ...(sharedAllowed !== undefined ? { sharedAllowed } : {}),
      ...(toolCeilings !== undefined ? { toolCeilings } : {}),
    },
  });
  return toOrgPolicyView(policy, listProviderCapabilities(provider));
}

export async function listAdminConnections(
  db: ConnectorsDb,
  input: { organizationId: string; provider: unknown },
): Promise<AdminConnectionRow[]> {
  const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : null;
  const rows = await listOrganizationConnections(db, {
    organizationId: input.organizationId,
    provider,
    limit: ADMIN_CONNECTIONS_LIMIT,
  });
  return rows.map(toAdminConnectionRow);
}

/** A provider the Worker has tools for (never GitHub). */
function requireConnectorProvider(value: unknown): string {
  const provider = typeof value === "string" ? value.trim() : "";
  if (!provider || listProviderCapabilities(provider).length === 0) {
    throw new ConnectorHttpError(400, "payload_invalid", "Unknown provider");
  }
  return provider;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ConnectorHttpError(400, "payload_invalid", `${field} must be a boolean`);
  return value;
}

/** `{ [capability]: policy }` with only capabilities of `provider`. */
function parseToolCeilings(provider: string, value: unknown): Record<string, ToolPolicy> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorHttpError(400, "payload_invalid", "toolCeilings must be an object");
  }
  const ceilings: Record<string, ToolPolicy> = {};
  for (const [capability, policy] of Object.entries(value as Record<string, unknown>)) {
    providerCapability(provider, capability);
    if (!isToolPolicy(policy)) {
      throw new ConnectorHttpError(400, "payload_invalid", "toolCeilings values must be tool policies");
    }
    ceilings[capability] = policy;
  }
  return ceilings;
}
