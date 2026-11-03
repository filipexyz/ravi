/**
 * Identity-bound connect flow for the connectors Worker.
 *
 *   start     → pending grant bound to (organization, user); returns the
 *               Console connect page URL `/connect/<connectToken>`.
 *   resolve   → what the Console connect page shows the signed-in user.
 *   continue  → the initiator clicked "Continue to Google": state + PKCE
 *               are generated now and the provider URL is returned.
 *   callback  → the provider redirect: the authorization code is stored
 *               encrypted and the browser goes to the Console finish page
 *               with a one-time result token.
 *   finish    → the Console finish page, signed in as the initiator,
 *               claims the grant; the code is exchanged here and the
 *               account is upserted by its provider `sub`.
 *
 * Whoever opens a link can never attach their own provider account to
 * someone else: resolve/continue/finish all require the initiator, and a
 * finish by anyone else rejects the grant and discards the code.
 *
 * An organization account (`scopeKind: "organization"`, phase 4) is
 * started only by an organization owner or admin while the organization
 * allows shared accounts; both are checked again at every later step. It
 * is upserted by (organization, provider, sub) with no user and the
 * initiator as its manager.
 *
 * This module does NOT validate the CLI bearer or HMAC header; that
 * happens at the router layer before these functions are called.
 */

import type { ConnectorAdapter, ProviderTokenBundle } from "./adapters/adapter";
import { applyAccountIdentity, backfillUserAccountIdentities } from "./account-identity";
import {
  authorizePendingGrant,
  claimAuthorizedPendingGrant,
  completePendingGrant,
  connectionAccountSub,
  continuePendingGrant,
  expirePendingGrant,
  failClaimedPendingGrant,
  findCredentialsByConnection,
  findInstallationName,
  findOrgConnectorPolicy,
  findPendingGrant,
  findPendingGrantByConnectTokenHash,
  findPendingGrantByStateTokenHash,
  findProviderConnectionById,
  findReconnectableOrgConnectionsForAccount,
  findReconnectableUserConnectionsForAccount,
  insertAuditEvent,
  insertPendingGrant,
  insertProviderConnection,
  isActiveOrganizationAdmin,
  isActiveOrganizationMember,
  isReconnectableConnectionStatus,
  isStaleClaim,
  isUniqueViolation,
  lockConnectorAccount,
  lockOrganizationMember,
  lockProviderConnection,
  refreshConnectionAfterConnect,
  rejectPendingGrant,
  setOrgConnectionManager,
  withTransaction,
  type ConnectorGrantPendingRecord,
  type ConnectorsDb,
  type OrgManagerChange,
  type ProviderConnectionRecord,
} from "./db";
import { ConnectorHttpError } from "./errors";
import { requireOrganizationAdmin } from "./org-admin";
import { decodeIdTokenClaims, sameAccount, type AccountIdentity } from "./identity";
import {
  computeRequestedScopes,
  connectionAccessMode,
  scopesToStore,
  type ConnectorAccessMode,
} from "./scopes";
import {
  generateRandomToken,
  pkceS256Challenge,
  sha256Base64,
  timingSafeEqualString,
} from "./tokens";
import { decryptBundle, encryptBundle, pendingSecretAad, storeConnectionTokens } from "./vault";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LENGTH = 256;
const FINISH_WAIT_ATTEMPTS = 20;
const FINISH_WAIT_MS = 250;

export interface OAuthRuntimeDeps {
  db: ConnectorsDb;
  rootWrapKey: CryptoKey;
  dekKeyVersion: number;
  adapters: Map<string, ConnectorAdapter>;
  redirectBaseUrl: string;            // e.g. "https://link.ravi.so"
  consoleBaseUrl: string;             // e.g. "https://console.ravi.bot"
  pendingGrantTtlSeconds: number;
  sleep?: (ms: number) => Promise<void>;
}

// --------------------------------------------------------------------------
// Shared view types (Console consumes them)
// --------------------------------------------------------------------------

export type ConnectResolveView =
  | {
      state: "pending";
      provider: string;
      accessMode: ConnectorAccessMode;
      origin: "cli" | "ui";
      installationName: string | null;
      expiresAt: string;
      reconnect: { connectionId: string; email: string | null } | null;
      scopeKind: "user" | "organization";
    }
  | { state: "expired" | "used" | "user_mismatch" | "invalid" | "disabled_by_org" };

export type ConnectFinishResult =
  | {
      state: "connected";
      connectionId: string;
      provider: string;
      email: string | null;
      created: boolean;
      reconnected: boolean;
      accountChanged: boolean;
      origin: "cli" | "ui";
      scopeKind: "user" | "organization";
    }
  | { state: "rejected"; reason: string }
  | { state: "expired" | "invalid" };

type UnavailableConnectState = Exclude<ConnectResolveView["state"], "pending">;

// --------------------------------------------------------------------------
// start
// --------------------------------------------------------------------------

export interface StartConnectInput {
  provider: string;
  organizationId: string;
  userId: string;
  origin: "cli" | "ui";
  cliSessionId: string | null;
  localInstallationId: string | null;
  accessMode?: ConnectorAccessMode | null;
  reconnectConnectionId?: string | null;
  requestedDisplayName?: string | null;
  continueNow?: boolean;
  /** `organization`: an account the organization's agents share, managed by the initiator. */
  scopeKind?: "user" | "organization";
  /** The member's role as the Console sends it; required for an organization account. */
  claimedRole?: unknown;
  requestId: string;
}

