export type MailEncryptionAad = {
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  messageId: string;
  routeId?: string | null;
  attachmentId?: string | null;
  payloadKind:
    | "raw_mime"
    | "subject"
    | "headers"
    | "parsed_body"
    | "address_summary"
    | "attachment_filename"
    | "attachment_object";
  keyVersionPurpose: "mail_message";
};

export type EncryptedMailPayload = {
  ciphertext: ArrayBuffer | ArrayBufferView | string | ReadableStream;
  cipherRef: MailCipherRef;
  keyVersion: string;
  sha256: string;
  sizeBytes: number;
};

export type MailCipherRef = {
  schemaVersion: 1;
  algorithm: "AES-256-GCM";
  ciphertextRef: string;
  nonce: string;
  wrappedKey: {
    algorithm: "AES-256-GCM";
    keyVersion: string;
    nonce: string;
    ciphertext: string;
  };
  wrappedKeyRef: string;
  aadHash: string;
  keyVersion: number;
  keyVersionLabel: string;
  keyScope: MailEncryptionAad;
  ciphertextSha256: string;
  createdAt: string;
};

export type MailCryptoEnv = {
  RAVI_MAIL_ROOT_KEY_BASE64?: string;
  RAVI_MAIL_KEY_VERSION?: string;
};

const AES_GCM = "AES-GCM";
const AES_256_BITS = 256;
const NONCE_BYTES = 12;
const DEFAULT_KEY_VERSION = "local-v1";

export async function encryptRawMime(input: {
  plaintext: ArrayBuffer;
  aad: MailEncryptionAad;
  env: MailCryptoEnv;
  ciphertextRef?: string;
  now?: () => Date;
}): Promise<EncryptedMailPayload> {
  return encryptMailWorkerPayload(input);
}

export async function encryptMailWorkerPayload(input: {
  plaintext: ArrayBuffer;
  aad: MailEncryptionAad;
  env: MailCryptoEnv;
  ciphertextRef?: string;
  now?: () => Date;
}): Promise<EncryptedMailPayload> {
  const rootKeyBytes = parseRootKey(input.env.RAVI_MAIL_ROOT_KEY_BASE64);
  const keyVersionLabel = input.env.RAVI_MAIL_KEY_VERSION ?? DEFAULT_KEY_VERSION;
  const keyVersion = numericKeyVersion(keyVersionLabel);
  const now = input.now ?? (() => new Date());

  const cekBytes = randomBytes(32);
  const payloadNonce = randomBytes(NONCE_BYTES);
  const wrapNonce = randomBytes(NONCE_BYTES);
  const payloadAad = aadBytes(input.aad, keyVersionLabel);
  const wrapAad = wrappedKeyAadBytes(input.aad, keyVersionLabel);

  const cekKey = await importAesGcmKey(cekBytes);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: AES_GCM,
      iv: bytesToArrayBuffer(payloadNonce),
      additionalData: payloadAad,
      tagLength: 128,
    },
    cekKey,
    input.plaintext,
  );

  const rootKey = await importAesGcmKey(rootKeyBytes);
  const wrappedKey = await crypto.subtle.encrypt(
    {
      name: AES_GCM,
      iv: bytesToArrayBuffer(wrapNonce),
      additionalData: wrapAad,
      tagLength: 128,
    },
    rootKey,
    bytesToArrayBuffer(cekBytes),
  );
  zeroBytes(cekBytes);

  const ciphertextSha256 = await sha256Hex(ciphertext);

  return {
    ciphertext,
    cipherRef: {
      schemaVersion: 1,
      algorithm: "AES-256-GCM",
      ciphertextRef: input.ciphertextRef ?? "",
      nonce: base64UrlEncode(payloadNonce),
      wrappedKey: {
        algorithm: "AES-256-GCM",
        keyVersion: keyVersionLabel,
        nonce: base64UrlEncode(wrapNonce),
        ciphertext: base64UrlEncode(new Uint8Array(wrappedKey)),
      },
      wrappedKeyRef: `inline:${keyVersionLabel}`,
      aadHash: await sha256Hex(payloadAad),
      keyVersion,
      keyVersionLabel,
      keyScope: normalizedAad(input.aad),
      ciphertextSha256,
      createdAt: now().toISOString(),
    },
    keyVersion: keyVersionLabel,
    sha256: ciphertextSha256,
    sizeBytes: ciphertext.byteLength,
  };
}

