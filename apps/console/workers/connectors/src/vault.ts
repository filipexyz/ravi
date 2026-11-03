/**
 * Vault helpers shared by the connect flow, lifecycle and backfill code.
 *
 * Two shapes of ciphertext live in Postgres:
 *   - `connector_credentials` rows (one column per cipher part), bound to
 *     the connection by AAD;
 *   - single-column bundles `wrappedDek.nonce.aadHash.ciphertext` for the
 *     short-lived secrets of a pending grant (PKCE verifier, authorization
 *     code) and approval previews, bound to their row by AAD.
 *
 * Plaintext never leaves the calling function and is never logged.
 */

import type { ProviderTokenBundle } from "./adapters/adapter";
import {
  createDek,
  decryptPayload,
  encryptPayload,
  type ConnectorEncryptionAad,
} from "./crypto";
import {
  upsertCredential,
  type ConnectorCredentialRecord,
  type ConnectorsDb,
} from "./db";

export const CREDENTIAL_SCHEMA_VERSION = 1;

export async function encryptBundle(input: {
  plaintext: string;
  aad: ConnectorEncryptionAad;
  rootWrapKey: CryptoKey;
}): Promise<string> {
  const dek = await createDek(input.rootWrapKey);
  const enc = await encryptPayload({ plaintext: input.plaintext, aad: input.aad, dek: dek.key });
  return `${dek.wrappedDekBase64}.${enc.nonceBase64}.${enc.aadHash}.${enc.ciphertextBase64}`;
}

export async function decryptBundle(input: {
  bundle: string;
  aad: ConnectorEncryptionAad;
  rootWrapKey: CryptoKey;
}): Promise<string> {
  const [wrappedDek, nonce, aadHash, ciphertext] = input.bundle.split(".");
  if (!wrappedDek || !nonce || !aadHash || !ciphertext) {
    throw new Error("Encrypted bundle malformed.");
  }
  return decryptPayload({
    ciphertextBase64: ciphertext,
    nonceBase64: nonce,
    aadHash,
    wrappedDekBase64: wrappedDek,
    aad: input.aad,
    rootWrapKey: input.rootWrapKey,
  });
}

/**
 * AAD of a single-column secret bundle: a pending grant secret
 * (`pending:<stateHash>`, `pending-code:<pendingId>`) or an approval
 * preview (`approval:<approvalId>`).
 */
export function pendingSecretAad(input: {
  organizationId: string;
  userId: string;
  binding: string;
  dekKeyVersion: number;
}): ConnectorEncryptionAad {
  return {
    organizationId: input.organizationId,
    userId: input.userId,
    providerConnectionId: input.binding,
    payloadKind: "access_token",
    dekKeyVersion: input.dekKeyVersion,
    payloadKeyVersion: 1,
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
  };
}

export async function decryptStoredCredential(
  rootWrapKey: CryptoKey,
  connection: { id: string; organizationId: string; userId: string | null },
  row: Pick<
    ConnectorCredentialRecord,
    "ciphertext" | "nonce" | "aadHash" | "wrappedDek" | "payloadKind" | "dekKeyVersion" | "payloadKeyVersion"
  >,
): Promise<string> {
  return decryptPayload({
    ciphertextBase64: row.ciphertext,
    nonceBase64: row.nonce,
    aadHash: row.aadHash,
    wrappedDekBase64: row.wrappedDek,
    aad: {
      organizationId: connection.organizationId,
      userId: connection.userId,
      providerConnectionId: connection.id,
      payloadKind: row.payloadKind,
      dekKeyVersion: row.dekKeyVersion,
      payloadKeyVersion: row.payloadKeyVersion,
      schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    },
    rootWrapKey,
  });
}

/**
 * Encrypt a fresh token bundle under a new DEK and store it on the
 * connection. Each payload kind's key version moves one past what the row
 * held before (1 for a new kind). A refresh token Google did not return
 * again is left as stored: its row keeps its own wrapped DEK.
 */
export async function storeConnectionTokens(
  db: ConnectorsDb,
  input: {
    rootWrapKey: CryptoKey;
    dekKeyVersion: number;
    connection: { id: string; organizationId: string; userId: string | null };
    tokens: ProviderTokenBundle;
    existing: ConnectorCredentialRecord[];
  },
): Promise<void> {
  const dek = await createDek(input.rootWrapKey);
  const expiresAt = input.tokens.expiresInSeconds
    ? new Date(Date.now() + input.tokens.expiresInSeconds * 1000)
    : null;
  const hasRefresh =
    Boolean(input.tokens.refreshToken) || input.existing.some((row) => row.payloadKind === "refresh_token");

  const payloads: {
    kind: "access_token" | "refresh_token" | "id_token";
    plaintext: string | undefined;
    expiresAt: Date | null;
    refreshSupported: boolean;
  }[] = [
    { kind: "access_token", plaintext: input.tokens.accessToken, expiresAt, refreshSupported: hasRefresh },
    { kind: "refresh_token", plaintext: input.tokens.refreshToken, expiresAt: null, refreshSupported: true },
    { kind: "id_token", plaintext: input.tokens.idToken, expiresAt, refreshSupported: false },
  ];

  for (const payload of payloads) {
    if (!payload.plaintext) continue;
    const previous = input.existing.find((row) => row.payloadKind === payload.kind);
    const payloadKeyVersion = previous ? previous.payloadKeyVersion + 1 : 1;
    const aad: ConnectorEncryptionAad = {
      organizationId: input.connection.organizationId,
      userId: input.connection.userId,
      providerConnectionId: input.connection.id,
      payloadKind: payload.kind,
      dekKeyVersion: input.dekKeyVersion,
      payloadKeyVersion,
      schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    };
    const enc = await encryptPayload({ plaintext: payload.plaintext, aad, dek: dek.key });
    await upsertCredential(db, {
      providerConnectionId: input.connection.id,
      organizationId: input.connection.organizationId,
      userId: input.connection.userId,
      payloadKind: payload.kind,
      ciphertext: enc.ciphertextBase64,
      nonce: enc.nonceBase64,
      aadHash: enc.aadHash,
      wrappedDek: dek.wrappedDekBase64,
      dekKeyVersion: input.dekKeyVersion,
      payloadKeyVersion,
      expiresAt: payload.expiresAt,
      refreshSupported: payload.refreshSupported,
    });
  }
}
