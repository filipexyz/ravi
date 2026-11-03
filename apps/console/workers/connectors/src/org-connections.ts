/**
 * Organization accounts (phase 4): a Google account of the organization,
 * connected by an owner or admin, managed by one member (who decides its
 * approvals), and shared with chosen agents on chosen installations, only
 * in the conversations named.
 *
 * Its row has no user (`user_id` NULL), so the vault binds its
 * credentials to no person: "Change owner" moves `managed_by_user_id` and
 * never re-encrypts anything. Owners and admins list every account and
 * change their manager; a manager lists the accounts they manage. Owners,
 * admins and the account's manager give and revoke shared grants, which
 * are always given in the manager's name (they belong to the account:
 * "Change owner" moves them to the new manager).
 */

import { toAgentGrantRow, toOrgConnectionSummary, type AgentGrantRow, type ConnectionSummary } from "./connection-views";
import {
  findActiveInstallation,
  findAgentGrantById,
  findProviderConnectionById,
  insertAuditEvent,
  isActiveOrganizationAdmin,
  isActiveOrganizationMember,
  isLiveConnectionStatus,
  listAgentGrants,
  listOrganizationAccounts,
  listUsageForConnections,
  revokeAgentGrant,
  setOrgConnectionManager,
  upsertSharedAgentGrant,
  type ConnectorsDb,
  type ProviderConnectionRecord,
} from "./db";
import { ConnectorHttpError } from "./errors";
import { isOrganizationAdmin } from "./org-admin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Same shape as `ravi agents list` ids (`main`, `support-bot`).
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SHARED_CONVERSATIONS = new Set(["dm", "group"]);
const GRANTS_LIMIT = 500;

type Actor = { organizationId: string; userId: string };

/**
 * Every organization account for an owner or admin (the role the Console
 * sent and the membership row); for any other active member, only the
 * accounts they manage, so a manager without an admin role finds the
 * account whose approvals, tools and reconnect are theirs.
 */
export async function listOrgAccounts(
  deps: { db: ConnectorsDb; writeScopesFor(provider: string): readonly string[] },
  input: Actor & { claimedRole: unknown; provider: unknown; includeHistory: boolean },
): Promise<ConnectionSummary[]> {
  const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : null;
  const admin = await isOrganizationAdmin(deps.db, input, input.claimedRole);
  if (!admin && !(await isActiveOrganizationMember(deps.db, input))) {
    throw new ConnectorHttpError(403, "connector_forbidden", "Organization members only");
  }
  const rows = await listOrganizationAccounts(deps.db, {
    organizationId: input.organizationId,
    provider,
    includeHistory: input.includeHistory,
    managedByUserId: admin ? null : input.userId,
  });
  const usage = await listUsageForConnections(deps.db, rows.map((row) => row.id));
  return rows.map((row) => toOrgConnectionSummary(row, deps.writeScopesFor(row.provider), usage));
}

/** "Change owner": the new manager must be an active member. Owners and admins only (the router checks). */
export async function changeOrgAccountManager(
  deps: { db: ConnectorsDb },
  actor: Actor & { requestId: string },
  input: { connectionId: string; managedByUserId: unknown },
): Promise<void> {
  const managedByUserId = typeof input.managedByUserId === "string" ? input.managedByUserId.trim() : "";
  if (!UUID_RE.test(managedByUserId)) {
    throw new ConnectorHttpError(400, "payload_invalid", "managedByUserId must be a member id");
  }
  const connection = await requireOrgAccount(deps.db, actor.organizationId, input.connectionId);
  if (!isLiveConnectionStatus(connection.status)) {
    throw new ConnectorHttpError(400, "payload_invalid", "This account is disconnected");
  }
  if (!(await isActiveOrganizationMember(deps.db, { organizationId: actor.organizationId, userId: managedByUserId }))) {
    throw new ConnectorHttpError(400, "payload_invalid", "The new owner must be an active member");
  }
  const changed = await setOrgConnectionManager(deps.db, {
    id: connection.id,
    organizationId: actor.organizationId,
    managedByUserId,
  });
  if (!changed) throw new ConnectorHttpError(404, "not_found", "Connection not found");
  await insertAuditEvent(deps.db, {
    organizationId: actor.organizationId,
    actorType: "user",
    actorId: actor.userId,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "connector.org_connection.manager_changed",
    requestId: actor.requestId,
    metadata: {
      provider: connection.provider,
      previousManagerUserId: changed.previousManagerUserId,
      managedByUserId,
      expiredApprovals: changed.expiredApprovals,
      movedGrants: changed.movedGrants,
    },
  });
}