export async function decryptMailWorkerPayload(input: {
  ciphertext: ArrayBuffer;
  cipherRef: MailCipherRef;
  aad: MailEncryptionAad;
  env: MailCryptoEnv;
}): Promise<ArrayBuffer> {
  const rootKeyBytes = parseRootKey(input.env.RAVI_MAIL_ROOT_KEY_BASE64);
  const keyVersion = input.cipherRef.keyVersionLabel ?? input.cipherRef.wrappedKey.keyVersion;
  const rootKey = await importAesGcmKey(rootKeyBytes);
  const cekBytes = await crypto.subtle.decrypt(
    {
      name: AES_GCM,
      iv: bytesToArrayBuffer(base64UrlDecode(input.cipherRef.wrappedKey.nonce)),
      additionalData: wrappedKeyAadBytes(input.aad, keyVersion),
      tagLength: 128,
    },
    rootKey,
    bytesToArrayBuffer(base64UrlDecode(input.cipherRef.wrappedKey.ciphertext)),
  );
  const cekKey = await importAesGcmKey(new Uint8Array(cekBytes));

  return crypto.subtle.decrypt(
    {
      name: AES_GCM,
      iv: bytesToArrayBuffer(base64UrlDecode(input.cipherRef.nonce)),
      additionalData: aadBytes(input.aad, keyVersion),
      tagLength: 128,
    },
    cekKey,
    input.ciphertext,
  );
}

export const decryptRawMimeForTest = decryptMailWorkerPayload;

export function isValidRootKeyBase64(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    parseRootKey(value);
    return true;
  } catch {
    return false;
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function importAesGcmKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytesToArrayBuffer(keyBytes), { name: AES_GCM, length: AES_256_BITS }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function parseRootKey(value: string | undefined): Uint8Array {
  if (!value) {
    throw new Error("mail_root_key_missing");
  }

  const bytes = base64UrlDecode(value);
  if (bytes.byteLength !== 32) {
    throw new Error("mail_root_key_must_be_32_bytes");
  }

  return bytes;
}

function numericKeyVersion(value: string): number {
  const exact = Number(value);
  if (Number.isInteger(exact) && exact > 0) return exact;

  const match = value.match(/(\d+)$/);
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }

  return 1;
}

function normalizedAad(aad: MailEncryptionAad): MailEncryptionAad {
  return {
    organizationId: aad.organizationId,
    projectId: aad.projectId ?? null,
    mailboxId: aad.mailboxId,
    messageId: aad.messageId,
    routeId: aad.routeId ?? null,
    attachmentId: aad.attachmentId ?? null,
    payloadKind: aad.payloadKind,
    keyVersionPurpose: aad.keyVersionPurpose,
  };
}

function aadBytes(aad: MailEncryptionAad, keyVersion: string): ArrayBuffer {
  return bytesToArrayBuffer(new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      organizationId: aad.organizationId,
      projectId: aad.projectId ?? null,
      mailboxId: aad.mailboxId,
      messageId: aad.messageId,
      routeId: aad.routeId ?? null,
      attachmentId: aad.attachmentId ?? null,
      payloadKind: aad.payloadKind,
      keyVersionPurpose: aad.keyVersionPurpose,
      keyVersion,
    }),
  ));
}

function wrappedKeyAadBytes(aad: MailEncryptionAad, keyVersion: string): ArrayBuffer {
  return bytesToArrayBuffer(new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      purpose: "mail_message_cek_wrap",
      organizationId: aad.organizationId,
      projectId: aad.projectId ?? null,
      mailboxId: aad.mailboxId,
      messageId: aad.messageId,
      routeId: aad.routeId ?? null,
      attachmentId: aad.attachmentId ?? null,
      payloadKind: aad.payloadKind,
      keyVersion,
    }),
  ));
}

async function sha256Hex(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function zeroBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
