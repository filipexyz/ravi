/**
 * Connector vault cryptography.
 *
 * Envelope encryption for `connector_credentials` rows:
 *   - A fresh 256-bit Data Encryption Key (DEK) is generated per
 *     provider_connection_id and reused across that connection's payload
 *     kinds (access_token, refresh_token, id_token).
 *   - Each payload is encrypted with AES-256-GCM using a 96-bit random
 *     nonce per encryption operation.
 *   - The AAD binds the ciphertext to its scope so it cannot be replayed
 *     under a different connection/user/payload kind/key version.
 *   - The DEK is wrapped with AES-KW using the connector root wrap key
 *     held by Cloudflare Secrets Store and bound only to this Worker.
 *
 * Plaintext provider tokens MUST NOT leave the single async function that
 * decrypted them. This module never logs plaintext.
 */

const AES_GCM = "AES-GCM";
const AES_KW = "AES-KW";
const DEK_BITS = 256;
const NONCE_BYTES = 12;

export interface ConnectorEncryptionAad {
  organizationId: string;
  userId: string | null;
  providerConnectionId: string;
  payloadKind: "access_token" | "refresh_token" | "id_token";
  dekKeyVersion: number;
  payloadKeyVersion: number;
  schemaVersion: number;
}

export interface ConnectorCipher {
  ciphertextBase64: string;
  nonceBase64: string;
  aadHash: string;
  wrappedDekBase64: string;
}

export interface ConnectorEncryptInput {
  plaintext: string;
  aad: ConnectorEncryptionAad;
  rootWrapKey: CryptoKey;
}

export interface ConnectorDecryptInput {
  ciphertextBase64: string;
  nonceBase64: string;
  aadHash: string;
  wrappedDekBase64: string;
  aad: ConnectorEncryptionAad;
  rootWrapKey: CryptoKey;
}

export interface ConnectorDek {
  key: CryptoKey;
  wrappedDekBase64: string;
}

export class ConnectorCryptoError extends Error {
  constructor(
    public readonly code:
      | "aad_mismatch"
      | "decrypt_failed"
      | "wrap_failed"
      | "unwrap_failed"
      | "import_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectorCryptoError";
  }
}

/**
 * Import the connector root wrap key from a base64 secret string.
 * The wrap key MUST be a 256-bit AES-KW key.
 */
export async function importRootWrapKey(base64: string): Promise<CryptoKey> {
  let raw: ArrayBuffer;
  try {
    raw = base64ToBuffer(base64);
  } catch (error) {
    throw new ConnectorCryptoError(
      "import_failed",
      "Invalid root wrap key encoding.",
      { cause: error },
    );
  }
  if (raw.byteLength !== 32) {
    throw new ConnectorCryptoError(
      "import_failed",
      `Root wrap key must be 32 bytes (got ${raw.byteLength}).`,
    );
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: AES_KW },
      false,
      ["wrapKey", "unwrapKey"],
    );
  } catch (error) {
    throw new ConnectorCryptoError(
      "import_failed",
      "Failed to import root wrap key.",
      { cause: error },
    );
  }
}

/**
 * Generate a fresh DEK for a connection and return both the live key
 * material AND its wrapped form for persistence.
 */
export async function createDek(rootWrapKey: CryptoKey): Promise<ConnectorDek> {
  const dek = await crypto.subtle.generateKey(
    { name: AES_GCM, length: DEK_BITS },
    true,
    ["encrypt", "decrypt"],
  );
  let wrapped: ArrayBuffer;
  try {
    wrapped = await crypto.subtle.wrapKey("raw", dek, rootWrapKey, AES_KW);
  } catch (error) {
    throw new ConnectorCryptoError("wrap_failed", "Failed to wrap DEK.", {
      cause: error,
    });
  }
  return { key: dek, wrappedDekBase64: bufferToBase64(wrapped) };
}

/**
 * Unwrap a previously wrapped DEK using the root wrap key.
 */