export interface StartConnectResult {
  connectUrl?: string;
  authorizationUrl?: string;
  pendingGrantId: string;
  expiresAt: Date;
}

export async function startConnect(
  deps: OAuthRuntimeDeps,
  input: StartConnectInput,
): Promise<StartConnectResult> {
  const adapter = deps.adapters.get(input.provider);
  if (!adapter) {
    throw new ConnectorHttpError(400, "payload_invalid", `Unknown provider: ${input.provider}`);
  }
  if (!(await isActiveOrganizationMember(deps.db, input))) {
    throw new ConnectorHttpError(403, "connector_forbidden", "Not an active member of the organization");
  }
  const policy = await findOrgConnectorPolicy(deps.db, {
    organizationId: input.organizationId,
    provider: input.provider,
  });
  if (!policy.enabled) {
    throw new ConnectorHttpError(403, "connector_disabled_by_org", "Connector disabled by the organization");
  }
  const scopeKind = input.scopeKind ?? "user";

  let reconnect: ProviderConnectionRecord | null = null;
  if (input.reconnectConnectionId) {
    reconnect = await requireReconnectTarget(deps.db, {
      connectionId: input.reconnectConnectionId,
      organizationId: input.organizationId,
      userId: input.userId,
      provider: input.provider,
      scopeKind,
    });
  }
  if (scopeKind === "organization") {
    // A new organization account: owners and admins (the role the Console
    // sent and the membership row). Reconnecting one: also its manager.
    if (reconnect?.managedByUserId !== input.userId) {
      await requireOrganizationAdmin(deps.db, input, input.claimedRole);
    }
    if (!policy.sharedAllowed) {
      throw new ConnectorHttpError(403, "connector_disabled_by_org", "Shared accounts are off for the organization", {
        reason: "shared_not_allowed",
      });
    }
  }

  // A reconnect keeps the access the connection has unless asked otherwise.
  const accessMode: ConnectorAccessMode =
    input.accessMode ??
    (reconnect ? connectionAccessMode(reconnect, adapter.writeScopes ?? []) : "full");
  // The Worker alone picks the scopes; callers only choose the access mode.
  const scopes = computeRequestedScopes(adapter, { accessMode });

  const connectToken = generateRandomToken(32);
  const connectTokenHash = await sha256Base64(connectToken);
  const pending = await insertPendingGrant(deps.db, {
    organizationId: input.organizationId,
    userId: input.userId,
    provider: input.provider,
    stateTokenHash: `placeholder:${generateRandomToken(24)}`,
    connectTokenHash,
    requestedScopes: scopes,
    requestedDisplayName: input.requestedDisplayName ?? null,
    origin: input.origin,
    cliSessionId: input.cliSessionId,
    targetScopeKind: scopeKind,
    reconnectConnectionId: reconnect?.id ?? null,
    accessMode,
    metadata: input.localInstallationId ? { localInstallationId: input.localInstallationId } : {},
    ttlSeconds: deps.pendingGrantTtlSeconds,
  });

  await insertAuditEvent(deps.db, {
    organizationId: input.organizationId,
    actorType: input.origin === "cli" ? "cli" : "user",
    actorId: input.userId,
    targetType: "connector_grant_pending",
    targetId: pending.id,
    action: "connector.oauth.start",
    requestId: input.requestId,
    metadata: {
      provider: input.provider,
      origin: input.origin,
      accessMode,
      reconnect: Boolean(reconnect),
      scopeCount: scopes.length,
      localInstallationId: input.localInstallationId,
      ...(scopeKind === "organization" ? { scopeKind } : {}),
    },
  });

  if (input.continueNow) {
    const { authorizationUrl } = await continueConnect(deps, {
      connectToken,
      organizationId: input.organizationId,
      userId: input.userId,
      requestId: input.requestId,
    });
    return { authorizationUrl, pendingGrantId: pending.id, expiresAt: pending.expiresAt };
  }

  return {
    connectUrl: `${trimSlash(deps.consoleBaseUrl)}/connect/${connectToken}`,
    pendingGrantId: pending.id,
    expiresAt: pending.expiresAt,
  };
}

/**
 * The row a reconnect updates: the initiator's own personal connection,
 * or (started by an owner or admin) an organization account.
 */
async function requireReconnectTarget(
  db: ConnectorsDb,
  input: {
    connectionId: string;
    organizationId: string;
    userId: string;
    provider: string;
    scopeKind: "user" | "organization";
  },
): Promise<ProviderConnectionRecord> {
  if (!UUID_RE.test(input.connectionId)) {
    throw new ConnectorHttpError(400, "payload_invalid", "Invalid reconnectConnectionId");
  }
  const connection = await findProviderConnectionById(db, input.connectionId, input.organizationId);
  const matches = connection && connection.provider !== "github" && (
    input.scopeKind === "organization"
      ? connection.scopeKind === "organization"
      : connection.scopeKind !== "organization" && connection.userId === input.userId
  );
  if (!connection || !matches) {
    throw new ConnectorHttpError(404, "not_found", "Connection not found");
  }
  if (connection.provider !== input.provider) {
    throw new ConnectorHttpError(400, "payload_invalid", "Connection belongs to another provider");
  }
  if (!isReconnectableConnectionStatus(connection.status)) {
    throw new ConnectorHttpError(400, "payload_invalid", "Connection cannot be reconnected");
  }
  return connection;
}

// --------------------------------------------------------------------------
// resolve + continue (Console connect page)
// --------------------------------------------------------------------------

export interface ConnectTokenInput {
  connectToken: string;
  organizationId: string;
  userId: string;
  requestId: string;
}

