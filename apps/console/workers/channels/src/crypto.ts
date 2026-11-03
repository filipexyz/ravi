const AES_GCM = "AES-GCM";
const AES_KW = "AES-KW";
const DEK_BITS = 256;
const NONCE_BYTES = 12;

export interface ChannelEncryptionAad {
  organizationId: string;
  channelInstanceId: string;
  credentialKind: "omni_instance_api_key";
  dekKeyVersion: number;
  payloadKeyVersion: number;
  schemaVersion: number;
}

export interface ChannelDek {
  key: CryptoKey;
  wrappedDekBase64: string;
}

export class ChannelCryptoError extends Error {
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
    this.name = "ChannelCryptoError";
  }
}

export async function importRootWrapKey(base64: string): Promise<CryptoKey> {
  let raw: ArrayBuffer;
  try {
    raw = base64ToBuffer(base64);
  } catch (error) {
    throw new ChannelCryptoError("import_failed", "Invalid root wrap key encoding.", { cause: error });
  }
  if (raw.byteLength !== 32) {
    throw new ChannelCryptoError("import_failed", `Root wrap key must be 32 bytes (got ${raw.byteLength}).`);
  }
  try {
    return await crypto.subtle.importKey("raw", raw, { name: AES_KW }, false, ["wrapKey", "unwrapKey"]);
  } catch (error) {
    throw new ChannelCryptoError("import_failed", "Failed to import root wrap key.", { cause: error });
  }
}

export async function createDek(rootWrapKey: CryptoKey): Promise<ChannelDek> {
  const dek = await crypto.subtle.generateKey({ name: AES_GCM, length: DEK_BITS }, true, ["encrypt", "decrypt"]);
  let wrapped: ArrayBuffer;
  try {
    wrapped = await crypto.subtle.wrapKey("raw", dek, rootWrapKey, AES_KW);
  } catch (error) {
    throw new ChannelCryptoError("wrap_failed", "Failed to wrap DEK.", { cause: error });
  }
  return { key: dek, wrappedDekBase64: bufferToBase64(wrapped) };
}

export async function encryptPayload(input: {
  plaintext: string;
  aad: ChannelEncryptionAad;
  dek: CryptoKey;
}): Promise<{ ciphertextBase64: string; nonceBase64: string; aadHash: string }> {
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
    throw new ChannelCryptoError("wrap_failed", "Failed to encrypt payload.", { cause: error });
  }
  return {
    ciphertextBase64: bufferToBase64(ciphertext),
    nonceBase64: bufferToBase64(nonce.buffer),
    aadHash: await sha256Base64(aadBytes),
  };
}

export async function decryptPayload(input: {
  ciphertextBase64: string;
  nonceBase64: string;
  aadHash: string;
  wrappedDekBase64: string;
  aad: ChannelEncryptionAad;
  rootWrapKey: CryptoKey;
}): Promise<string> {
  const aadBytes = serializeAad(input.aad);
  const expectedHash = await sha256Base64(aadBytes);
  if (!timingSafeEqualString(expectedHash, input.aadHash)) {
    throw new ChannelCryptoError("aad_mismatch", "AAD hash does not match stored ciphertext binding.");
  }
  const dek = await unwrapDek(input.wrappedDekBase64, input.rootWrapKey);
  let nonce: ArrayBuffer;
  let ciphertext: ArrayBuffer;
  try {
    nonce = base64ToBuffer(input.nonceBase64);
    ciphertext = base64ToBuffer(input.ciphertextBase64);
  } catch (error) {
    throw new ChannelCryptoError("decrypt_failed", "Stored ciphertext has invalid encoding.", { cause: error });
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: AES_GCM, iv: new Uint8Array(nonce), additionalData: aadBytes as BufferSource },
      dek,
      ciphertext,
    );
  } catch (error) {
    throw new ChannelCryptoError("decrypt_failed", "Failed to decrypt payload.", { cause: error });
  }
  return new TextDecoder().decode(plaintext);
}

async function unwrapDek(wrappedDekBase64: string, rootWrapKey: CryptoKey): Promise<CryptoKey> {
  let wrapped: ArrayBuffer;
  try {
    wrapped = base64ToBuffer(wrappedDekBase64);
  } catch (error) {
    throw new ChannelCryptoError("unwrap_failed", "Wrapped DEK has invalid encoding.", { cause: error });
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
    throw new ChannelCryptoError("unwrap_failed", "Failed to unwrap DEK.", { cause: error });
  }
}

function serializeAad(aad: ChannelEncryptionAad): Uint8Array {
  return new TextEncoder().encode([
    `org:${aad.organizationId}`,
    `instance:${aad.channelInstanceId}`,
    `kind:${aad.credentialKind}`,
    `dek_v:${aad.dekKeyVersion}`,
    `payload_v:${aad.payloadKeyVersion}`,
    `schema_v:${aad.schemaVersion}`,
  ].join("\n"));
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  return bufferToBase64(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

function base64ToBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
