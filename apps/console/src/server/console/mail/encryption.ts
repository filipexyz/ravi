export const MAIL_CIPHER_SCHEMA_VERSION = 1;
export const MAIL_CIPHER_ALGORITHM = "AES-256-GCM";
export const MAIL_CIPHER_NONCE_BYTES = 12;
export const MAIL_CIPHER_TAG_BYTES = 16;
export const MAIL_CONTENT_KEY_BYTES = 32;

export type MailPayloadKind =
  | "subject"
  | "raw_mime"
  | "parsed_body"
  | "headers"
  | "attachment_object"
  | "attachment_filename";

export type MailCipherResourceType = "message" | "attachment";

export type MailCipherKeyScope = {
  organizationId: string;
  projectId: string | null;
  mailboxId: string;
  resourceType: MailCipherResourceType;
  resourceId: string;
  payloadKind: MailPayloadKind;
};

export type MailCipherScopeInput = Omit<MailCipherKeyScope, "projectId"> & {
  projectId?: string | null;
};

export type MailCipherRef = {
  schemaVersion: typeof MAIL_CIPHER_SCHEMA_VERSION;
  algorithm: typeof MAIL_CIPHER_ALGORITHM;
  nonce: string;
  tag: string;
  wrappedKeyRef: string;
  aadHash: string;
  keyVersion: number;
  keyScope: MailCipherKeyScope;
  createdAt: string;
  ciphertextRef?: string;
};

export type EncryptedMailPayload = {
  cipherRef: MailCipherRef;
  ciphertext: string;
};

export type MailCipherAadFields = {
  schemaVersion: typeof MAIL_CIPHER_SCHEMA_VERSION;
  algorithm: typeof MAIL_CIPHER_ALGORITHM;
  organizationId: string;
  projectId: string | null;
  mailboxId: string;
  resourceType: MailCipherResourceType;
  resourceId: string;
  payloadKind: MailPayloadKind;
  keyVersion: number;
};

export type MailAesGcmKey = CryptoKey | Uint8Array | ArrayBuffer;

export type EncryptMailPayloadInput = {
  plaintext: string | Uint8Array | ArrayBuffer;
  key: MailAesGcmKey;
  scope: MailCipherScopeInput;
  keyVersion: number;
  wrappedKeyRef: string;
  createdAt?: Date | string;
  ciphertextRef?: string;
};

export type DecryptMailPayloadInput = {
  payload: EncryptedMailPayload;
  key: MailAesGcmKey;
  scope: MailCipherScopeInput;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const MESSAGE_PAYLOAD_KINDS = new Set<MailPayloadKind>(["subject", "raw_mime", "parsed_body", "headers"]);
const ATTACHMENT_PAYLOAD_KINDS = new Set<MailPayloadKind>(["attachment_object", "attachment_filename"]);

export class MailEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailEncryptionError";
  }
}

export class MailDecryptionError extends Error {
  constructor(message = "Unable to decrypt mail payload.") {
    super(message);
    this.name = "MailDecryptionError";
  }
}

export function generateMailContentEncryptionKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(MAIL_CONTENT_KEY_BYTES));
}

export function generateMailCipherNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(MAIL_CIPHER_NONCE_BYTES));
}

export function normalizeMailCipherScope(scope: MailCipherScopeInput): MailCipherKeyScope {
  const normalized = {
    ...scope,
    projectId: scope.projectId ?? null,
  };

  assertValidMailCipherScope(normalized);
  return normalized;
}

export function buildMailCipherAadFields({
  keyVersion,
  scope,
}: {
  keyVersion: number;
  scope: MailCipherScopeInput;
}): MailCipherAadFields {
  assertValidKeyVersion(keyVersion);
  const keyScope = normalizeMailCipherScope(scope);

  return {
    schemaVersion: MAIL_CIPHER_SCHEMA_VERSION,
    algorithm: MAIL_CIPHER_ALGORITHM,
    organizationId: keyScope.organizationId,
    projectId: keyScope.projectId,
    mailboxId: keyScope.mailboxId,
    resourceType: keyScope.resourceType,
    resourceId: keyScope.resourceId,
    payloadKind: keyScope.payloadKind,
    keyVersion,
  };
}

export function buildMailCipherAad(input: { keyVersion: number; scope: MailCipherScopeInput }): Uint8Array {
  return textEncoder.encode(JSON.stringify(buildMailCipherAadFields(input)));
}