export async function resolveConnect(
  deps: OAuthRuntimeDeps,
  input: ConnectTokenInput,
): Promise<ConnectResolveView> {
  const pending = await findByConnectToken(deps.db, input.connectToken);
  if (!pending) return { state: "invalid" };
  const unavailable = await unavailableConnectState(deps.db, pending, input);
  if (unavailable) {
    if (unavailable === "user_mismatch") await auditUserMismatch(deps.db, pending, input, "resolve");
    return { state: unavailable };
  }

  const installationName = pending.origin === "cli"
    ? await findInstallationName(deps.db, {
        localInstallationId: stringMetadata(pending.metadataJson, "localInstallationId"),
        cliSessionId: pending.cliSessionId,
      })
    : null;
  let reconnect: { connectionId: string; email: string | null } | null = null;
  if (pending.reconnectConnectionId) {
    const connection = await findProviderConnectionById(
      deps.db,
      pending.reconnectConnectionId,
      pending.organizationId,
    );
    if (connection) reconnect = { connectionId: connection.id, email: connection.externalAccountLogin };
  }
  return {
    state: "pending",
    provider: pending.provider,
    accessMode: pending.accessMode,
    origin: pending.origin,
    installationName,
    expiresAt: pending.expiresAt.toISOString(),
    reconnect,
    scopeKind: pending.targetScopeKind === "organization" ? "organization" : "user",
  };
}

export async function continueConnect(
  deps: OAuthRuntimeDeps,
  input: ConnectTokenInput,
): Promise<{ authorizationUrl: string }> {
  const pending = await findByConnectToken(deps.db, input.connectToken);
  if (!pending) throw connectUnavailable("invalid");
  const unavailable = await unavailableConnectState(deps.db, pending, input);
  if (unavailable) {
    if (unavailable === "user_mismatch") await auditUserMismatch(deps.db, pending, input, "continue");
    throw connectUnavailable(unavailable);
  }
  const adapter = deps.adapters.get(pending.provider);
  if (!adapter) throw connectUnavailable("invalid");

  const stateToken = generateRandomToken(32);
  const stateTokenHash = await sha256Base64(stateToken);
  const pkceVerifier = adapter.supportsPkce ? generateRandomToken(64) : null;
  const pkceChallenge = pkceVerifier ? await pkceS256Challenge(pkceVerifier) : undefined;
  const pkceVerifierEncrypted = pkceVerifier
    ? await encryptBundle({
        plaintext: pkceVerifier,
        aad: pendingSecretAad({
          organizationId: pending.organizationId,
          userId: pending.userId,
          binding: `pending:${stateTokenHash}`,
          dekKeyVersion: deps.dekKeyVersion,
        }),
        rootWrapKey: deps.rootWrapKey,
      })
    : null;

  const continued = await continuePendingGrant(deps.db, {
    id: pending.id,
    organizationId: input.organizationId,
    userId: input.userId,
    stateTokenHash,
    pkceVerifierEncrypted,
  });
  if (!continued) throw connectUnavailable("used");

  let loginHint: string | undefined;
  if (continued.reconnectConnectionId) {
    const connection = await findProviderConnectionById(
      deps.db,
      continued.reconnectConnectionId,
      continued.organizationId,
    );
    loginHint = connection?.externalAccountLogin ?? undefined;
  }

  const authorizationUrl = adapter.buildAuthorizationUrl({
    state: stateToken,
    pkceChallenge,
    scopes: continued.requestedScopesJson,
    redirectUri: callbackUrl(deps, adapter),
    loginHint,
    // A read-only token must not inherit write scopes granted earlier.
    includeGrantedScopes: continued.accessMode !== "read_only",
  });

  await insertAuditEvent(deps.db, {
    organizationId: continued.organizationId,
    actorType: "user",
    actorId: input.userId,
    targetType: "connector_grant_pending",
    targetId: continued.id,
    action: "connector.oauth.continue",
    requestId: input.requestId,
    metadata: { provider: continued.provider, origin: continued.origin },
  });

  return { authorizationUrl };
}

async function findByConnectToken(
  db: ConnectorsDb,
  connectToken: string,
): Promise<ConnectorGrantPendingRecord | null> {
  const token = typeof connectToken === "string" ? connectToken.trim() : "";
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  return findPendingGrantByConnectTokenHash(db, await sha256Base64(token));
}

async function unavailableConnectState(
  db: ConnectorsDb,
  pending: ConnectorGrantPendingRecord,
  actor: { organizationId: string; userId: string },
): Promise<UnavailableConnectState | null> {
  if (pending.userId !== actor.userId || pending.organizationId !== actor.organizationId) {
    return "user_mismatch";
  }
  if (pending.status === "rejected") {
    return pending.rejectedReason === "disabled_by_org" ? "disabled_by_org" : "used";
  }
  if (pending.status === "consumed") return "used";
  if (pending.status === "expired" || pending.expiresAt.getTime() <= Date.now()) return "expired";
  if (pending.continuedAt) return "used";
  const policy = await findOrgConnectorPolicy(db, {
    organizationId: pending.organizationId,
    provider: pending.provider,
  });
  if (!policy.enabled) return "disabled_by_org";
  if (pending.targetScopeKind === "organization") {
    if (!policy.sharedAllowed) return "disabled_by_org";
    if (!(await organizationConnectRole(db, actor, pending))) return "invalid";
  }
  return null;
}

