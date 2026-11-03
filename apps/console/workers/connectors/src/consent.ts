/**
 * "The person asking" (phase 3): an agent uses each speaker's own account
 * once that person allowed it, per agent and installation.
 *
 * The first time an agent needs a person's account, agent exec creates a
 * consent request and answers with a Console link (`/connectors/consent/
 * <token>`) the agent sends that person privately. The token is 32 random
 * bytes (base64url); only its SHA-256 (standard base64, as for connect
 * tokens) is stored, so asking again issues a new token for the same
 * pending request (the old link stops working) and no token is ever
 * handed out twice. The person, signed in, approves (choosing the
 * account, or "my default") or denies, once. Approving creates the agent
 * grant, always given by that person, never by the operator on their
 * behalf. The person lists and revokes the grants they gave.
 */

import type { AgentGrantRow } from "./connection-views";
import { toAgentGrantRow } from "./connection-views";
import {
  findConsentRequestByTokenHash,
  findAgentGrantById,
  insertAuditEvent,
  isActiveOrganizationMember,
  listAgentGrants,
  listUserSelectableConnections,
  lockConsentRequest,
  revokeAgentGrant,
  settleConsentRequest,
  upsertPendingConsentRequest,
  upsertPersonAskingGrant,
  withTransaction,
  type ConnectorsDb,
  type ConsentRequestRecord,
} from "./db";
import { ConnectorHttpError } from "./errors";
import { generateRandomToken, sha256Base64 } from "./tokens";

export const CONSENT_REQUEST_TTL_SECONDS = 24 * 60 * 60;
// base64url, as `generateRandomToken` makes it; the Console checks the same shape.
const CONSENT_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const GRANTS_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ConsentView =
  | {
      state: "pending";
      provider: string;
      agentId: string;
      agentDisplayName: string | null;
      operatorName: string | null;
      operatorEmail: string | null;
      installationName: string | null;
      connections: { id: string; email: string | null; isDefault: boolean }[];
      expiresAt: string;
    }
  | { state: "expired" | "used" | "user_mismatch" | "invalid" };

/** What agent exec answers while the person has not allowed the agent yet. */
export interface ConsentRequiredDetails {
  consentRequestId: string;
  consentUrl: string;
  expiresAt: string;
}

export function consentUrl(consoleBaseUrl: string, token: string): string {
  return `${consoleBaseUrl.replace(/\/+$/, "")}/connectors/consent/${token}`;
}

// --------------------------------------------------------------------------
// Agent exec side
// --------------------------------------------------------------------------

export async function requestConsent(
  deps: { db: ConnectorsDb; consoleBaseUrl: string },
  input: {
    organizationId: string;
    localInstallationId: string;
    agentId: string;
    agentDisplayName: string | null;
    provider: string;
    contactId: string;
    bindingId: string;
    consoleUserId: string;
    requestedByUserId: string;
    requestId: string;
  },
): Promise<ConsentRequiredDetails> {
  const token = generateRandomToken(32);
  const request = await upsertPendingConsentRequest(deps.db, {
    tokenHash: await sha256Base64(token),
    organizationId: input.organizationId,
    localInstallationId: input.localInstallationId,
    agentId: input.agentId,
    agentDisplayName: input.agentDisplayName,
    provider: input.provider,
    contactId: input.contactId,
    bindingId: input.bindingId,
    consoleUserId: input.consoleUserId,
    requestedByUserId: input.requestedByUserId,
    ttlSeconds: CONSENT_REQUEST_TTL_SECONDS,
  });
  await insertAuditEvent(deps.db, {
    organizationId: input.organizationId,
    actorType: "cli",
    actorId: input.requestedByUserId,
    targetType: "connector_consent_request",
    targetId: request.id,
    action: request.created ? "connector.consent.requested" : "connector.consent.reissued",
    requestId: input.requestId,
    metadata: {
      provider: input.provider,
      agentId: input.agentId,
      installationId: input.localInstallationId,
      consoleUserId: input.consoleUserId,
    },
  });
  return {
    consentRequestId: request.id,
    consentUrl: consentUrl(deps.consoleBaseUrl, token),
    expiresAt: request.expiresAt.toISOString(),
  };
}