export async function buildMailCipherAadHash(input: { keyVersion: number; scope: MailCipherScopeInput }) {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(buildMailCipherAad(input)));
  return `sha256:${encodeBase64Url(new Uint8Array(digest))}`;
}

export async function encryptMailPayload(input: EncryptMailPayloadInput): Promise<EncryptedMailPayload> {
  const scope = normalizeMailCipherScope(input.scope);
  assertValidKeyVersion(input.keyVersion);
  assertNonEmptyString(input.wrappedKeyRef, "wrappedKeyRef");

  const key = await importMailAesGcmKey(input.key, ["encrypt"]);
  const nonce = generateMailCipherNonce();
  const aad = buildMailCipherAad({ keyVersion: input.keyVersion, scope });
  const plaintext = toUint8Array(input.plaintext);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(aad),
        tagLength: 128,
      },
      key,
      toArrayBuffer(plaintext),
    ),
  );

  const ciphertext = sealed.slice(0, sealed.length - MAIL_CIPHER_TAG_BYTES);
  const tag = sealed.slice(sealed.length - MAIL_CIPHER_TAG_BYTES);
  const aadHash = await digestAadHash(aad);

  return {
    cipherRef: {
      schemaVersion: MAIL_CIPHER_SCHEMA_VERSION,
      algorithm: MAIL_CIPHER_ALGORITHM,
      nonce: encodeBase64Url(nonce),
      tag: encodeBase64Url(tag),
      wrappedKeyRef: input.wrappedKeyRef,
      aadHash,
      keyVersion: input.keyVersion,
      keyScope: scope,
      createdAt: normalizeCreatedAt(input.createdAt),
      ...(input.ciphertextRef ? { ciphertextRef: input.ciphertextRef } : {}),
    },
    ciphertext: encodeBase64Url(ciphertext),
  };
}

export async function decryptMailPayload(input: DecryptMailPayloadInput): Promise<Uint8Array> {
  const scope = normalizeMailCipherScope(input.scope);
  const { cipherRef } = input.payload;

  try {
    assertValidMailCipherRef(cipherRef);
    assertSameMailCipherScope(cipherRef.keyScope, scope);

    const aad = buildMailCipherAad({ keyVersion: cipherRef.keyVersion, scope });
    const aadHash = await digestAadHash(aad);
    if (cipherRef.aadHash !== aadHash) {
      throw new MailDecryptionError();
    }

    const nonce = decodeBase64Url(cipherRef.nonce);
    const tag = decodeBase64Url(cipherRef.tag);
    const ciphertext = decodeBase64Url(input.payload.ciphertext, { allowEmpty: true });
    const sealed = concatUint8Arrays(ciphertext, tag);
    const key = await importMailAesGcmKey(input.key, ["decrypt"]);

    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(nonce),
          additionalData: toArrayBuffer(aad),
          tagLength: 128,
        },
        key,
        toArrayBuffer(sealed),
      ),
    );
  } catch (error) {
    if (error instanceof MailDecryptionError) throw error;
    throw new MailDecryptionError();
  }
}

export async function decryptMailPayloadToString(input: DecryptMailPayloadInput): Promise<string> {
  return textDecoder.decode(await decryptMailPayload(input));
}

export function assertEncryptedMailPayload(value: unknown): asserts value is EncryptedMailPayload {
  if (!isPlainObject(value)) {
    throw new MailEncryptionError("Encrypted mail payload must be an object.");
  }

  if ("plaintext" in value || "cleartext" in value) {
    throw new MailEncryptionError("Encrypted mail payload must not include plaintext fields.");
  }

  const payload = value as Partial<EncryptedMailPayload>;
  if (typeof payload.ciphertext !== "string") {
    throw new MailEncryptionError("Encrypted mail payload must include ciphertext.");
  }

  assertValidMailCipherRef(payload.cipherRef);
}