/**
 * Who may connect an organization account on this grant: an owner or
 * admin (`admin`, any account), or the manager of the account being
 * reconnected (`manager`, that account only); `null` for anyone else.
 */
async function organizationConnectRole(
  db: ConnectorsDb,
  actor: { organizationId: string; userId: string },
  pending: ConnectorGrantPendingRecord,
): Promise<"admin" | "manager" | null> {
  if (await isActiveOrganizationAdmin(db, actor)) return "admin";
  if (!pending.reconnectConnectionId) return null;
  const connection = await findProviderConnectionById(db, pending.reconnectConnectionId, pending.organizationId);
  if (
    connection?.scopeKind === "organization" &&
    connection.managedByUserId === actor.userId &&
    (await isActiveOrganizationMember(db, actor))
  ) {
    return "manager";
  }
  return null;
}

/** A manager's reconnect returned another Google account than the one they manage. */
class OrganizationAccountChangedError extends Error {
  constructor() {
    super("Reconnect returned another account");
    this.name = "OrganizationAccountChangedError";
  }
}

/** The initiator stopped being an active member while the finish ran. */
class ConnectMembershipEndedError extends Error {
  constructor() {
    super("Initiator is no longer an active member");
    this.name = "ConnectMembershipEndedError";
  }
}

function connectUnavailable(state: UnavailableConnectState): ConnectorHttpError {
  if (state === "disabled_by_org") {
    return new ConnectorHttpError(403, "connector_disabled_by_org", "Connector disabled by the organization", {
      state,
    });
  }
  return new ConnectorHttpError(409, "connector_connect_unavailable", `Connect link ${state}`, { state });
}

async function auditUserMismatch(
  db: ConnectorsDb,
  pending: ConnectorGrantPendingRecord,
  actor: { organizationId: string; userId: string; requestId: string },
  step: "resolve" | "continue" | "finish",
): Promise<void> {
  await insertAuditEvent(db, {
    organizationId: pending.organizationId,
    actorType: "user",
    actorId: actor.userId,
    targetType: "connector_grant_pending",
    targetId: pending.id,
    action: "connector.connect.user_mismatch",
    requestId: actor.requestId,
    metadata: { step, provider: pending.provider, sameOrganization: pending.organizationId === actor.organizationId },
  });
}

// --------------------------------------------------------------------------
// provider callback
// --------------------------------------------------------------------------

export interface OAuthCallbackInput {
  provider: string;
  code: string | null;
  state: string | null;
  error: string | null;
  requestId: string;
}

/** Returns the URL the browser is redirected to. Throws `ConnectorHttpError` (400) otherwise. */
export async function handleOAuthCallback(
  deps: OAuthRuntimeDeps,
  input: OAuthCallbackInput,
): Promise<string> {
  const state = input.state && input.state.length <= MAX_TOKEN_LENGTH ? input.state : null;
  const pending = state ? await findPendingGrantByStateTokenHash(deps.db, await sha256Base64(state)) : null;
  const awaitingCallback = Boolean(
    pending &&
      pending.provider === input.provider &&
      pending.status === "pending" &&
      pending.continuedAt &&
      !pending.authorizedAt &&
      pending.expiresAt.getTime() > Date.now(),
  );

  if (input.error) {
    if (!pending || !awaitingCallback) {
      throw new ConnectorHttpError(400, "connector_provider_error", "Provider returned an error");
    }
    await rejectPendingGrant(deps.db, { id: pending.id, reason: "provider_denied" });
    await insertAuditEvent(deps.db, {
      organizationId: pending.organizationId,
      actorType: "system",
      actorId: null,
      targetType: "connector_grant_pending",
      targetId: pending.id,
      action: "connector.oauth.callback_failed",
      requestId: input.requestId,
      metadata: { reason: "provider_denied", provider: pending.provider },
    });
    return finishUrl(deps, { pendingId: pending.id, error: "provider_denied" });
  }

  if (!input.code || !state) {
    throw new ConnectorHttpError(400, "payload_invalid", "Missing code/state");
  }
  if (!pending || !awaitingCallback) {
    await insertAuditEvent(deps.db, {
      organizationId: pending?.organizationId ?? null,
      actorType: "system",
      actorId: null,
      targetType: "connector_grant_pending",
      targetId: pending?.id ?? null,
      action: "connector.oauth.callback_failed",
      requestId: input.requestId,
      metadata: { reason: pending ? "pending_grant_not_awaiting_callback" : "pending_grant_not_found" },
    });
    throw new ConnectorHttpError(400, "payload_invalid", "Pending grant missing, used or expired");
  }

  const codeEncrypted = await encryptBundle({
    plaintext: input.code,
    aad: pendingSecretAad({
      organizationId: pending.organizationId,
      userId: pending.userId,
      binding: `pending-code:${pending.id}`,
      dekKeyVersion: deps.dekKeyVersion,
    }),
    rootWrapKey: deps.rootWrapKey,
  });
  const resultToken = generateRandomToken(32);
  const authorized = await authorizePendingGrant(deps.db, {
    id: pending.id,
    stateTokenHash: pending.stateTokenHash,
    codeEncrypted,
    resultTokenHash: await sha256Base64(resultToken),
  });
  if (!authorized) {
    throw new ConnectorHttpError(400, "payload_invalid", "Pending grant missing, used or expired");
  }

  await insertAuditEvent(deps.db, {
    organizationId: authorized.organizationId,
    actorType: "system",
    actorId: null,
    targetType: "connector_grant_pending",
    targetId: authorized.id,
    action: "connector.oauth.authorized",
    requestId: input.requestId,
    metadata: { provider: authorized.provider, origin: authorized.origin },
  });

  return finishUrl(deps, { pendingId: authorized.id, resultToken });
}

