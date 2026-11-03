/**
 * Connection lifecycle: revoke (by the owner, the manager of an
 * organization account, or an organization admin), rename, make default.
 *
 * Centralizes the post-create operations on a provider_connection so the
 * router stays thin.
 *
 * Revoke calls the provider's revoke endpoint only when no other live row
 * (any organization, any person) holds the same account: Google's revoke
 * kills the whole grant of that account for the Ravi OAuth client, i.e.
 * every other connection of it. A row of the same person whose account is
 * still unknown counts as a possible holder. The decision and the status
 * change run under the account lock the connect upsert takes too, so two
 * revokes, or a revoke and a connect, of one account never decide on a
 * stale count. The row's credentials are always deleted (crypto-shred: the
 * wrapped DEK goes with them). If the provider revoke fails the row is
 * marked `revoke_pending` (never used for exec) and keeps its credentials
 * so the scheduled handler can retry.
 */

import { AdapterProviderError, type ConnectorAdapter } from "./adapters/adapter";
import { backfillConnectionIdentity, backfillUserAccountIdentities } from "./account-identity";
import type { ConnectorsDb } from "./db";
import {
  connectionAccountSub,
  countOtherLiveConnectionsForAccount,
  countOtherLiveConnectionsForUser,
  countOtherLiveConnectionsWithUnknownAccount,
  findCredentialsByConnection,
  findProviderConnectionById,
  insertAuditEvent,
  isActiveOrganizationAdmin,
  isActiveOrganizationMember,
  isLiveConnectionStatus,
  isReconnectableConnectionStatus,
  lockConnectorAccount,
  lockProviderConnection,
  markConnectionRevoked,
  markConnectionRevokePending,
  renameConnection,
  setDefaultConnection,
  withTransaction,
  type ProviderConnectionRecord,
} from "./db";
import { decryptStoredCredential } from "./vault";

/** Failed provider revokes after which the credentials are shredded anyway. */
export const MAX_REVOKE_ATTEMPTS = 5;
const MAX_DISPLAY_NAME_LENGTH = 120;

export interface LifecycleDeps {
  db: ConnectorsDb;
  rootWrapKey: CryptoKey;
  adapters: Map<string, ConnectorAdapter>;
}

export interface RevokeInput {
  organizationId: string;
  userId: string;
  providerConnectionId: string;
  requestId: string;
  origin: "user" | "operator";
  actorType?: "user" | "cli";
  /**
   * The Console may disconnect an organization account too: its manager
   * (closed as `revoked_by_user`) or an organization owner or admin
   * (`revoked_by_operator`). The CLI only ever disconnects its own.
   */
  allowOrganization?: boolean;
}