/**
 * Let one agent on one installation of the organization use an
 * organization account in the conversations named (a subset of dm and
 * group). An agent uses one organization account per provider: its grant
 * on another account is replaced only when the actor may revoke that one
 * too, and each replaced grant is audited as revoked.
 */
export async function grantSharedAccount(
  deps: { db: ConnectorsDb },
  actor: Actor & { requestId: string },
  body: Record<string, unknown>,
): Promise<{ grantId: string }> {
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const installationId = typeof body.installationId === "string" ? body.installationId : "";
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!UUID_RE.test(connectionId) || !UUID_RE.test(installationId)) {
    throw new ConnectorHttpError(400, "payload_invalid", "connectionId and installationId must be ids");
  }
  if (!AGENT_ID_RE.test(agentId)) throw new ConnectorHttpError(400, "payload_invalid", "Invalid agentId");
  const conversations = parseConversations(body.conversations);

  const connection = await requireOrgAccount(deps.db, actor.organizationId, connectionId);
  const actorIsAdmin = await requireAccountManagerOrAdmin(deps.db, actor, connection);
  if (connection.status !== "active") {
    throw new ConnectorHttpError(400, "payload_invalid", "Only a connected account can be shared");
  }
  const installation = await findActiveInstallation(deps.db, { id: installationId, organizationId: actor.organizationId });
  if (!installation) throw new ConnectorHttpError(400, "payload_invalid", "Unknown or revoked installation");

  // Checked again on the locked rows: the account still connected and
  // still the actor's to share, the agent's other grant theirs to replace.
  const grant = await upsertSharedAgentGrant(deps.db, {
    organizationId: actor.organizationId,
    localInstallationId: installation.id,
    agentId,
    provider: connection.provider,
    providerConnectionId: connection.id,
    conversations,
    actorUserId: actor.userId,
    actorIsAdmin,
  });
  if (grant.kind === "connection_unavailable") {
    throw new ConnectorHttpError(400, "payload_invalid", "Only a connected account can be shared");
  }
  if (grant.kind === "forbidden") {
    throw new ConnectorHttpError(403, "connector_forbidden", "The account's manager, owners and admins only");
  }
  if (grant.kind === "agent_uses_other_account") {
    throw new ConnectorHttpError(
      403,
      "connector_forbidden",
      "This agent uses another organization account; its manager or an admin must revoke that first",
      { reason: "agent_uses_other_account" },
    );
  }
  await insertAuditEvent(deps.db, {
    organizationId: actor.organizationId,
    actorType: "user",
    actorId: actor.userId,
    targetType: "agent_connector_grant",
    targetId: grant.id,
    action: "connector.agent_grant.shared",
    requestId: actor.requestId,
    metadata: {
      providerConnectionId: connection.id,
      provider: connection.provider,
      agentId,
      installationId: installation.id,
      conversations,
      created: grant.created,
      grantedByUserId: grant.grantedByUserId,
      ...(grant.replaced.length > 0 ? { replacedGrantIds: grant.replaced.map((row) => row.id) } : {}),
    },
  });
  for (const replaced of grant.replaced) {
    await insertAuditEvent(deps.db, {
      organizationId: actor.organizationId,
      actorType: "user",
      actorId: actor.userId,
      targetType: "agent_connector_grant",
      targetId: replaced.id,
      action: "connector.agent_grant.revoked",
      requestId: actor.requestId,
      metadata: {
        mode: replaced.mode,
        provider: replaced.provider,
        agentId: replaced.agentId,
        installationId: replaced.localInstallationId,
        providerConnectionId: replaced.providerConnectionId,
        reason: "replaced",
        replacedByGrantId: grant.id,
      },
    });
  }
  return { grantId: grant.id };
}