function finishUrl(
  deps: OAuthRuntimeDeps,
  input: { pendingId: string; resultToken?: string; error?: string },
): string {
  const url = new URL(`${trimSlash(deps.consoleBaseUrl)}/connect/finish`);
  url.searchParams.set("p", input.pendingId);
  if (input.resultToken) url.searchParams.set("r", input.resultToken);
  if (input.error) url.searchParams.set("error", input.error);
  return url.toString();
}

// --------------------------------------------------------------------------
// finish (Console finish page)
// --------------------------------------------------------------------------

export interface FinishConnectInput {
  organizationId: string;
  userId: string;
  pendingId: string;
  resultToken: string;
  requestId: string;
}

export async function finishConnect(
  deps: OAuthRuntimeDeps,
  input: FinishConnectInput,
): Promise<ConnectFinishResult> {
  if (!UUID_RE.test(input.pendingId)) return { state: "invalid" };
  const resultToken = typeof input.resultToken === "string" ? input.resultToken.trim() : "";
  if (!resultToken || resultToken.length > MAX_TOKEN_LENGTH) return { state: "invalid" };

  const pending = await findPendingGrant(deps.db, input.pendingId);
  if (!pending || !pending.resultTokenHash) return { state: "invalid" };
  if (!timingSafeEqualString(await sha256Base64(resultToken), pending.resultTokenHash)) {
    return { state: "invalid" };
  }

  if (pending.userId !== input.userId || pending.organizationId !== input.organizationId) {
    if (pending.status === "pending") {
      await rejectPendingGrant(deps.db, { id: pending.id, reason: "user_mismatch" });
    }
    await auditUserMismatch(deps.db, pending, input, "finish");
    return { state: "rejected", reason: "user_mismatch" };
  }

  if (pending.status !== "pending") return settledFinishResult(deps, pending);
  if (pending.expiresAt.getTime() <= Date.now()) {
    await expirePendingGrant(deps.db, pending.id);
    return { state: "expired" };
  }

  const policy = await findOrgConnectorPolicy(deps.db, {
    organizationId: pending.organizationId,
    provider: pending.provider,
  });
  if (!policy.enabled) {
    await rejectPendingGrant(deps.db, { id: pending.id, reason: "disabled_by_org" });
    return { state: "rejected", reason: "disabled_by_org" };
  }
  if (pending.targetScopeKind === "organization") {
    if (!policy.sharedAllowed) {
      await rejectPendingGrant(deps.db, { id: pending.id, reason: "disabled_by_org" });
      return { state: "rejected", reason: "disabled_by_org" };
    }
  }
  const organizationRole = pending.targetScopeKind === "organization"
    ? await organizationConnectRole(deps.db, input, pending)
    : null;
  if (pending.targetScopeKind === "organization" && !organizationRole) {
    await rejectPendingGrant(deps.db, { id: pending.id, reason: "forbidden" });
    return { state: "rejected", reason: "forbidden" };
  }

  const claimed = await claimAuthorizedPendingGrant(deps.db, pending.id);
  if (!claimed) {
    const current = await findPendingGrant(deps.db, pending.id);
    if (!current) return { state: "invalid" };
    return settledFinishResult(deps, current);
  }
  const grant = claimed.grant;

  const adapter = deps.adapters.get(grant.provider);
  let tokens: ProviderTokenBundle;
  try {
    if (!adapter) throw new Error("Provider adapter not registered");
    const code = await decryptBundle({
      bundle: claimed.codeEncrypted,
      aad: pendingSecretAad({
        organizationId: grant.organizationId,
        userId: grant.userId,
        binding: `pending-code:${grant.id}`,
        dekKeyVersion: deps.dekKeyVersion,
      }),
      rootWrapKey: deps.rootWrapKey,
    });
    const pkceVerifier = grant.pkceVerifierEncrypted
      ? await decryptBundle({
          bundle: grant.pkceVerifierEncrypted,
          aad: pendingSecretAad({
            organizationId: grant.organizationId,
            userId: grant.userId,
            binding: `pending:${grant.stateTokenHash}`,
            dekKeyVersion: deps.dekKeyVersion,
          }),
          rootWrapKey: deps.rootWrapKey,
        })
      : undefined;
    tokens = await adapter.exchangeAuthorizationCode({
      code,
      pkceVerifier,
      redirectUri: callbackUrl(deps, adapter),
    });
  } catch (error) {
    await failClaimedPendingGrant(deps.db, { id: grant.id, reason: "exchange_failed" });
    await auditFinishFailed(deps.db, grant, input.requestId, "exchange_failed", error);
    return { state: "rejected", reason: "exchange_failed" };
  }

  const claims = decodeIdTokenClaims(tokens.idToken);
  const identity: AccountIdentity = {
    sub: claims?.sub ?? tokens.externalAccountId ?? null,
    email: claims?.email ?? tokens.externalAccountLogin?.toLowerCase() ?? null,
  };
  // An answer that names no account (the identity scopes taken out of the
  // sign-in URL) could hold anyone's tokens: nothing is stored.
  if (!identity.sub) {
    await failClaimedPendingGrant(deps.db, { id: grant.id, reason: "identity_missing" });
    await auditFinishFailed(deps.db, grant, input.requestId, "identity_missing", null);
    return { state: "rejected", reason: "identity_missing" };
  }

  let stored: StoredConnection;
  try {
    stored = await storeConnectedAccount(deps, {
      grant,
      adapter: adapter!,
      tokens,
      identity,
      mayAddOrganizationAccount: organizationRole === "admin",
    });
  } catch (error) {
    if (error instanceof OrganizationAccountChangedError) {
      await failClaimedPendingGrant(deps.db, { id: grant.id, reason: "account_changed" });
      await auditFinishFailed(deps.db, grant, input.requestId, "account_changed", error);
      return { state: "rejected", reason: "account_changed" };
    }
    if (error instanceof ConnectMembershipEndedError) {
      await failClaimedPendingGrant(deps.db, { id: grant.id, reason: "not_member" });
      await auditFinishFailed(deps.db, grant, input.requestId, "not_member", error);
      return { state: "rejected", reason: "not_member" };
    }
    await failClaimedPendingGrant(deps.db, { id: grant.id, reason: "exchange_failed" });
    await auditFinishFailed(deps.db, grant, input.requestId, "store_failed", error);
    return { state: "rejected", reason: "exchange_failed" };
  }

  await insertAuditEvent(deps.db, {
    organizationId: grant.organizationId,
    actorType: grant.origin === "cli" ? "cli" : "user",
    actorId: grant.userId,
    targetType: "provider_connection",
    targetId: stored.result.connectionId,
    action: "connector.connect.finished",
    requestId: input.requestId,
    metadata: {
      provider: grant.provider,
      pendingGrantId: grant.id,
      origin: grant.origin,
      created: stored.result.created,
      reconnected: stored.result.reconnected,
      accountChanged: stored.result.accountChanged,
      accessMode: grant.accessMode,
      scopeCount: stored.scopeCount,
      hasRefreshToken: Boolean(tokens.refreshToken),
      identityKnown: Boolean(identity.sub),
      ...(grant.targetScopeKind === "organization" ? { scopeKind: "organization" } : {}),
    },
  });
  if (stored.managerChange) {
    await insertAuditEvent(deps.db, {
      organizationId: grant.organizationId,
      actorType: "user",
      actorId: grant.userId,
      targetType: "provider_connection",
      targetId: stored.result.connectionId,
      action: "connector.org_connection.manager_changed",
      requestId: input.requestId,
      metadata: {
        provider: grant.provider,
        reason: "connected",
        pendingGrantId: grant.id,
        previousManagerUserId: stored.managerChange.previousManagerUserId,
        managedByUserId: stored.managerChange.managedByUserId,
        expiredApprovals: stored.managerChange.expiredApprovals,
        movedGrants: stored.managerChange.movedGrants,
      },
    });
  }

  return stored.result;
}