// --------------------------------------------------------------------------
// Console side (HMAC): the person the request was made for
// --------------------------------------------------------------------------

type Actor = { organizationId: string; userId: string };

/** What the consent page shows. Inert: resolving decides nothing. */
export async function resolveConsentRequest(
  deps: { db: ConnectorsDb },
  actor: Actor & { requestId: string },
  token: unknown,
): Promise<ConsentView> {
  const request = await findByToken(deps.db, token);
  if (!request) return { state: "invalid" };
  if (!isRequestFor(request, actor)) {
    await auditMismatch(deps.db, request, actor, "resolve");
    return { state: "user_mismatch" };
  }
  const ended = endedState(request);
  if (ended) return { state: ended };
  const connections = await listUserSelectableConnections(deps.db, {
    organizationId: request.organizationId,
    userId: request.consoleUserId,
    provider: request.provider,
  });
  return {
    state: "pending",
    provider: request.provider,
    agentId: request.agentId,
    agentDisplayName: request.agentDisplayName,
    operatorName: request.operatorName,
    operatorEmail: request.operatorEmail,
    installationName: request.installationName,
    connections: connections.map((row) => ({ id: row.id, email: row.externalAccountLogin, isDefault: row.isDefault })),
    expiresAt: request.expiresAt.toISOString(),
  };
}

/**
 * "Approve" (with the account the agent will use: one of the person's own
 * live connections, or none for "my default") or "Deny". Once: a decided
 * or expired request answers `connector_connect_unavailable` with its state.
 */
export async function decideConsentRequest(
  deps: { db: ConnectorsDb },
  actor: Actor & { requestId: string },
  input: { token: unknown; decision: unknown; connectionId: unknown },
): Promise<{ status: "approved" | "denied"; grantId?: string }> {
  if (input.decision !== "approve" && input.decision !== "deny") {
    throw new ConnectorHttpError(400, "payload_invalid", "decision must be approve or deny");
  }
  const decision = input.decision;
  const connectionId = input.connectionId === undefined || input.connectionId === null ? null : input.connectionId;
  if (connectionId !== null && (typeof connectionId !== "string" || !UUID_RE.test(connectionId))) {
    throw new ConnectorHttpError(400, "payload_invalid", "Invalid connectionId");
  }
  const found = await findByToken(deps.db, input.token);
  if (!found) throw new ConnectorHttpError(404, "not_found", "Consent request not found");
  if (!isRequestFor(found, actor)) {
    await auditMismatch(deps.db, found, actor, "decide");
    throw new ConnectorHttpError(403, "connector_forbidden", "This request is for someone else");
  }
  if (decision === "approve" && !(await isActiveOrganizationMember(deps.db, actor))) {
    throw new ConnectorHttpError(403, "connector_forbidden", "Not an active member of the organization");
  }

  const outcome = await withTransaction(deps.db, async (tx) => {
    const request = await lockConsentRequest(tx, found.id);
    if (!request) throw new ConnectorHttpError(404, "not_found", "Consent request not found");
    const ended = endedState(request);
    if (ended) {
      if (ended === "expired" && request.status === "pending") {
        await settleConsentRequest(tx, { id: request.id, status: "expired", grantId: null });
      }
      return { ended } as const;
    }
    if (decision === "deny") {
      await settleConsentRequest(tx, { id: request.id, status: "denied", grantId: null });
      return { status: "denied" as const, request };
    }
    // The account chosen is checked on its locked row: one of the person's
    // own connected accounts, which a concurrent disconnect cannot close
    // under the new grant.
    const grant = await upsertPersonAskingGrant(tx, {
      organizationId: request.organizationId,
      localInstallationId: request.localInstallationId,
      agentId: request.agentId,
      provider: request.provider,
      providerConnectionId: connectionId,
      grantedByUserId: request.consoleUserId,
    });
    if (grant.kind === "connection_unavailable") {
      throw new ConnectorHttpError(400, "payload_invalid", "Choose one of your own connected accounts");
    }
    await settleConsentRequest(tx, { id: request.id, status: "approved", grantId: grant.id });
    return { status: "approved" as const, grantId: grant.id, request };
  });

  if ("ended" in outcome) {
    throw new ConnectorHttpError(409, "connector_connect_unavailable", `Consent request ${outcome.ended}`, {
      state: outcome.ended,
    });
  }
  await insertAuditEvent(deps.db, {
    organizationId: outcome.request.organizationId,
    actorType: "user",
    actorId: actor.userId,
    targetType: "connector_consent_request",
    targetId: outcome.request.id,
    action: outcome.status === "approved" ? "connector.consent.approved" : "connector.consent.denied",
    requestId: actor.requestId,
    metadata: {
      provider: outcome.request.provider,
      agentId: outcome.request.agentId,
      installationId: outcome.request.localInstallationId,
      ...(outcome.status === "approved" ? { grantId: outcome.grantId, connectionId } : {}),
    },
  });
  return outcome.status === "approved" ? { status: "approved", grantId: outcome.grantId } : { status: "denied" };
}