export function assertValidMailCipherRef(value: unknown): asserts value is MailCipherRef {
  if (!isPlainObject(value)) {
    throw new MailEncryptionError("Mail cipher ref must be an object.");
  }

  const ref = value as Partial<MailCipherRef>;
  if (ref.schemaVersion !== MAIL_CIPHER_SCHEMA_VERSION) {
    throw new MailEncryptionError("Unsupported mail cipher schema version.");
  }

  if (ref.algorithm !== MAIL_CIPHER_ALGORITHM) {
    throw new MailEncryptionError("Unsupported mail cipher algorithm.");
  }

  assertBase64UrlString(ref.nonce, "nonce");
  assertBase64UrlString(ref.tag, "tag");
  assertNonEmptyString(ref.wrappedKeyRef, "wrappedKeyRef");
  assertNonEmptyString(ref.aadHash, "aadHash");
  assertValidKeyVersion(ref.keyVersion);
  assertNonEmptyString(ref.createdAt, "createdAt");
  assertValidMailCipherScope(ref.keyScope);

  if (ref.ciphertextRef !== undefined) {
    assertNonEmptyString(ref.ciphertextRef, "ciphertextRef");
  }
}

function assertValidMailCipherScope(value: unknown): asserts value is MailCipherKeyScope {
  if (!isPlainObject(value)) {
    throw new MailEncryptionError("Mail cipher key scope must be an object.");
  }

  const scope = value as Partial<MailCipherKeyScope>;
  assertNonEmptyString(scope.organizationId, "organizationId");
  if (scope.projectId !== null) {
    assertNonEmptyString(scope.projectId, "projectId");
  }
  assertNonEmptyString(scope.mailboxId, "mailboxId");
  assertNonEmptyString(scope.resourceId, "resourceId");

  if (scope.resourceType !== "message" && scope.resourceType !== "attachment") {
    throw new MailEncryptionError("Mail cipher scope resource type is invalid.");
  }

  if (!isMailPayloadKind(scope.payloadKind)) {
    throw new MailEncryptionError("Mail cipher scope payload kind is invalid.");
  }

  if (scope.resourceType === "message" && !MESSAGE_PAYLOAD_KINDS.has(scope.payloadKind)) {
    throw new MailEncryptionError("Mail message cipher scope cannot use attachment payload kind.");
  }

  if (scope.resourceType === "attachment" && !ATTACHMENT_PAYLOAD_KINDS.has(scope.payloadKind)) {
    throw new MailEncryptionError("Mail attachment cipher scope cannot use message payload kind.");
  }
}

function assertSameMailCipherScope(actual: MailCipherKeyScope, expected: MailCipherKeyScope) {
  if (
    actual.organizationId !== expected.organizationId ||
    actual.projectId !== expected.projectId ||
    actual.mailboxId !== expected.mailboxId ||
    actual.resourceType !== expected.resourceType ||
    actual.resourceId !== expected.resourceId ||
    actual.payloadKind !== expected.payloadKind
  ) {
    throw new MailDecryptionError();
  }
}

function assertValidKeyVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) {
    throw new MailEncryptionError("Mail key version must be a positive integer.");
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MailEncryptionError(`Mail cipher ${field} must be a non-empty string.`);
  }
}

function assertBase64UrlString(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (!BASE64URL_PATTERN.test(value)) {
    throw new MailEncryptionError(`Mail cipher ${field} must be base64url encoded.`);
  }
}

function isMailPayloadKind(value: unknown): value is MailPayloadKind {
  return (
    value === "subject" ||
    value === "raw_mime" ||
    value === "parsed_body" ||
    value === "headers" ||
    value === "attachment_object" ||
    value === "attachment_filename"
  );
}

async function importMailAesGcmKey(key: MailAesGcmKey, keyUsages: KeyUsage[]): Promise<CryptoKey> {
  if (isCryptoKey(key)) return key;

  const keyBytes = toUint8Array(key);
  if (keyBytes.byteLength !== MAIL_CONTENT_KEY_BYTES) {
    throw new MailEncryptionError("AES-256-GCM mail content keys must be 32 bytes.");
  }

  return crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), { name: "AES-GCM", length: 256 }, false, keyUsages);
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return isPlainObject(value) && "algorithm" in value && "extractable" in value && "type" in value && "usages" in value;
}

function toUint8Array(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === "string") return textEncoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new MailEncryptionError("Mail payload bytes must be a string, Uint8Array, or ArrayBuffer.");
}

async function digestAadHash(aad: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(aad));
  return `sha256:${encodeBase64Url(new Uint8Array(digest))}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function normalizeCreatedAt(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string, options: { allowEmpty?: boolean } = {}): Uint8Array {
  if (options.allowEmpty && value === "") return new Uint8Array(0);
  assertBase64UrlString(value, "base64url value");
  if (value.length % 4 === 1) {
    throw new MailEncryptionError("Mail cipher base64url value has invalid length.");
  }

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function concatUint8Arrays(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