/**
 * The grant was already settled (or is being settled by a concurrent
 * finish): return the stored outcome, never exchange again.
 */
async function settledFinishResult(
  deps: OAuthRuntimeDeps,
  initial: ConnectorGrantPendingRecord,
): Promise<ConnectFinishResult> {
  let pending = initial;
  for (let attempt = 0; ; attempt += 1) {
    if (pending.status === "rejected") return { state: "rejected", reason: pending.rejectedReason ?? "rejected" };
    if (pending.status === "expired") return { state: "expired" };
    if (pending.status === "pending") {
      return pending.expiresAt.getTime() <= Date.now() ? { state: "expired" } : { state: "invalid" };
    }
    if (pending.resultingConnectionId) return storedFinishResult(deps.db, pending);
    // The finish that claimed it died before storing anything.
    if (isStaleClaim(pending)) return { state: "rejected", reason: "exchange_failed" };
    if (attempt >= FINISH_WAIT_ATTEMPTS) return { state: "invalid" };
    await (deps.sleep ?? defaultSleep)(FINISH_WAIT_MS);
    const next = await findPendingGrant(deps.db, pending.id);
    if (!next) return { state: "invalid" };
    pending = next;
  }
}

async function storedFinishResult(
  db: ConnectorsDb,
  pending: ConnectorGrantPendingRecord,
): Promise<ConnectFinishResult> {
  const stored = pending.metadataJson?.finishResult as Record<string, unknown> | undefined;
  if (stored && typeof stored === "object" && stored.connectionId === pending.resultingConnectionId) {
    return {
      state: "connected",
      connectionId: String(stored.connectionId),
      provider: typeof stored.provider === "string" ? stored.provider : pending.provider,
      email: typeof stored.email === "string" ? stored.email : null,
      created: stored.created === true,
      reconnected: stored.reconnected === true,
      accountChanged: stored.accountChanged === true,
      origin: pending.origin,
      scopeKind: pending.targetScopeKind === "organization" ? "organization" : "user",
    };
  }
  // Grants consumed by the previous flow carry no stored result.
  const connection = await findProviderConnectionById(db, pending.resultingConnectionId!, pending.organizationId);
  return {
    state: "connected",
    connectionId: pending.resultingConnectionId!,
    provider: pending.provider,
    email: connection?.externalAccountLogin ?? null,
    created: true,
    reconnected: false,
    accountChanged: false,
    origin: pending.origin,
    scopeKind: pending.targetScopeKind === "organization" ? "organization" : "user",
  };
}

interface StoredConnection {
  result: Extract<ConnectFinishResult, { state: "connected" }>;
  scopeCount: number;
  /** An organization account connected again by someone other than its manager, who now manages it. */
  managerChange?: OrgManagerChange;
}