/** The agents the person allowed to use their accounts when they ask. */
export async function listGivenGrants(deps: { db: ConnectorsDb }, actor: Actor): Promise<AgentGrantRow[]> {
  const rows = await listAgentGrants(deps.db, {
    organizationId: actor.organizationId,
    mode: "person_asking",
    grantedByUserId: actor.userId,
    limit: GRANTS_LIMIT,
  });
  return rows.map(toAgentGrantRow);
}

/** Only the person who gave a grant revokes it here. */
export async function revokeGivenGrant(
  deps: { db: ConnectorsDb },
  actor: Actor & { requestId: string },
  grantId: string,
): Promise<void> {
  const grant = UUID_RE.test(grantId)
    ? await findAgentGrantById(deps.db, { id: grantId, organizationId: actor.organizationId })
    : null;
  if (!grant || grant.mode !== "person_asking" || grant.grantedByUserId !== actor.userId) {
    throw new ConnectorHttpError(404, "not_found", "Grant not found");
  }
  if (!(await revokeAgentGrant(deps.db, grant.id))) return;
  await insertAuditEvent(deps.db, {
    organizationId: grant.organizationId,
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
    },
  });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function findByToken(db: ConnectorsDb, token: unknown): Promise<ConsentRequestRecord | null> {
  const value = typeof token === "string" ? token.trim() : "";
  if (!CONSENT_TOKEN_RE.test(value)) return null;
  // Standard base64 of the SHA-256, like the connect token's hash.
  return findConsentRequestByTokenHash(db, await sha256Base64(value));
}

function isRequestFor(request: ConsentRequestRecord, actor: Actor): boolean {
  return request.consoleUserId === actor.userId && request.organizationId === actor.organizationId;
}

/** Why a request can no longer be decided, or `null` while it can. */
function endedState(request: ConsentRequestRecord): "used" | "expired" | null {
  if (request.status === "approved" || request.status === "denied") return "used";
  if (request.status === "expired" || request.pastExpiry || !request.installationActive) return "expired";
  return null;
}

async function auditMismatch(
  db: ConnectorsDb,
  request: ConsentRequestRecord,
  actor: Actor & { requestId: string },
  step: "resolve" | "decide",
): Promise<void> {
  await insertAuditEvent(db, {
    organizationId: request.organizationId,
    actorType: "user",
    actorId: actor.userId,
    targetType: "connector_consent_request",
    targetId: request.id,
    action: "connector.consent.user_mismatch",
    requestId: actor.requestId,
    metadata: { step, provider: request.provider, sameOrganization: request.organizationId === actor.organizationId },
  });
}