export async function unwrapDek(
  wrappedDekBase64: string,
  rootWrapKey: CryptoKey,
): Promise<CryptoKey> {
  let wrapped: ArrayBuffer;
  try {
    wrapped = base64ToBuffer(wrappedDekBase64);
  } catch (error) {
    throw new ConnectorCryptoError(
      "unwrap_failed",
      "Wrapped DEK has invalid encoding.",
      { cause: error },
    );
  }
  try {
    return await crypto.subtle.unwrapKey(
      "raw",
      wrapped,
      rootWrapKey,
      AES_KW,
      { name: AES_GCM, length: DEK_BITS },
      false,
      ["encrypt", "decrypt"],
    );
  } catch (error) {
    throw new ConnectorCryptoError("unwrap_failed", "Failed to unwrap DEK.", {
      cause: error,
    });
  }
}

/**
 * Encrypt a credential payload with an existing DEK and bind it to the
 * supplied AAD. Returns the persistable cipher tuple plus the AAD hash so
 * tamper detection works without re-deriving the AAD on decrypt.
 */
export async function encryptPayload(
  input: { plaintext: string; aad: ConnectorEncryptionAad; dek: CryptoKey },
): Promise<{ ciphertextBase64: string; nonceBase64: string; aadHash: string }> {
  const aadBytes = serializeAad(input.aad);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(
      { name: AES_GCM, iv: nonce, additionalData: aadBytes as BufferSource },
      input.dek,
      new TextEncoder().encode(input.plaintext) as BufferSource,
    );
  } catch (error) {
    throw new ConnectorCryptoError("wrap_failed", "Failed to encrypt payload.", {
      cause: error,
    });
  }
  return {
    ciphertextBase64: bufferToBase64(ciphertext),
    nonceBase64: bufferToBase64(nonce.buffer),
    aadHash: await sha256Base64(aadBytes),
  };
}

/**
 * Decrypt a credential payload. AAD MUST be reconstructed from the
 * connection/user/payload metadata; mismatch raises `aad_mismatch` and
 * MUST be treated as tamper detection by the caller.
 */
export async function decryptPayload(input: ConnectorDecryptInput): Promise<string> {
  const aadBytes = serializeAad(input.aad);
  const expectedHash = await sha256Base64(aadBytes);
  if (!timingSafeEqualString(expectedHash, input.aadHash)) {
    throw new ConnectorCryptoError(
      "aad_mismatch",
      "AAD hash does not match stored ciphertext binding.",
    );
  }
  const dek = await unwrapDek(input.wrappedDekBase64, input.rootWrapKey);
  let nonce: ArrayBuffer;
  let ciphertext: ArrayBuffer;
  try {
    nonce = base64ToBuffer(input.nonceBase64);
    ciphertext = base64ToBuffer(input.ciphertextBase64);
  } catch (error) {
    throw new ConnectorCryptoError(
      "decrypt_failed",
      "Stored ciphertext has invalid encoding.",
      { cause: error },
    );
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: AES_GCM, iv: new Uint8Array(nonce), additionalData: aadBytes as BufferSource },
      dek,
      ciphertext,
    );
  } catch (error) {
    throw new ConnectorCryptoError(
      "decrypt_failed",
      "Failed to decrypt payload (AES-GCM tag failed).",
      { cause: error },
    );
  }
  return new TextDecoder().decode(plaintext);
}

// Key rotation: rotation across root wrap keys cannot be a simple rewrap
// because the DEK is intentionally non-extractable. Real rotation is
// payload-level: decrypt → generate new DEK → re-encrypt → persist. That
// flow lives outside this module so the in-memory DEK never reaches a
// caller that doesn't already hold the payload.

function serializeAad(aad: ConnectorEncryptionAad): Uint8Array {
  // Canonical, sorted, line-delimited form so the same AAD always serializes
  // identically. The hash of this byte sequence is what gets persisted.
  const canonical = [
    `org:${aad.organizationId}`,
    `user:${aad.userId ?? ""}`,
    `conn:${aad.providerConnectionId}`,
    `kind:${aad.payloadKind}`,
    `dek_v:${aad.dekKeyVersion}`,
    `payload_v:${aad.payloadKeyVersion}`,
    `schema_v:${aad.schemaVersion}`,
  ].join("\n");
  return new TextEncoder().encode(canonical);
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return bufferToBase64(digest);
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