/**
 * Upsert the connected account (scope user) by its provider `sub`:
 *   - same (organization, user, provider, sub) live row → updated in place;
 *   - reconnect of a row holding another account, or one whose account is
 *     unknown → a NEW row (or the row already holding the new account),
 *     `accountChanged: true`; a reconnect never swaps the account under an
 *     existing connection;
 *   - otherwise a new personal row.
 * The stored scopes and `metadata_json.accessMode` follow the grant's
 * access mode, whatever else the provider reports as granted.
 * Credentials, row and grant result are written in one transaction under
 * the account lock revokes take too, and the updated row is locked, so a
 * row disconnected meanwhile is never brought back; the initiator's
 * membership is checked again under its lock, so neither is a row of a
 * member removed meanwhile. A race on the per-person unique index is
 * retried once.
 */
async function storeConnectedAccount(
  deps: OAuthRuntimeDeps,
  input: {
    grant: ConnectorGrantPendingRecord;
    adapter: ConnectorAdapter;
    tokens: ProviderTokenBundle;
    identity: AccountIdentity;
    /** An organization grant of an owner or admin: may add or update any organization account. */
    mayAddOrganizationAccount?: boolean;
  },
): Promise<StoredConnection> {
  // Legacy rows of this person that never learned their account may be
  // this one: learn it first so the upsert below updates them in place.
  if (input.identity.sub && input.grant.targetScopeKind !== "organization") {
    try {
      await backfillUserAccountIdentities(deps, { provider: input.grant.provider, userId: input.grant.userId });
    } catch (error) {
      console.error("ravi-connectors identity backfill failed", {
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withTransaction(deps.db, (tx) => storeConnectedAccountOnce(deps, tx, input));
    } catch (error) {
      if (attempt === 0 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

async function storeConnectedAccountOnce(
  deps: OAuthRuntimeDeps,
  tx: ConnectorsDb,
  input: {
    grant: ConnectorGrantPendingRecord;
    adapter: ConnectorAdapter;
    tokens: ProviderTokenBundle;
    identity: AccountIdentity;
    /** An organization grant of an owner or admin: may add or update any organization account. */
    mayAddOrganizationAccount?: boolean;
  },
): Promise<StoredConnection> {
  const { grant, adapter, tokens, identity } = input;
  // The Console checked the membership before forwarding the finish; a
  // removal since then must not see its suspended rows brought back, or a
  // new row added, by this one. Checked after the lock the removal takes.
  const member = { organizationId: grant.organizationId, userId: grant.userId };
  await lockOrganizationMember(tx, member);
  if (!(await isActiveOrganizationMember(tx, member))) throw new ConnectMembershipEndedError();
  const scopes = scopesToStore(adapter, {
    granted: tokens.scopes,
    requested: grant.requestedScopesJson,
    accessMode: grant.accessMode,
  });
  if (grant.targetScopeKind === "organization") {
    return storeOrganizationAccountOnce(deps, tx, { ...input, scopes });
  }
  await lockConnectorAccount(tx, { provider: grant.provider, userId: grant.userId, sub: identity.sub });

  let target: ProviderConnectionRecord | null = null;
  let accountChanged = false;
  if (grant.reconnectConnectionId) {
    const requested = await lockProviderConnection(tx, grant.reconnectConnectionId, grant.organizationId);
    if (
      requested &&
      requested.userId === grant.userId &&
      requested.provider === grant.provider &&
      requested.scopeKind !== "organization" &&
      isReconnectableConnectionStatus(requested.status)
    ) {
      // Only the same known account updates the row: one that can't be told
      // apart from it (a legacy row that never learned its account) is
      // another account, in its own row.
      const same = sameAccount(
        { sub: connectionAccountSub(requested), email: requested.externalAccountLogin },
        identity,
      );
      if (same === true) target = requested;
      else accountChanged = true;
    }
  }
  if (!target && identity.sub) {
    const holders = await findReconnectableUserConnectionsForAccount(tx, {
      organizationId: grant.organizationId,
      userId: grant.userId,
      provider: grant.provider,
      sub: identity.sub,
    });
    target = holders[0] ?? null;
  }

  let connection = target
    ? await refreshConnectionAfterConnect(tx, {
        id: target.id,
        scopes,
        email: identity.email,
        displayName: grant.requestedDisplayName,
        accessMode: grant.accessMode,
      })
    : null;
  let created = false;
  if (!connection) {
    connection = await insertProviderConnection(tx, {
      organizationId: grant.organizationId,
      projectId: null,
      userId: grant.userId,
      provider: grant.provider,
      scopeKind: "user",
      externalAccountId: null,
      externalAccountLogin: identity.email,
      displayName: grant.requestedDisplayName ?? identity.email ?? adapter.displayName,
      scopes,
      capabilities: [],
      metadata: { accessMode: grant.accessMode },
      grantedByUserId: grant.userId,
    });
    created = true;
  }
  await applyAccountIdentity(tx, connection, identity);

  const existing = created ? [] : await findCredentialsByConnection(tx, connection.id);
  await storeConnectionTokens(tx, {
    rootWrapKey: deps.rootWrapKey,
    dekKeyVersion: deps.dekKeyVersion,
    connection,
    tokens,
    existing,
  });

  return completeStoredConnection(tx, { grant, connection, identity, created, accountChanged, scopes });
}

/**
 * The organization-account branch of the upsert: the same rules by
 * (organization, provider, sub), with no user, managed by the initiator
 * (a new row, and an existing one connected again by someone other than
 * its manager). The vault binds the credentials to no user.
 */
async function storeOrganizationAccountOnce(
  deps: OAuthRuntimeDeps,
  tx: ConnectorsDb,
  input: {
    grant: ConnectorGrantPendingRecord;
    adapter: ConnectorAdapter;
    tokens: ProviderTokenBundle;
    identity: AccountIdentity;
    scopes: string[];
    mayAddOrganizationAccount?: boolean;
  },
): Promise<StoredConnection> {
  const { grant, adapter, tokens, identity, scopes } = input;
  await lockConnectorAccount(tx, { provider: grant.provider, userId: null, sub: identity.sub });

  let target: ProviderConnectionRecord | null = null;
  let accountChanged = false;
  if (grant.reconnectConnectionId) {
    const requested = await lockProviderConnection(tx, grant.reconnectConnectionId, grant.organizationId);
    if (
      requested &&
      requested.scopeKind === "organization" &&
      requested.provider === grant.provider &&
      isReconnectableConnectionStatus(requested.status)
    ) {
      const same = sameAccount(
        { sub: connectionAccountSub(requested), email: requested.externalAccountLogin },
        identity,
      );
      if (same === true) target = requested;
      else accountChanged = true;
    }
  }
  if (!target && identity.sub) {
    const holders = await findReconnectableOrgConnectionsForAccount(tx, {
      organizationId: grant.organizationId,
      provider: grant.provider,
      sub: identity.sub,
    });
    target = holders[0] ?? null;
  }
  if (!input.mayAddOrganizationAccount && (!target || target.id !== grant.reconnectConnectionId)) {
    throw new OrganizationAccountChangedError();
  }

  let connection = target
    ? await refreshConnectionAfterConnect(tx, {
        id: target.id,
        scopes,
        email: identity.email,
        displayName: grant.requestedDisplayName,
        accessMode: grant.accessMode,
      })
    : null;
  let created = false;
  let managerChange: OrgManagerChange | null = null;
  if (connection) {
    // Contract 3.5: whoever connects the account manages it. The manager's
    // own reconnect changes nothing; an owner's or admin's moves the
    // account to them exactly as "Change owner" does.
    if (connection.managedByUserId !== grant.userId) {
      managerChange = await setOrgConnectionManager(tx, {
        id: connection.id,
        organizationId: grant.organizationId,
        managedByUserId: grant.userId,
      });
      connection = { ...connection, managedByUserId: grant.userId };
    }
  } else {
    connection = await insertProviderConnection(tx, {
      organizationId: grant.organizationId,
      projectId: null,
      userId: null,
      provider: grant.provider,
      scopeKind: "organization",
      externalAccountId: null,
      externalAccountLogin: identity.email,
      displayName: grant.requestedDisplayName ?? identity.email ?? adapter.displayName,
      scopes,
      capabilities: [],
      metadata: { accessMode: grant.accessMode },
      grantedByUserId: grant.userId,
      managedByUserId: grant.userId,
    });
    created = true;
  }
  await applyAccountIdentity(tx, connection, identity);

  const existing = created ? [] : await findCredentialsByConnection(tx, connection.id);
  await storeConnectionTokens(tx, {
    rootWrapKey: deps.rootWrapKey,
    dekKeyVersion: deps.dekKeyVersion,
    connection: { id: connection.id, organizationId: connection.organizationId, userId: null },
    tokens,
    existing,
  });
  const stored = await completeStoredConnection(tx, { grant, connection, identity, created, accountChanged, scopes });
  return managerChange ? { ...stored, managerChange } : stored;
}

async function completeStoredConnection(
  tx: ConnectorsDb,
  input: {
    grant: ConnectorGrantPendingRecord;
    connection: ProviderConnectionRecord;
    identity: AccountIdentity;
    created: boolean;
    accountChanged: boolean;
    scopes: string[];
  },
): Promise<StoredConnection> {
  const { grant, connection, identity, created, accountChanged } = input;
  const result: StoredConnection["result"] = {
    state: "connected",
    connectionId: connection.id,
    provider: connection.provider,
    email: identity.email ?? connection.externalAccountLogin,
    created,
    reconnected: !created && !accountChanged,
    accountChanged,
    origin: grant.origin,
    scopeKind: grant.targetScopeKind === "organization" ? "organization" : "user",
  };
  await completePendingGrant(tx, {
    id: grant.id,
    connectionId: connection.id,
    finishResult: {
      connectionId: result.connectionId,
      provider: result.provider,
      email: result.email,
      created: result.created,
      reconnected: result.reconnected,
      accountChanged: result.accountChanged,
      origin: result.origin,
      scopeKind: result.scopeKind,
    },
  });
  return { result, scopeCount: input.scopes.length };
}

async function auditFinishFailed(
  db: ConnectorsDb,
  grant: ConnectorGrantPendingRecord,
  requestId: string,
  reason: string,
  error: unknown,
): Promise<void> {
  await insertAuditEvent(db, {
    organizationId: grant.organizationId,
    actorType: "system",
    actorId: grant.userId,
    targetType: "connector_grant_pending",
    targetId: grant.id,
    action: "connector.connect.failed",
    requestId,
    metadata: {
      reason,
      provider: grant.provider,
      errorName: error instanceof Error ? error.name : "unknown",
      providerStatus: (error as { status?: unknown })?.status ?? null,
      providerCode: (error as { providerCode?: unknown })?.providerCode ?? null,
    },
  });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function callbackUrl(deps: OAuthRuntimeDeps, adapter: ConnectorAdapter): string {
  return `${trimSlash(deps.redirectBaseUrl)}/oauth/${adapter.providerId}/callback`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function stringMetadata(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