export class LifecycleError extends Error {
  constructor(public readonly code: LifecycleErrorCode, message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

export type LifecycleErrorCode =
  | "connector_unavailable"
  | "connector_provider_error"
  | "payload_invalid";

export async function revokeConnection(
  deps: LifecycleDeps,
  input: RevokeInput,
): Promise<void> {
  let origin = input.origin;
  let connection: ProviderConnectionRecord;
  if (input.allowOrganization) {
    const managed = await requireManagedConnection(deps.db, input);
    connection = managed.connection;
    if (managed.as === "admin") origin = "operator";
  } else {
    connection = await requireOwnConnection(deps.db, input);
  }
  // Already disconnected: nothing left to revoke.
  if (!isLiveConnectionStatus(connection.status)) return;
  if (!deps.adapters.get(connection.provider)) {
    throw new LifecycleError("connector_unavailable", "Adapter missing");
  }
  // The organization account's shared grants go with it (`markConnectionRevoked`).
  const outcome = await revokeAndShred(deps, connection, {
    origin,
    requestId: input.requestId,
    actorType: input.actorType ?? "user",
    actorId: input.userId,
  });
  if (outcome.kind === "provider_failed") {
    throw new LifecycleError("connector_provider_error", "Provider revoke failed");
  }
}

/**
 * An organization owner or admin disconnects a member's connection (or an
 * organization connection): the same revoke as the owner's, closed as
 * `revoked_by_operator`. GitHub installations never qualify.
 */
export async function revokeConnectionAsOperator(
  deps: LifecycleDeps,
  input: { organizationId: string; operatorUserId: string; providerConnectionId: string; requestId: string },
): Promise<void> {
  const connection = await findProviderConnectionById(deps.db, input.providerConnectionId, input.organizationId);
  if (!connection || connection.provider === "github") {
    throw new LifecycleError("connector_unavailable", "Connection not found");
  }
  if (!isLiveConnectionStatus(connection.status)) return;
  if (!deps.adapters.get(connection.provider)) {
    throw new LifecycleError("connector_unavailable", "Adapter missing");
  }
  const outcome = await revokeAndShred(deps, connection, {
    origin: "operator",
    requestId: input.requestId,
    actorType: "user",
    actorId: input.operatorUserId,
  });
  if (outcome.kind === "provider_failed") {
    throw new LifecycleError("connector_provider_error", "Provider revoke failed");
  }
}

export type RevokeOutcome =
  | { kind: "revoked"; providerRevoked: boolean }
  | { kind: "provider_failed"; attempts: number; errorCode: string }
  /** `onlyIf` no longer held under the lock: nothing was done. */
  | { kind: "skipped" };

/**
 * Revoke one live row: provider revoke (only when no other live row
 * shares the account), then shred + close. Used by user and operator
 * revokes, the scheduled retry of `revoke_pending` rows and the
 * revocation outbox. A row a concurrent revoke already closed is left as
 * it is.
 *
 * When the provider revoke fails the row keeps its credentials; it is
 * marked `revoke_pending` (counted in `metadata_json.revokeAttempts`)
 * unless `onProviderFailure` is `keep`, for callers that count and retry
 * on their own (the outbox). `onlyIf` is checked on the locked row: when
 * it no longer holds (the outbox's connection was reconnected since it
 * was queued) nothing is done.
 */
export async function revokeAndShred(
  deps: LifecycleDeps,
  initial: ProviderConnectionRecord,
  options: {
    origin: "user" | "operator";
    requestId: string | null;
    actorType: "user" | "cli" | "system";
    actorId: string | null;
    onProviderFailure?: "revoke_pending" | "keep";
    auditMetadata?: Record<string, unknown>;
    onlyIf?: (connection: ProviderConnectionRecord) => boolean;
  },
): Promise<RevokeOutcome> {
  const adapter = deps.adapters.get(initial.provider);
  // Learn the accounts first, outside the lock: this row's, and those of
  // the same person's rows that do not know theirs yet.
  let sub = connectionAccountSub(initial);
  if (adapter && !sub && initial.provider === "google") {
    sub = (await backfillConnectionIdentity(deps, initial))?.sub ?? null;
  }
  if (adapter && initial.userId) {
    await backfillUserAccountIdentities(deps, {
      provider: initial.provider,
      userId: initial.userId,
      excludeId: initial.id,
    });
  }

  return withTransaction(deps.db, async (tx) => {
    await lockConnectorAccount(tx, { provider: initial.provider, userId: initial.userId, sub });
    const connection = await lockProviderConnection(tx, initial.id, initial.organizationId);
    if (!connection || !isLiveConnectionStatus(connection.status)) {
      return { kind: "revoked", providerRevoked: false } as const;
    }
    if (options.onlyIf && !options.onlyIf(connection)) return { kind: "skipped" } as const;
    const callProvider = adapter
      ? await shouldCallProviderRevoke(tx, connection, connectionAccountSub(connection) ?? sub)
      : false;

    if (adapter && callProvider) {
      try {
        const credentials = await findCredentialsByConnection(tx, connection.id);
        const refreshRow = credentials.find((row) => row.payloadKind === "refresh_token");
        const accessRow = credentials.find((row) => row.payloadKind === "access_token");
        const refreshToken = refreshRow
          ? await decryptStoredCredential(deps.rootWrapKey, connection, refreshRow)
          : undefined;
        const accessToken = accessRow
          ? await decryptStoredCredential(deps.rootWrapKey, connection, accessRow)
          : undefined;
        await adapter.revoke({ accessToken, refreshToken });
      } catch (error) {
        const errorCode = revokeErrorCode(error);
        if (options.onProviderFailure === "keep") return { kind: "provider_failed", attempts: 0, errorCode } as const;
        const attempts = await markConnectionRevokePending(tx, { id: connection.id, origin: options.origin });
        await insertAuditEvent(tx, {
          organizationId: connection.organizationId,
          actorType: options.actorType,
          actorId: options.actorId,
          targetType: "provider_connection",
          targetId: connection.id,
          action: "connector.revoked",
          requestId: options.requestId,
          metadata: {
            origin: options.origin,
            providerRevokePending: true,
            attempts,
            errorName: error instanceof Error ? error.name : "unknown",
            providerStatus: (error as { status?: unknown })?.status ?? null,
            ...(options.auditMetadata ?? {}),
          },
        });
        return { kind: "provider_failed", attempts, errorCode } as const;
      }
    }

    await markConnectionRevoked(tx, { id: connection.id, status: revokedStatus(options.origin) });
    await insertAuditEvent(tx, {
      organizationId: connection.organizationId,
      actorType: options.actorType,
      actorId: options.actorId,
      targetType: "provider_connection",
      targetId: connection.id,
      action: "connector.revoked",
      requestId: options.requestId,
      metadata: {
        origin: options.origin,
        providerRevoked: callProvider,
        // The account stays (or may stay) connected elsewhere in Ravi, so its grant was kept.
        sharedAccountKept: Boolean(adapter) && !callProvider,
        ...(options.auditMetadata ?? {}),
      },
    });
    return { kind: "revoked", providerRevoked: callProvider } as const;
  });
}

/**
 * Scheduled retry of a `revoke_pending` row. After `MAX_REVOKE_ATTEMPTS`
 * failed provider revokes the credentials are shredded anyway.
 */
export async function retryPendingRevoke(
  deps: LifecycleDeps,
  connection: ProviderConnectionRecord,
): Promise<"revoked" | "retry" | "gave_up"> {
  const origin = connection.metadataJson?.revokeOrigin === "operator" ? "operator" : "user";
  const outcome = await revokeAndShred(deps, connection, {
    origin,
    requestId: null,
    actorType: "system",
    actorId: null,
  });
  if (outcome.kind !== "provider_failed") return "revoked";
  if (outcome.attempts < MAX_REVOKE_ATTEMPTS) return "retry";
  await markConnectionRevoked(deps.db, { id: connection.id, status: revokedStatus(origin) });
  await insertAuditEvent(deps.db, {
    organizationId: connection.organizationId,
    actorType: "system",
    actorId: null,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "connector.revoke.provider_gave_up",
    requestId: null,
    metadata: { origin, attempts: outcome.attempts },
  });
  return "gave_up";
}

/**
 * The provider revoke kept failing: shred the credentials and close the
 * row anyway, under the same locks as `revokeAndShred`, and only while the
 * row is still live and `onlyIf` holds. Returns whether it was closed.
 */
export async function shredAfterGivingUp(
  deps: Pick<LifecycleDeps, "db">,
  initial: ProviderConnectionRecord,
  options: {
    origin: "user" | "operator";
    onlyIf?: (connection: ProviderConnectionRecord) => boolean;
    auditMetadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  return withTransaction(deps.db, async (tx) => {
    await lockConnectorAccount(tx, {
      provider: initial.provider,
      userId: initial.userId,
      sub: connectionAccountSub(initial),
    });
    const connection = await lockProviderConnection(tx, initial.id, initial.organizationId);
    if (!connection || !isLiveConnectionStatus(connection.status)) return false;
    if (options.onlyIf && !options.onlyIf(connection)) return false;
    await markConnectionRevoked(tx, { id: connection.id, status: revokedStatus(options.origin) });
    await insertAuditEvent(tx, {
      organizationId: connection.organizationId,
      actorType: "system",
      actorId: null,
      targetType: "provider_connection",
      targetId: connection.id,
      action: "connector.revoke.provider_gave_up",
      requestId: null,
      metadata: { origin: options.origin, ...(options.auditMetadata ?? {}) },
    });
    return true;
  });
}

async function shouldCallProviderRevoke(
  db: ConnectorsDb,
  connection: ProviderConnectionRecord,
  sub: string | null,
): Promise<boolean> {
  if (sub) {
    const others = await countOtherLiveConnectionsForAccount(db, {
      provider: connection.provider,
      sub,
      excludeId: connection.id,
    });
    if (others > 0) return false;
    if (!connection.userId) return true;
    // A row of the same person that never learned its account may be it.
    const unknown = await countOtherLiveConnectionsWithUnknownAccount(db, {
      provider: connection.provider,
      userId: connection.userId,
      excludeId: connection.id,
      email: connection.externalAccountLogin,
    });
    return unknown === 0;
  }
  // Account unknown: revoke only when this person has no other live row
  // for the provider that could be the same account.
  if (!connection.userId) return true;
  const others = await countOtherLiveConnectionsForUser(db, {
    provider: connection.provider,
    userId: connection.userId,
    excludeId: connection.id,
  });
  return others === 0;
}

/** A short code for why a provider revoke failed (never the provider's message). */
export function revokeErrorCode(error: unknown): string {
  if (error instanceof AdapterProviderError) return `provider_http_${error.status}`;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "provider_timeout";
  if (name === "ConnectorCryptoError") return "credentials_unreadable";
  return "provider_revoke_failed";
}

function revokedStatus(origin: "user" | "operator"): "revoked_by_user" | "revoked_by_operator" {
  return origin === "operator" ? "revoked_by_operator" : "revoked_by_user";
}

// --------------------------------------------------------------------------
// Rename / make default
// --------------------------------------------------------------------------

export async function renameOwnConnection(
  deps: Pick<LifecycleDeps, "db">,
  input: {
    organizationId: string;
    userId: string;
    providerConnectionId: string;
    displayName: unknown;
    requestId: string;
  },
): Promise<void> {
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new LifecycleError("payload_invalid", "displayName must be 1-120 characters");
  }
  const connection = await requireOwnConnection(deps.db, input);
  await renameConnection(deps.db, { id: connection.id, displayName });
  await insertAuditEvent(deps.db, {
    organizationId: connection.organizationId,
    actorType: "user",
    actorId: input.userId,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "connector.renamed",
    requestId: input.requestId,
    metadata: { provider: connection.provider },
  });
}

export async function makeOwnConnectionDefault(
  deps: Pick<LifecycleDeps, "db">,
  input: { organizationId: string; userId: string; providerConnectionId: string; requestId: string },
): Promise<void> {
  const connection = await requireOwnConnection(deps.db, input);
  if (!isReconnectableConnectionStatus(connection.status)) {
    throw new LifecycleError("payload_invalid", "Only a live connection can be the default");
  }
  await setDefaultConnection(deps.db, {
    id: connection.id,
    organizationId: connection.organizationId,
    userId: input.userId,
    provider: connection.provider,
  });
  await insertAuditEvent(deps.db, {
    organizationId: connection.organizationId,
    actorType: "user",
    actorId: input.userId,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "connector.default_set",
    requestId: input.requestId,
    metadata: { provider: connection.provider },
  });
}

/** A personal connection of `userId` in the organization; GitHub installations never qualify. */
export async function requireOwnConnection(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string; providerConnectionId: string },
): Promise<ProviderConnectionRecord> {
  const connection = await findProviderConnectionById(db, input.providerConnectionId, input.organizationId);
  if (
    !connection ||
    connection.userId !== input.userId ||
    connection.provider === "github" ||
    connection.scopeKind === "organization"
  ) {
    throw new LifecycleError("connector_unavailable", "Connection not found");
  }
  return connection;
}

/**
 * A connection the actor manages from the Console: their own personal
 * connection, or an organization account they manage or, as an
 * organization owner or admin, any organization account. Anything else
 * answers like an unknown id.
 */
export async function requireManagedConnection(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string; providerConnectionId: string },
): Promise<{ connection: ProviderConnectionRecord; as: "owner" | "manager" | "admin" }> {
  const connection = await findProviderConnectionById(db, input.providerConnectionId, input.organizationId);
  if (!connection || connection.provider === "github") {
    throw new LifecycleError("connector_unavailable", "Connection not found");
  }
  if (connection.scopeKind !== "organization") {
    if (connection.userId !== input.userId) throw new LifecycleError("connector_unavailable", "Connection not found");
    return { connection, as: "owner" };
  }
  if (connection.managedByUserId === input.userId && (await isActiveOrganizationMember(db, input))) {
    return { connection, as: "manager" };
  }
  if (await isActiveOrganizationAdmin(db, input)) return { connection, as: "admin" };
  throw new LifecycleError("connector_unavailable", "Connection not found");
}
