/**
 * Who a connection is: the Google `sub` and account email on the row.
 *
 * `external_account_id` holds the sub unless the per-person unique index
 * forbids it (the same person already has a live row for that account);
 * such a duplicate keeps it NULL and records `metadata_json.googleSub` +
 * `metadata_json.duplicateOf`. `metadata_json.googleSub` always carries
 * the sub. `external_account_login` holds the email. Organization accounts
 * follow the same rule per organization (their own unique index).
 *
 * Legacy rows created before identity capture are backfilled from the
 * id_token stored in the vault (lazily on list, and by the scheduled
 * handler).
 */

import type { AccountIdentity } from "./identity";
import { decodeIdTokenClaims } from "./identity";
import {
  findCredentialsByConnection,
  findLiveConnectionHoldingAccount,
  findLiveOrgConnectionHoldingAccount,
  isUniqueViolation,
  listUserConnectionsMissingAccount,
  markIdentityBackfillUnavailable,
  setConnectionIdentity,
  type ConnectorsDb,
  type ProviderConnectionRecord,
} from "./db";

/** Rows of one person backfilled before a revoke or connect decides who holds an account. */
const USER_BACKFILL_LIMIT = 10;
import { decryptStoredCredential } from "./vault";

export async function applyAccountIdentity(
  db: ConnectorsDb,
  connection: ProviderConnectionRecord,
  identity: AccountIdentity,
  options: { takeExternalAccountId?: boolean } = {},
): Promise<void> {
  const takeExternalAccountId = options.takeExternalAccountId ?? true;
  const patch: Record<string, unknown> = {};
  let externalAccountId: string | null = null;
  const sub = identity.sub;
  // A row already bound to another account id keeps it untouched.
  if (sub && (!connection.externalAccountId || connection.externalAccountId === sub)) {
    if (connection.provider === "google") patch.googleSub = sub;
    if (!connection.externalAccountId) {
      const holder = connection.scopeKind === "organization"
        ? await findLiveOrgConnectionHoldingAccount(db, {
            organizationId: connection.organizationId,
            provider: connection.provider,
            sub,
            excludeId: connection.id,
          })
        : connection.userId
          ? await findLiveConnectionHoldingAccount(db, {
              organizationId: connection.organizationId,
              userId: connection.userId,
              provider: connection.provider,
              sub,
              excludeId: connection.id,
            })
          : null;
      if (holder) patch.duplicateOf = holder.id;
      else if (takeExternalAccountId) externalAccountId = sub;
    }
  }
  if (!externalAccountId && !identity.email && Object.keys(patch).length === 0) return;
  await setConnectionIdentity(db, {
    id: connection.id,
    externalAccountId,
    email: identity.email,
    metadataPatch: patch,
  });
}

/**
 * Read the identity of a legacy row from its stored id_token and record
 * it. Rows with no readable id_token are marked so they are not retried.
 * Returns the identity found, or `null`.
 */
export async function backfillConnectionIdentity(
  deps: { db: ConnectorsDb; rootWrapKey: CryptoKey },
  connection: ProviderConnectionRecord,
): Promise<AccountIdentity | null> {
  const credentials = await findCredentialsByConnection(deps.db, connection.id);
  const idRow = credentials.find((row) => row.payloadKind === "id_token");
  let identity: AccountIdentity | null = null;
  if (idRow) {
    try {
      identity = decodeIdTokenClaims(await decryptStoredCredential(deps.rootWrapKey, connection, idRow));
    } catch {
      identity = null;
    }
  }
  if (!identity) {
    await markIdentityBackfillUnavailable(deps.db, connection.id);
    return null;
  }
  try {
    await applyAccountIdentity(deps.db, connection, identity);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another row took the account between the check and the write.
    await applyAccountIdentity(deps.db, connection, identity, { takeExternalAccountId: false });
  }
  return identity;
}

/**
 * Backfill the identity of a person's live rows for `provider` (any
 * organization) that do not know their account yet, so a revoke or a
 * connect sees every row that may hold the same account. Best effort:
 * a row that fails stays unknown, which callers treat as a possible match.
 */
export async function backfillUserAccountIdentities(
  deps: { db: ConnectorsDb; rootWrapKey: CryptoKey },
  input: { provider: string; userId: string; excludeId?: string | null },
): Promise<void> {
  if (input.provider !== "google") return;
  const rows = await listUserConnectionsMissingAccount(deps.db, {
    provider: input.provider,
    userId: input.userId,
    excludeId: input.excludeId ?? null,
    limit: USER_BACKFILL_LIMIT,
  });
  for (const row of rows) {
    try {
      await backfillConnectionIdentity(deps, row);
    } catch (error) {
      console.error("ravi-connectors identity backfill failed", {
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

export function needsIdentityBackfill(connection: ProviderConnectionRecord): boolean {
  return (
    connection.provider === "google" &&
    !connection.externalAccountLogin &&
    ["active", "degraded", "suspended", "revoke_pending"].includes(connection.status) &&
    connection.metadataJson?.identityBackfill !== "unavailable"
  );
}