export async function revokeSharedAccountGrant(
  deps: { db: ConnectorsDb },
  actor: Actor & { requestId: string },
  grantId: string,
): Promise<void> {
  const grant = UUID_RE.test(grantId)
    ? await findAgentGrantById(deps.db, { id: grantId, organizationId: actor.organizationId })
    : null;
  if (!grant || grant.mode !== "shared") throw new ConnectorHttpError(404, "not_found", "Grant not found");
  const connection = grant.providerConnectionId
    ? await findProviderConnectionById(deps.db, grant.providerConnectionId, actor.organizationId)
    : null;
  if (!(await isActiveOrganizationAdmin(deps.db, actor))) {
    if (!connection || connection.managedByUserId !== actor.userId) {
      throw new ConnectorHttpError(404, "not_found", "Grant not found");
    }
  }
  if (!(await revokeAgentGrant(deps.db, grant.id))) return;
  await insertAuditEvent(deps.db, {
    organizationId: actor.organizationId,
    actorType: "user",
    actorId: actor.userId,
    targetType: "agent_connector_grant",
    targetId: grant.id,
    action: "connector.agent_grant.revoked",
    requestId: actor.requestId,
    metadata: {
      mode: grant.mode,
      provider: grant.provider,
      agentId: grant.agentId,
      installationId: grant.localInstallationId,
      providerConnectionId: grant.providerConnectionId,
    },
  });
}

/** Shared grants: every one for owners and admins, those of the accounts they manage for a manager. */
export async function listSharedAccountGrants(
  deps: { db: ConnectorsDb },
  actor: Actor,
  input: { connectionId: unknown },
): Promise<AgentGrantRow[]> {
  const connectionId = input.connectionId === undefined || input.connectionId === null ? null : input.connectionId;
  if (connectionId !== null && (typeof connectionId !== "string" || !UUID_RE.test(connectionId))) {
    throw new ConnectorHttpError(400, "payload_invalid", "Invalid connectionId");
  }
  const admin = await isActiveOrganizationAdmin(deps.db, actor);
  if (!admin && !(await isActiveOrganizationMember(deps.db, actor))) {
    throw new ConnectorHttpError(403, "connector_forbidden", "Organization members only");
  }
  const rows = await listAgentGrants(deps.db, {
    organizationId: actor.organizationId,
    mode: "shared",
    connectionIds: connectionId ? [connectionId] : null,
    managedByUserId: admin ? null : actor.userId,
    limit: GRANTS_LIMIT,
  });
  return rows.map(toAgentGrantRow);
}

async function requireOrgAccount(
  db: ConnectorsDb,
  organizationId: string,
  connectionId: string,
): Promise<ProviderConnectionRecord> {
  const connection = UUID_RE.test(connectionId)
    ? await findProviderConnectionById(db, connectionId, organizationId)
    : null;
  if (!connection || connection.scopeKind !== "organization" || connection.provider === "github") {
    throw new ConnectorHttpError(404, "not_found", "Connection not found");
  }
  return connection;
}

/** The account's manager or an organization owner or admin; returns whether the actor is an owner or admin. */
async function requireAccountManagerOrAdmin(
  db: ConnectorsDb,
  actor: Actor,
  connection: ProviderConnectionRecord,
): Promise<boolean> {
  if (await isActiveOrganizationAdmin(db, actor)) return true;
  if (connection.managedByUserId === actor.userId && (await isActiveOrganizationMember(db, actor))) return false;
  throw new ConnectorHttpError(403, "connector_forbidden", "The account's manager, owners and admins only");
}

function parseConversations(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConnectorHttpError(400, "payload_invalid", "conversations must list dm and/or group");
  }
  const unique = [...new Set(value)];
  if (!unique.every((item) => typeof item === "string" && SHARED_CONVERSATIONS.has(item))) {
    throw new ConnectorHttpError(400, "payload_invalid", "conversations must list dm and/or group");
  }
  return (unique as string[]).sort();
}
